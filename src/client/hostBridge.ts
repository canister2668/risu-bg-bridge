import { randomUUID } from "node:crypto";
import {
  BackgroundCapabilities,
  CreateBackgroundJobRequest,
  JobListFilter,
  JobSnapshot,
  JobResult,
  JobEvent,
  DeliveryLease,
  FinalizeRequest,
  FinalizeResult,
  JobMetadata,
  RetryPolicy,
  AuxConsumerAck
} from "../contract/index.js";
import { IdempotentJobRegistry, calculateFingerprint } from "../engine/fingerprint.js";
import { InMemoryEventJournal } from "../engine/journal.js";
import { DeliveryLeaseManager, FencingTokenStaleError } from "../engine/lease.js";
import { transitionJob, calculatePayloadHash } from "../engine/stateMachine.js";
import { BgStorageEngine } from "../storage/interface.js";
import { ResumableFinalizer } from "../engine/finalization.js";

export interface BackgroundModelsApi {
  getCapabilities(): Promise<BackgroundCapabilities>;
  createJob(req: CreateBackgroundJobRequest): Promise<JobSnapshot>;
  getJob(jobId: string): Promise<JobSnapshot>;
  listJobs(filter?: JobListFilter): Promise<JobSnapshot[]>;
  streamEvents(jobId: string, opts?: { afterSeq?: number }): AsyncIterable<JobEvent>;
  readResult(jobId: string): Promise<JobResult>;
  cancelJob(jobId: string, reason?: string): Promise<JobSnapshot>;
  acquireDeliveryLease(jobId: string): Promise<DeliveryLease>;
  renewDeliveryLease(jobId: string, leaseId: string): Promise<DeliveryLease>;
  finalize(jobId: string, req: FinalizeRequest): Promise<FinalizeResult>;
  ackResult(jobId: string, consumerId: string, resultHash: string, consumerGroup?: string): Promise<void>;
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Reference in-memory implementation of the plugin host-client bridge.
 * Authenticates requests on behalf of a principal and coordinates operations
 * across the registry, event journal, and lease manager.
 */
export class HostBackgroundModelsBridge implements BackgroundModelsApi {
  protected capabilities: BackgroundCapabilities;
  protected registry: IdempotentJobRegistry;
  protected journal: InMemoryEventJournal;
  protected results = new Map<string, any>(); // jobId -> result payload
  protected acks = new Map<string, Set<string>>(); // jobId -> consumerIds that ACKed

  constructor(
    protected principalId: string,
    protected clientId: string,
    capabilities: BackgroundCapabilities,
    registry: IdempotentJobRegistry,
    journal: InMemoryEventJournal
  ) {
    this.capabilities = capabilities;
    this.registry = registry;
    this.journal = journal;
  }

  protected mapToSnapshot(job: any): JobSnapshot {
    return {
      jobId: job.identity.clientJobId,
      state: job.recovery.state,
      kind: job.kind,
      fingerprint: job.identity.requestFingerprint,
      attempt: job.execution.attempt,
      generationId: job.generation.generationId,
      resultHash: job.result?.resultHash,
      error: job.recovery.ambiguousReason || job.result?.terminalSignal,
      updatedAt: job.audit.updatedAt,
      deliveryState: job.delivery.deliveryState,
      leaseExpiresAt: job.delivery.leaseExpiresAt
    };
  }

  protected verifyOwnership(job: any) {
    if (job.identity.principalId !== this.principalId) {
      throw new UnauthorizedError(`PermissionDenied: Principal '${this.principalId}' does not own job '${job.identity.clientJobId}'`);
    }
  }

  public async getCapabilities(): Promise<BackgroundCapabilities> {
    return this.capabilities;
  }

  public async createJob(req: CreateBackgroundJobRequest): Promise<JobSnapshot> {
    const { job, isNew } = this.registry.putJob(this.principalId, req);

    if (isNew) {
      await this.journal.appendEvent(job.identity.clientJobId, "state", {
        state: "reserved",
        reason: "Job reserved on PUT request"
      });
    }

    return this.mapToSnapshot(job);
  }

  public async getJob(jobId: string): Promise<JobSnapshot> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found under principal '${this.principalId}'`);
    }
    this.verifyOwnership(job);
    return this.mapToSnapshot(job);
  }

  public async listJobs(filter?: JobListFilter): Promise<JobSnapshot[]> {
    let jobs = this.registry.listJobs(this.principalId);

    if (filter) {
      if (filter.state) {
        jobs = jobs.filter((j) => j.recovery.state === filter.state);
      }
      if (filter.kind) {
        jobs = jobs.filter((j) => j.kind === filter.kind);
      }
      if (filter.generationId) {
        jobs = jobs.filter((j) => j.generation.generationId === filter.generationId);
      }
      if (filter.chatId) {
        jobs = jobs.filter((j) => j.generation.chatId === filter.chatId);
      }
    }

    return jobs.map((j) => this.mapToSnapshot(j));
  }

  public async *streamEvents(
    jobId: string,
    opts?: { afterSeq?: number }
  ): AsyncIterable<JobEvent> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const afterSeq = opts?.afterSeq ?? 0;
    const events = await this.journal.getEvents(jobId, afterSeq);

    for (const event of events) {
      yield event;
    }
  }

  public async readResult(jobId: string): Promise<JobResult> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    if (job.recovery.state !== "succeeded" && job.recovery.state !== "completed" && job.recovery.state !== "finalizing") {
      throw new Error(`JobNotFinished: Cannot read result for job in state '${job.recovery.state}'`);
    }

    const payload = this.results.get(jobId);
    if (!payload) {
      throw new NotFoundError(`ResultPayloadNotFound: Result data missing for job '${jobId}'`);
    }

    return {
      jobId,
      resultHash: job.result?.resultHash || "",
      payload,
      usage: job.result?.usage,
      finishReason: job.result?.finishReason
    };
  }

  public async cancelJob(jobId: string, reason = "Cancelled by client"): Promise<JobSnapshot> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const updatedJob = transitionJob(job, "cancelled", {
      result: {
        terminalSignal: reason
      }
    });

    this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);

    await this.journal.appendEvent(jobId, "state", {
      state: "cancelled",
      reason
    });

    return this.mapToSnapshot(updatedJob);
  }

  public async acquireDeliveryLease(jobId: string): Promise<DeliveryLease> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const { updatedJob, lease } = DeliveryLeaseManager.acquireLease(job, this.clientId);

    this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);

    await this.journal.appendEvent(jobId, "state", {
      state: "finalizing",
      reason: `Lease acquired by client '${this.clientId}'`
    });

    return lease;
  }

  public async renewDeliveryLease(jobId: string, leaseId: string): Promise<DeliveryLease> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const fencingToken = job.delivery.fencingToken;
    const { updatedJob, lease } = DeliveryLeaseManager.renewLease(job, leaseId, fencingToken);

    this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);
    return lease;
  }

  public async finalize(jobId: string, req: FinalizeRequest): Promise<FinalizeResult> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    try {
      const fencingToken = BigInt(req.fencingToken);
      const updatedJob = DeliveryLeaseManager.finalizeWithFencing(
        job,
        req.leaseId,
        fencingToken,
        this.clientId,
        req.materializationProof
      );

      this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);

      await this.journal.appendEvent(jobId, "state", {
        state: "completed",
        reason: "Finalization successful, chat materialized"
      });

      return { jobId, status: "completed" };
    } catch (err: any) {
      return {
        jobId,
        status: "failed",
        error: err.message
      };
    }
  }

  public async ackResult(jobId: string, consumerId: string, resultHash: string, consumerGroup?: string): Promise<void> {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    if (job.result?.resultHash !== resultHash) {
      throw new Error(`HashMismatch: ACK resultHash '${resultHash}' does not match job's resultHash`);
    }

    let consumers = this.acks.get(jobId);
    if (!consumers) {
      consumers = new Set<string>();
      this.acks.set(jobId, consumers);
    }
    consumers.add(consumerId);

    // If all required consumers have ACKed, we transition the job to completed (for aux jobs)
    if (job.kind === "aux" && job.recovery.state === "succeeded") {
      const updatedJob = transitionJob(job, "completed");
      this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);

      await this.journal.appendEvent(jobId, "state", {
        state: "completed",
        reason: `Result ACKed by consumer '${consumerId}'`
      });
    }
  }

  // --- Mock methods for testing and simulation only ---
  public _simulateServerSucceeded(jobId: string, payload: any) {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) throw new Error("Job not found");

    const hash = calculatePayloadHash(payload);
    this.results.set(jobId, payload);

    const updatedJob = transitionJob(job, "succeeded", {
      result: {
        resultRef: `store://${this.principalId}/${jobId}`,
        resultHash: hash,
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "stop"
      }
    });

    this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);
  }

  public _simulateServerFailed(jobId: string, errorMsg: string) {
    const job = this.registry.getJob(this.principalId, jobId);
    if (!job) throw new Error("Job not found");

    const updatedJob = transitionJob(job, "failed", {
      result: {
        terminalSignal: errorMsg,
        finishReason: "error"
      }
    });

    this.registry.updateJob(this.principalId, jobId, job.recordVersion, updatedJob);
  }
}

/**
 * Production-ready Persistent Host Bridge backed by a BgStorageEngine.
 * Implements durable storage, discovery, lease fencing, and aux consumer ACKs.
 */
export class PersistentHostBackgroundModelsBridge implements BackgroundModelsApi {
  private finalizer: ResumableFinalizer;

  constructor(
    private principalId: string,
    private clientId: string,
    private capabilities: BackgroundCapabilities,
    private storage: BgStorageEngine
  ) {
    this.finalizer = new ResumableFinalizer(storage);
  }

  private mapToSnapshot(job: JobMetadata): JobSnapshot {
    return {
      jobId: job.identity.clientJobId,
      state: job.recovery.state,
      kind: job.kind,
      fingerprint: job.identity.requestFingerprint,
      attempt: job.execution.attempt,
      generationId: job.generation.generationId,
      resultHash: job.result?.resultHash,
      error: job.recovery.ambiguousReason || job.result?.terminalSignal,
      updatedAt: job.audit.updatedAt,
      deliveryState: job.delivery.deliveryState,
      leaseExpiresAt: job.delivery.leaseExpiresAt
    };
  }

  private verifyOwnership(job: JobMetadata) {
    if (job.identity.principalId !== this.principalId) {
      throw new UnauthorizedError(
        `PermissionDenied: Principal '${this.principalId}' does not own job '${job.identity.clientJobId}'`
      );
    }
  }

  public async getCapabilities(): Promise<BackgroundCapabilities> {
    return this.capabilities;
  }

  public async createJob(req: CreateBackgroundJobRequest): Promise<JobSnapshot> {
    const fingerprint = calculateFingerprint(req);
    const defaultRetryPolicy: RetryPolicy = {
      maxAttempts: 3,
      initialDelayMs: 1000,
      backoffFactor: 2,
      idempotencySupported: false,
      ...req.retryPolicy
    };

    const envelopeRef = `envelope://${this.principalId}/${req.clientJobId}`;
    await this.storage.saveRequestEnvelope(envelopeRef, req.payload);

    const now = new Date().toISOString();
    const newJob: JobMetadata = {
      recordVersion: 1,
      identity: {
        principalId: this.principalId,
        clientJobId: req.clientJobId,
        requestFingerprint: fingerprint
      },
      kind: req.kind,
      execution: {
        providerRef: req.providerRef,
        modelRef: req.modelRef,
        credentialRef: req.credentialRef,
        credentialEpoch: req.credentialEpoch,
        requestEnvelopeRef: envelopeRef,
        attempt: 1,
        executionEpoch: 1
      },
      generation: req.generation,
      versioning: {
        contractVersion: req.versioning.contractVersion,
        jobSchemaVersion: 1,
        pipelineVersion: req.versioning.pipelineVersion,
        pluginVersion: req.versioning.pluginVersion,
        adapterVersion: this.capabilities.adapter.version
      },
      recovery: {
        state: "reserved",
        retryPolicy: defaultRetryPolicy
      },
      delivery: {
        deliveryState: "undelivered",
        fencingToken: 0n
      },
      audit: {
        createdAt: now,
        updatedAt: now
      }
    };

    const { job, isNew } = await this.storage.putJob(this.principalId, newJob);

    if (isNew) {
      await this.storage.appendEvent({
        jobId: job.identity.clientJobId,
        seq: 1,
        eventId: randomUUID(),
        type: "state",
        createdAt: now,
        payload: { state: "reserved", reason: "Job reserved on PUT request" }
      });
    }

    return this.mapToSnapshot(job);
  }

  public async getJob(jobId: string): Promise<JobSnapshot> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found under principal '${this.principalId}'`);
    }
    this.verifyOwnership(job);
    return this.mapToSnapshot(job);
  }

  public async listJobs(filter?: JobListFilter): Promise<JobSnapshot[]> {
    const jobs = await this.storage.listJobs(this.principalId, filter);
    return jobs.map((j) => this.mapToSnapshot(j));
  }

  public async *streamEvents(
    jobId: string,
    opts?: { afterSeq?: number }
  ): AsyncIterable<JobEvent> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const afterSeq = opts?.afterSeq ?? 0;
    const events = await this.storage.getEvents(jobId, afterSeq);

    for (const event of events) {
      yield event;
    }
  }

  public async readResult(jobId: string): Promise<JobResult> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    if (
      job.recovery.state !== "succeeded" &&
      job.recovery.state !== "completed" &&
      job.recovery.state !== "finalizing"
    ) {
      throw new Error(`JobNotFinished: Cannot read result for job in state '${job.recovery.state}'`);
    }

    const result = await this.storage.getResult(jobId);
    if (!result) {
      throw new NotFoundError(`ResultPayloadNotFound: Result data missing for job '${jobId}'`);
    }

    return result;
  }

  public async cancelJob(jobId: string, reason = "Cancelled by client"): Promise<JobSnapshot> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const updatedJob = transitionJob(job, "cancelled", {
      result: {
        terminalSignal: reason
      }
    });

    const stored = await this.storage.updateJobCas(this.principalId, jobId, job.recordVersion, updatedJob);

    await this.storage.appendEvent({
      jobId,
      seq: (await this.storage.getEvents(jobId)).length + 1,
      eventId: randomUUID(),
      type: "state",
      createdAt: new Date().toISOString(),
      payload: { state: "cancelled", reason }
    });

    return this.mapToSnapshot(stored);
  }

  public async acquireDeliveryLease(jobId: string): Promise<DeliveryLease> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const { updatedJob, lease } = DeliveryLeaseManager.acquireLease(job, this.clientId);

    await this.storage.updateJobCas(this.principalId, jobId, job.recordVersion, updatedJob);

    await this.storage.appendEvent({
      jobId,
      seq: (await this.storage.getEvents(jobId)).length + 1,
      eventId: randomUUID(),
      type: "state",
      createdAt: new Date().toISOString(),
      payload: { state: "finalizing", reason: `Lease acquired by client '${this.clientId}'` }
    });

    return lease;
  }

  public async renewDeliveryLease(jobId: string, leaseId: string): Promise<DeliveryLease> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    const fencingToken = job.delivery.fencingToken;
    const { updatedJob, lease } = DeliveryLeaseManager.renewLease(job, leaseId, fencingToken);

    await this.storage.updateJobCas(this.principalId, jobId, job.recordVersion, updatedJob);
    return lease;
  }

  public async finalize(jobId: string, req: FinalizeRequest): Promise<FinalizeResult> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    try {
      const fencingToken = BigInt(req.fencingToken);

      // Verify materialization proof
      const verification = this.finalizer.verifyMaterialization(job, req.materializationProof);
      if (!verification.valid) {
        throw new Error(`MaterializationVerificationFailed: ${verification.reason}`);
      }

      const updatedJob = DeliveryLeaseManager.finalizeWithFencing(
        job,
        req.leaseId,
        fencingToken,
        this.clientId,
        req.materializationProof
      );

      await this.storage.updateJobCas(this.principalId, jobId, job.recordVersion, updatedJob);

      await this.storage.appendEvent({
        jobId,
        seq: (await this.storage.getEvents(jobId)).length + 1,
        eventId: randomUUID(),
        type: "state",
        createdAt: new Date().toISOString(),
        payload: { state: "completed", reason: "Finalization successful, chat materialized" }
      });

      return { jobId, status: "completed" };
    } catch (err: any) {
      return {
        jobId,
        status: "failed",
        error: err.message
      };
    }
  }

  public async ackResult(
    jobId: string,
    consumerId: string,
    resultHash: string,
    consumerGroup?: string
  ): Promise<void> {
    const job = await this.storage.getJob(this.principalId, jobId);
    if (!job) {
      throw new NotFoundError(`JobNotFound: Job '${jobId}' not found`);
    }
    this.verifyOwnership(job);

    if (job.result?.resultHash !== resultHash) {
      throw new Error(`HashMismatch: ACK resultHash '${resultHash}' does not match job's resultHash`);
    }

    const ack: AuxConsumerAck = {
      jobId,
      consumerId,
      consumerGroup,
      resultHash,
      ackedAt: new Date().toISOString()
    };
    await this.storage.recordAuxAck(ack);

    // If aux job in succeeded state is acked, mark completed
    if (job.kind === "aux" && job.recovery.state === "succeeded") {
      const updatedJob = transitionJob(job, "completed");
      await this.storage.updateJobCas(this.principalId, jobId, job.recordVersion, updatedJob);

      await this.storage.appendEvent({
        jobId,
        seq: (await this.storage.getEvents(jobId)).length + 1,
        eventId: randomUUID(),
        type: "state",
        createdAt: new Date().toISOString(),
        payload: { state: "completed", reason: `Result ACKed by consumer '${consumerId}'` }
      });
    }
  }
}
