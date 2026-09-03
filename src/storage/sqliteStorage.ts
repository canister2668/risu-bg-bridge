import { DatabaseSync } from "node:sqlite";
import {
  JobMetadata,
  JobEvent,
  JobResult,
  ToolCallCheckpoint,
  FinalizationStageLedgerEntry,
  AuxConsumerAck,
  JobListFilter
} from "../contract/types.js";
import { BgStorageEngine, PutJobResult } from "./interface.js";
import { CasConflictError, ConflictError } from "../engine/fingerprint.js";

/**
 * Production SQLite storage implementation using Node.js built-in `node:sqlite` (Node 22+).
 * Stores jobs, request envelopes, monotonic events, results, tool checkpoints,
 * finalization stage ledger, and aux consumer ACKs.
 */
export class SqliteBgStorageEngine implements BgStorageEngine {
  private db: DatabaseSync;
  private isMemory: boolean;

  constructor(dbPath: string = ":memory:") {
    this.isMemory = dbPath === ":memory:";
    this.db = new DatabaseSync(dbPath);
    // Performance and integrity pragmas
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  public async init(): Promise<void> {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bg_jobs (
        client_job_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        record_version INTEGER NOT NULL DEFAULT 1,
        chat_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_bg_jobs_principal_client
        ON bg_jobs(principal_id, client_job_id);

      CREATE INDEX IF NOT EXISTS idx_bg_jobs_principal_state
        ON bg_jobs(principal_id, state);

      CREATE INDEX IF NOT EXISTS idx_bg_jobs_chat_gen
        ON bg_jobs(chat_id, generation_id);

      CREATE TABLE IF NOT EXISTS bg_request_envelopes (
        envelope_ref TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bg_event_journal (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_ref TEXT,
        payload_json TEXT,
        PRIMARY KEY (job_id, seq),
        FOREIGN KEY (job_id) REFERENCES bg_jobs(client_job_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bg_results (
        job_id TEXT PRIMARY KEY,
        result_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        usage_json TEXT,
        finish_reason TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES bg_jobs(client_job_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bg_tool_checkpoints (
        job_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        args_json TEXT NOT NULL,
        executor_type TEXT NOT NULL,
        replay_policy TEXT NOT NULL,
        state TEXT NOT NULL,
        result_ref TEXT,
        result_json TEXT,
        idempotency_key TEXT,
        approval_granted INTEGER DEFAULT 0,
        attempt INTEGER DEFAULT 1,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (job_id, tool_call_id),
        FOREIGN KEY (job_id) REFERENCES bg_jobs(client_job_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bg_stage_ledger (
        job_id TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        stage_id TEXT NOT NULL,
        stage_version INTEGER NOT NULL,
        input_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER DEFAULT 1,
        output_hash TEXT,
        output_json TEXT,
        error TEXT,
        completed_at TEXT,
        PRIMARY KEY (job_id, generation_id, stage_id, stage_version),
        FOREIGN KEY (job_id) REFERENCES bg_jobs(client_job_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS bg_aux_acks (
        job_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        consumer_group TEXT,
        result_hash TEXT NOT NULL,
        acked_at TEXT NOT NULL,
        PRIMARY KEY (job_id, consumer_id),
        FOREIGN KEY (job_id) REFERENCES bg_jobs(client_job_id) ON DELETE CASCADE
      );
    `);
  }

  public async close(): Promise<void> {
    this.db.close();
  }

  // --- Helper to parse / serialize JobMetadata ---
  private serializeJob(job: JobMetadata): string {
    return JSON.stringify(job, (key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });
  }

  private deserializeJob(json: string): JobMetadata {
    const raw = JSON.parse(json);
    if (raw.delivery && raw.delivery.fencingToken !== undefined) {
      raw.delivery.fencingToken = BigInt(raw.delivery.fencingToken);
    }
    return raw as JobMetadata;
  }

  // --- Job CRUD & CAS ---
  public async putJob(principalId: string, job: JobMetadata): Promise<PutJobResult> {
    const existing = await this.getJob(principalId, job.identity.clientJobId);
    if (existing) {
      if (existing.identity.requestFingerprint === job.identity.requestFingerprint) {
        return { job: existing, isNew: false };
      }
      throw new ConflictError(
        `Conflict: Job '${job.identity.clientJobId}' already exists with a different request fingerprint`
      );
    }

    const stmt = this.db.prepare(`
      INSERT INTO bg_jobs (
        client_job_id, principal_id, request_fingerprint, kind,
        state, record_version, chat_id, generation_id,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      job.identity.clientJobId,
      principalId,
      job.identity.requestFingerprint,
      job.kind,
      job.recovery.state,
      job.recordVersion,
      job.generation.chatId,
      job.generation.generationId,
      this.serializeJob(job),
      job.audit.createdAt,
      job.audit.updatedAt
    );

    return { job, isNew: true };
  }

  public async getJob(principalId: string, clientJobId: string): Promise<JobMetadata | null> {
    const stmt = this.db.prepare(`
      SELECT metadata_json FROM bg_jobs
      WHERE principal_id = ? AND client_job_id = ?
    `);
    const row = stmt.get(principalId, clientJobId) as { metadata_json: string } | undefined;
    if (!row) return null;
    return this.deserializeJob(row.metadata_json);
  }

  public async getJobById(clientJobId: string): Promise<JobMetadata | null> {
    const stmt = this.db.prepare(`
      SELECT metadata_json FROM bg_jobs
      WHERE client_job_id = ?
    `);
    const row = stmt.get(clientJobId) as { metadata_json: string } | undefined;
    if (!row) return null;
    return this.deserializeJob(row.metadata_json);
  }

  public async updateJobCas(
    principalId: string,
    clientJobId: string,
    expectedRecordVersion: number,
    updatedJob: JobMetadata
  ): Promise<JobMetadata> {
    const nextVersion = expectedRecordVersion + 1;
    const nextJob: JobMetadata = {
      ...updatedJob,
      recordVersion: nextVersion,
      audit: {
        ...updatedJob.audit,
        updatedAt: new Date().toISOString()
      }
    };

    const stmt = this.db.prepare(`
      UPDATE bg_jobs
      SET record_version = ?,
          state = ?,
          metadata_json = ?,
          updated_at = ?
      WHERE principal_id = ? AND client_job_id = ? AND record_version = ?
    `);

    const result = stmt.run(
      nextVersion,
      nextJob.recovery.state,
      this.serializeJob(nextJob),
      nextJob.audit.updatedAt,
      principalId,
      clientJobId,
      expectedRecordVersion
    );

    if (result.changes === 0) {
      const current = await this.getJob(principalId, clientJobId);
      if (!current) {
        throw new Error(`JobNotFound: Job '${clientJobId}' not found for principal '${principalId}'`);
      }
      throw new CasConflictError(
        `CasConflict: Expected recordVersion '${expectedRecordVersion}' but found '${current.recordVersion}' for job '${clientJobId}'`
      );
    }

    return nextJob;
  }

  public async listJobs(principalId: string, filter?: JobListFilter): Promise<JobMetadata[]> {
    let sql = `SELECT metadata_json FROM bg_jobs WHERE principal_id = ?`;
    const params: any[] = [principalId];

    if (filter?.state) {
      sql += ` AND state = ?`;
      params.push(filter.state);
    }
    if (filter?.kind) {
      sql += ` AND kind = ?`;
      params.push(filter.kind);
    }
    if (filter?.chatId) {
      sql += ` AND chat_id = ?`;
      params.push(filter.chatId);
    }
    if (filter?.generationId) {
      sql += ` AND generation_id = ?`;
      params.push(filter.generationId);
    }

    sql += ` ORDER BY created_at ASC`;

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as { metadata_json: string }[];
    const jobs = rows.map((r) => this.deserializeJob(r.metadata_json));

    if (filter?.unconsumedBy) {
      const consumerId = filter.unconsumedBy;
      const unconsumed: JobMetadata[] = [];
      for (const j of jobs) {
        const acked = await this.isAuxAckedBy(j.identity.clientJobId, consumerId);
        if (!acked) {
          unconsumed.push(j);
        }
      }
      return unconsumed;
    }

    return jobs;
  }

  public async listActiveJobs(): Promise<JobMetadata[]> {
    const stmt = this.db.prepare(`
      SELECT metadata_json FROM bg_jobs
      WHERE state IN ('queued', 'running', 'awaiting_tool', 'finalizing')
      ORDER BY created_at ASC
    `);
    const rows = stmt.all() as { metadata_json: string }[];
    return rows.map((r) => this.deserializeJob(r.metadata_json));
  }

  // --- Request Envelopes ---
  public async saveRequestEnvelope(envelopeRef: string, payload: any): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bg_request_envelopes (envelope_ref, payload_json, created_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(envelopeRef, JSON.stringify(payload), new Date().toISOString());
  }

  public async getRequestEnvelope(envelopeRef: string): Promise<any | null> {
    const stmt = this.db.prepare(`
      SELECT payload_json FROM bg_request_envelopes WHERE envelope_ref = ?
    `);
    const row = stmt.get(envelopeRef) as { payload_json: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.payload_json);
  }

  // --- Typed Event Journal ---
  public async appendEvent(event: JobEvent): Promise<JobEvent> {
    const stmt = this.db.prepare(`
      INSERT INTO bg_event_journal (
        job_id, seq, event_id, event_type, created_at, payload_ref, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      event.jobId,
      event.seq,
      event.eventId,
      event.type,
      event.createdAt,
      event.payloadRef ?? null,
      event.payload !== undefined ? JSON.stringify(event.payload) : null
    );

    return event;
  }

  public async getEvents(jobId: string, afterSeq = 0): Promise<JobEvent[]> {
    const stmt = this.db.prepare(`
      SELECT job_id, seq, event_id, event_type, created_at, payload_ref, payload_json
      FROM bg_event_journal
      WHERE job_id = ? AND seq > ?
      ORDER BY seq ASC
    `);

    const rows = stmt.all(jobId, afterSeq) as Array<{
      job_id: string;
      seq: number;
      event_id: string;
      event_type: any;
      created_at: string;
      payload_ref: string | null;
      payload_json: string | null;
    }>;

    return rows.map((r) => ({
      jobId: r.job_id,
      seq: r.seq,
      eventId: r.event_id,
      type: r.event_type,
      createdAt: r.created_at,
      payloadRef: r.payload_ref ?? undefined,
      payload: r.payload_json ? JSON.parse(r.payload_json) : undefined
    }));
  }

  // --- Results ---
  public async saveResult(result: JobResult): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bg_results (
        job_id, result_hash, payload_json, usage_json, finish_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      result.jobId,
      result.resultHash,
      JSON.stringify(result.payload),
      result.usage ? JSON.stringify(result.usage) : null,
      result.finishReason ?? null,
      new Date().toISOString()
    );
  }

  public async getResult(jobId: string): Promise<JobResult | null> {
    const stmt = this.db.prepare(`
      SELECT job_id, result_hash, payload_json, usage_json, finish_reason
      FROM bg_results WHERE job_id = ?
    `);
    const row = stmt.get(jobId) as {
      job_id: string;
      result_hash: string;
      payload_json: string;
      usage_json: string | null;
      finish_reason: string | null;
    } | undefined;

    if (!row) return null;

    return {
      jobId: row.job_id,
      resultHash: row.result_hash,
      payload: JSON.parse(row.payload_json),
      usage: row.usage_json ? JSON.parse(row.usage_json) : undefined,
      finishReason: row.finish_reason ?? undefined
    };
  }

  // --- Tool Checkpoints ---
  public async saveToolCheckpoint(checkpoint: ToolCallCheckpoint): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bg_tool_checkpoints (
        job_id, tool_call_id, tool_name, args_hash, args_json,
        executor_type, replay_policy, state, result_ref, result_json,
        idempotency_key, approval_granted, attempt, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      checkpoint.jobId,
      checkpoint.toolCallId,
      checkpoint.toolName,
      checkpoint.argsHash,
      JSON.stringify(checkpoint.args),
      checkpoint.executorType,
      checkpoint.replayPolicy,
      checkpoint.state,
      checkpoint.resultRef ?? null,
      checkpoint.resultPayload !== undefined ? JSON.stringify(checkpoint.resultPayload) : null,
      checkpoint.idempotencyKey ?? null,
      checkpoint.approvalGranted ? 1 : 0,
      checkpoint.attempt,
      checkpoint.startedAt ?? null,
      checkpoint.completedAt ?? null
    );
  }

  public async getToolCheckpoint(jobId: string, toolCallId: string): Promise<ToolCallCheckpoint | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM bg_tool_checkpoints WHERE job_id = ? AND tool_call_id = ?
    `);
    const row = stmt.get(jobId, toolCallId) as any;
    if (!row) return null;

    return {
      jobId: row.job_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      argsHash: row.args_hash,
      args: JSON.parse(row.args_json),
      executorType: row.executor_type,
      replayPolicy: row.replay_policy,
      state: row.state,
      resultRef: row.result_ref ?? undefined,
      resultPayload: row.result_json ? JSON.parse(row.result_json) : undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      approvalGranted: Boolean(row.approval_granted),
      attempt: row.attempt,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }

  public async listToolCheckpoints(jobId: string): Promise<ToolCallCheckpoint[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM bg_tool_checkpoints WHERE job_id = ? ORDER BY started_at ASC
    `);
    const rows = stmt.all(jobId) as any[];
    return rows.map((row) => ({
      jobId: row.job_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      argsHash: row.args_hash,
      args: JSON.parse(row.args_json),
      executorType: row.executor_type,
      replayPolicy: row.replay_policy,
      state: row.state,
      resultRef: row.result_ref ?? undefined,
      resultPayload: row.result_json ? JSON.parse(row.result_json) : undefined,
      idempotencyKey: row.idempotency_key ?? undefined,
      approvalGranted: Boolean(row.approval_granted),
      attempt: row.attempt,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined
    }));
  }

  // --- Finalization Stage Ledger ---
  public async saveStageEntry(entry: FinalizationStageLedgerEntry): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bg_stage_ledger (
        job_id, generation_id, stage_id, stage_version, input_hash,
        status, attempt, output_hash, output_json, error, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.jobId,
      entry.generationId,
      entry.stageId,
      entry.stageVersion,
      entry.inputHash,
      entry.status,
      entry.attempt,
      entry.outputHash ?? null,
      entry.outputPayload !== undefined ? JSON.stringify(entry.outputPayload) : null,
      entry.error ?? null,
      entry.completedAt ?? null
    );
  }

  public async getStageEntry(
    jobId: string,
    generationId: string,
    stageId: string,
    stageVersion: number
  ): Promise<FinalizationStageLedgerEntry | null> {
    const stmt = this.db.prepare(`
      SELECT * FROM bg_stage_ledger
      WHERE job_id = ? AND generation_id = ? AND stage_id = ? AND stage_version = ?
    `);
    const row = stmt.get(jobId, generationId, stageId, stageVersion) as any;
    if (!row) return null;

    return {
      jobId: row.job_id,
      generationId: row.generation_id,
      stageId: row.stage_id,
      stageVersion: row.stage_version,
      inputHash: row.input_hash,
      status: row.status,
      attempt: row.attempt,
      outputHash: row.output_hash ?? undefined,
      outputPayload: row.output_json ? JSON.parse(row.output_json) : undefined,
      error: row.error ?? undefined,
      completedAt: row.completed_at ?? undefined
    };
  }

  public async listStageEntries(jobId: string, generationId: string): Promise<FinalizationStageLedgerEntry[]> {
    const stmt = this.db.prepare(`
      SELECT * FROM bg_stage_ledger
      WHERE job_id = ? AND generation_id = ?
      ORDER BY stage_version ASC
    `);
    const rows = stmt.all(jobId, generationId) as any[];
    return rows.map((row) => ({
      jobId: row.job_id,
      generationId: row.generation_id,
      stageId: row.stage_id,
      stageVersion: row.stage_version,
      inputHash: row.input_hash,
      status: row.status,
      attempt: row.attempt,
      outputHash: row.output_hash ?? undefined,
      outputPayload: row.output_json ? JSON.parse(row.output_json) : undefined,
      error: row.error ?? undefined,
      completedAt: row.completed_at ?? undefined
    }));
  }

  // --- Aux Consumer ACKs ---
  public async recordAuxAck(ack: AuxConsumerAck): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bg_aux_acks (
        job_id, consumer_id, consumer_group, result_hash, acked_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      ack.jobId,
      ack.consumerId,
      ack.consumerGroup ?? null,
      ack.resultHash,
      ack.ackedAt
    );
  }

  public async getAuxAcks(jobId: string): Promise<AuxConsumerAck[]> {
    const stmt = this.db.prepare(`
      SELECT job_id, consumer_id, consumer_group, result_hash, acked_at
      FROM bg_aux_acks WHERE job_id = ?
    `);
    const rows = stmt.all(jobId) as any[];
    return rows.map((r) => ({
      jobId: r.job_id,
      consumerId: r.consumer_id,
      consumerGroup: r.consumer_group ?? undefined,
      resultHash: r.result_hash,
      ackedAt: r.acked_at
    }));
  }

  public async isAuxAckedBy(jobId: string, consumerId: string): Promise<boolean> {
    const stmt = this.db.prepare(`
      SELECT 1 FROM bg_aux_acks WHERE job_id = ? AND consumer_id = ?
    `);
    const row = stmt.get(jobId, consumerId);
    return row !== undefined;
  }
}
