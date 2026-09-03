import {
  BackgroundCapabilities,
  CreateBackgroundJobRequest,
  JobEvent,
  JobListFilter,
  JobResult,
  JobSnapshot,
  DeliveryLease,
  FinalizeRequest,
  FinalizeResult
} from "../../src/contract/index.js";
import { BackgroundModelsApi } from "../../src/client/hostBridge.js";
import { Pocket110Adapter, PocketBridgeExtension, PocketModelJobCreate } from "../../adapters/pocket/adapter.js";
import { probeHttpCapabilities, FetchLike } from "./negotiation.js";
import { uuidv7 } from "./uuidv7.js";

/**
 * HTTP client for the transport dialect VERIFIED in PocketRisu 1.10.0
 * (targets/pocket.lock.yaml, model-jobs.cjs):
 *
 *   POST   /api/model-jobs            create (client-supplied UUID id)
 *   GET    /api/model-jobs?active=1   list running jobs (filter REQUIRED)
 *   GET    /api/model-jobs/:id        rowToJson snapshot
 *   GET    /api/model-jobs/:id/stream raw journal replay / live tail
 *   POST   /api/model-jobs/:id/claim  claim a terminal job
 *   DELETE /api/model-jobs/:id        abort
 *
 * …plus the bridge v1 surface this kit's patch series installs
 * (adapters/pocket/series.yaml, steps pocket-002..pocket-104):
 *
 *   GET    /api/risu-bg-bridge/v1/jobs/:id        typed snapshot w/ fingerprint
 *   GET    /api/risu-bg-bridge/v1/jobs/:id/events typed replay, server-side afterSeq
 *   GET    /api/risu-bg-bridge/v1/jobs/:id/result typed receipt + journal hash
 *   PUT    /api/risu-bg-bridge/v1/jobs/:id        idempotent create-or-replay
 *   POST   /api/risu-bg-bridge/v1/jobs/:id/lease            acquire (fencing)
 *   POST   /api/risu-bg-bridge/v1/jobs/:id/lease/:leaseId/renew
 *   POST   /api/risu-bg-bridge/v1/jobs/:id/finalize         proof seam
 *   POST   /api/risu-bg-bridge/v1/jobs/:id/ack              durable consumer ACK
 *   GET    /api/risu-bg-bridge/v1/aux/pending?consumer=     durable aux discovery
 *
 * Bridge paths activate ONLY when the governing capabilities object carries a
 * well-formed `bridge` block (what a patched server actually advertises). With
 * no bridge block the transport behaves exactly like round 1: stock POST
 * create, raw journal streaming, and honest throws for everything 1.10.0
 * never had — no capability is unlocked by data the server did not report.
 *
 * Row status → contract state mapping (model-jobs.cjs TERMINAL_STATUSES):
 *   running → running, done → succeeded, failed → failed, aborted → cancelled
 */

export interface PocketModelJobRow {
  id: string;
  chatId: string;
  generationId?: string | null;
  adapterKind?: string | null;
  model?: string;
  targetOrigin?: string;
  kind: "main" | "background" | "aux";
  streaming: boolean;
  status: "running" | "done" | "failed" | "aborted";
  upstreamStatus?: number;
  contentType?: string;
  error?: string;
  createdAt: number;
  endedAt?: number;
  bytes: number;
  claimed: boolean;
}

/** Bridge snapshot: the stock row JSON plus the fields only the patch tracks. */
export interface PocketBridgeJobRow extends PocketModelJobRow {
  requestFingerprint?: string | null;
  principalId?: string | null;
  deliveryState?: "undelivered" | "leased" | "delivered";
  lease?: {
    leaseId: string;
    ownerClientId?: string;
    fencingToken: string;
    expiresAt: string;
  } | null;
  finalizedAt?: string;
}

/** GET /jobs/:id/events page served by the patched server. */
interface BridgeEventsPage {
  jobId: string;
  status: PocketModelJobRow["status"];
  chatId: string;
  generationId?: string;
  events: Array<{ seq: number; type: string; payload: unknown }>;
  bytes: number;
  final: boolean;
  truncated: boolean;
}

/** GET /jobs/:id/result receipt served by the patched server. */
interface BridgeResultReceipt {
  jobId: string;
  status: PocketModelJobRow["status"];
  resultHash: string;
  bytes: number;
  contentType?: string;
  upstreamStatus?: number;
  generationId?: string;
  error?: string;
}

const STATE_MAP: Record<PocketModelJobRow["status"], JobSnapshot["state"]> = {
  running: "running",
  done: "succeeded",
  failed: "failed",
  aborted: "cancelled"
};

const BRIDGE_BASE = "/api/risu-bg-bridge/v1";
const TYPED_EVENTS_DEFAULT_LIMIT_BYTES = 4194304;
const TYPED_POLL_DEFAULT_DELAY_MS = 250;

export class PocketTransportUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PocketTransportUnavailableError";
  }
}

export class PocketTransportHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "PocketTransportHttpError";
  }
}

export interface PocketTransportOptions {
  /** Stable client identity stamped on leases; defaults to a per-transport UUIDv7. */
  ownerClientId?: string;
  /** Delay between typed event polls while a job is running (tests use 0). */
  pollDelayMs?: number;
  /** Byte budget for one typed events page (server clamps to its own max). */
  typedEventsLimitBytes?: number;
}

export class PocketModelJobsTransport implements BackgroundModelsApi {
  private adapter = new Pocket110Adapter();
  private readonly ownerClientId: string;
  private readonly pollDelayMs: number;
  private readonly typedEventsLimitBytes: number;

  constructor(
    private fetchImpl: FetchLike,
    private baseUrl: string,
    private caps: BackgroundCapabilities = new Pocket110Adapter().getCapabilities(),
    opts: PocketTransportOptions = {}
  ) {
    this.ownerClientId = opts.ownerClientId ?? uuidv7();
    this.pollDelayMs = opts.pollDelayMs ?? TYPED_POLL_DEFAULT_DELAY_MS;
    this.typedEventsLimitBytes = Math.max(
      1,
      opts.typedEventsLimitBytes ?? TYPED_EVENTS_DEFAULT_LIMIT_BYTES
    );
  }

  /**
   * The bridge block, but only when it is exactly the shape the patched
   * server serves. Capabilities can come from an untrusted HTTP probe, so a
   * block that merely LOOKS bridge-ish never flips transport behavior:
   * version must be 1 and every boolean feature must be a boolean.
   */
  private bridgeInfo(): PocketBridgeExtension | null {
    const bridge = (this.caps as { bridge?: unknown }).bridge;
    if (bridge === null || typeof bridge !== "object" || Array.isArray(bridge)) return null;
    const b = bridge as Partial<PocketBridgeExtension>;
    if (b.version !== 1) return null;
    for (const key of [
      "putIdempotency",
      "typedEvents",
      "typedResult",
      "auxDiscovery",
      "auxAck",
      "deliveryLease"
    ] as const) {
      if (typeof b[key] !== "boolean") return null;
    }
    return b as PocketBridgeExtension;
  }

  /** Row → contract snapshot. attempt/epoch have no server analogue: fixed. */
  private rowToSnapshot(row: PocketModelJobRow): JobSnapshot {
    const state = STATE_MAP[row.status] ?? "failed";
    return {
      jobId: row.id,
      state,
      kind: row.kind === "aux" ? "aux" : "main",
      fingerprint: "", // stock rows carry no server-side fingerprint (documented gap)
      attempt: 1,
      generationId: row.generationId ?? "",
      resultHash: undefined,
      error: row.error,
      updatedAt: new Date(row.endedAt ?? row.createdAt).toISOString(),
      deliveryState: row.claimed ? "delivered" : "undelivered"
    };
  }

  /** Bridge snapshot → contract snapshot (fingerprint + delivery now real). */
  private bridgeRowToSnapshot(row: PocketBridgeJobRow): JobSnapshot {
    const state = STATE_MAP[row.status] ?? "failed";
    return {
      jobId: row.id,
      state,
      kind: row.kind === "aux" ? "aux" : "main",
      fingerprint: typeof row.requestFingerprint === "string" ? row.requestFingerprint : "",
      attempt: 1,
      generationId: row.generationId ?? "",
      resultHash: undefined, // hashes live on the result receipt / typed events
      error: row.error,
      updatedAt: new Date(row.endedAt ?? row.createdAt).toISOString(),
      deliveryState: row.deliveryState ?? (row.claimed ? "delivered" : "undelivered"),
      leaseExpiresAt: row.lease?.expiresAt
    };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      ...init,
      credentials: "include",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PocketTransportHttpError(
        `${init.method ?? "GET"} ${path} -> ${response.status}: ${text.slice(0, 200)}`,
        response.status,
        text
      );
    }
    return JSON.parse(text) as T;
  }

  private async delay(): Promise<void> {
    if (this.pollDelayMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.pollDelayMs));
  }

  public async getCapabilities(): Promise<BackgroundCapabilities> {
    const probed = await probeHttpCapabilities(this.fetchImpl, this.baseUrl);
    // The patched server's endpoint is authoritative; when the patch is not
    // deployed, report the kit's verified patched-build matrix instead of
    // guessing. A strictly-valid probed matrix also becomes the gating
    // matrix, so bridge paths follow what THIS server actually advertises.
    if (probed.available) {
      this.caps = probed.capabilities;
      return probed.capabilities;
    }
    return this.caps;
  }

  public async createJob(req: CreateBackgroundJobRequest): Promise<JobSnapshot> {
    const body: PocketModelJobCreate = this.adapter.mapClientRequest(req.clientJobId, req);
    const bridge = this.bridgeInfo();
    if (bridge?.putIdempotency) {
      // PUT create-or-replay: the same clientJobId + the same canonical
      // request replays the existing row (isNew:false) instead of re-issuing
      // the provider request; a different request under the same id is the
      // server's 409, surfaced as PocketTransportHttpError.
      const result = await this.request<{ job: PocketBridgeJobRow; isNew: boolean }>(
        `${BRIDGE_BASE}/jobs/${encodeURIComponent(body.id)}`,
        { method: "PUT", body: JSON.stringify(body) }
      );
      return this.bridgeRowToSnapshot(result.job);
    }
    const result = await this.request<{ jobId: string }>("/api/model-jobs", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const row = await this.getJobRaw(result.jobId);
    return this.rowToSnapshot(row);
  }

  private async getJobRaw(jobId: string): Promise<PocketModelJobRow> {
    return this.request<PocketModelJobRow>(`/api/model-jobs/${encodeURIComponent(jobId)}`, {
      method: "GET"
    });
  }

  public async getJob(jobId: string): Promise<JobSnapshot> {
    if (this.bridgeInfo()) {
      return this.bridgeRowToSnapshot(
        await this.request<PocketBridgeJobRow>(
          `${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}`,
          { method: "GET" }
        )
      );
    }
    return this.rowToSnapshot(await this.getJobRaw(jobId));
  }

  public async listJobs(filter?: JobListFilter): Promise<JobSnapshot[]> {
    // Durable aux discovery is bridge-only: terminal, un-ACKed aux jobs the
    // given consumer has not consumed yet.
    if (filter?.unconsumedBy !== undefined) {
      const bridge = this.bridgeInfo();
      if (!bridge?.auxDiscovery) {
        throw new PocketTransportUnavailableError(
          "PocketRisu 1.10.0 (unpatched) has no durable aux discovery; requires the risu-bg-bridge v1 patch"
        );
      }
      const query = `consumer=${encodeURIComponent(filter.unconsumedBy)}`;
      const result = await this.request<{ jobs: PocketBridgeJobRow[] }>(
        `${BRIDGE_BASE}/aux/pending?${query}`,
        { method: "GET" }
      );
      return (result.jobs ?? []).map((r) => this.bridgeRowToSnapshot(r));
    }
    if (filter?.state && filter.state !== "running") {
      // 1.10.0 list only supports active/unclaimed splits; refusing anything
      // else is more honest than returning a wrong subset.
      throw new PocketTransportUnavailableError(
        `PocketRisu 1.10.0 list only supports running jobs (asked for state '${filter.state}')`
      );
    }
    const result = await this.request<{ jobs: PocketModelJobRow[] }>("/api/model-jobs?active=1", {
      method: "GET"
    });
    let rows: PocketModelJobRow[] = result.jobs ?? [];
    if (filter?.chatId) {
      rows = rows.filter((r) => r.chatId === filter.chatId);
    }
    return rows.map((r) => this.rowToSnapshot(r));
  }

  /**
   * Typed replay against the patched server (bridge typedEvents): pages of
   * provider_chunk events whose seq is the journal byte offset, exactly one
   * terminal marker (result_ready with the journal hash, or error) on the
   * final page, and afterSeq honored server-side so no byte is re-sent.
   * Historical state transitions are not reconstructed — the patched server
   * cannot invent events it never recorded, and this wrapper does not either.
   */
  private async *streamTypedEvents(jobId: string, afterSeq: number): AsyncIterable<JobEvent> {
    let cursor = afterSeq;
    for (;;) {
      const page = await this.request<BridgeEventsPage>(
        `${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}/events?afterSeq=${cursor}&limit=${this.typedEventsLimitBytes}`,
        { method: "GET" }
      );
      let sawTerminal = false;
      for (const ev of page.events ?? []) {
        yield {
          jobId,
          seq: ev.seq,
          eventId: `${ev.type}:${ev.seq}`,
          type: ev.type as JobEvent["type"],
          createdAt: new Date().toISOString(),
          payload: ev.payload
        };
        if (ev.type === "result_ready" || ev.type === "error") sawTerminal = true;
      }
      if (page.final || sawTerminal) return;
      const last = (page.events ?? []).at(-1);
      if (last) cursor = last.seq;
      if (page.truncated) {
        // More bytes are ready: fetch the next page immediately. A truncated
        // page with no events is a protocol anomaly — stop fail-visible
        // instead of hot-looping a lying server.
        if (!last) {
          throw new PocketTransportUnavailableError(
            `bridge events page for ${jobId} reported truncated=true with no events`
          );
        }
        continue;
      }
      await this.delay(); // caught up with a running job: poll again
    }
  }

  /**
   * Streams the raw journal as provider_chunk events. 1.10.0 journals raw
   * provider bytes; the contract's typed envelope layers over them, so each
   * yielded event carries a base64 fragment and a monotonically increasing
   * byte-offset sequence (design §10: raw preservation + typed envelope).
   *
   * Resume semantics on the RAW path: the 1.10.0 stream endpoint has NO
   * offset parameter (verified: `streamJob(jobId, res)` always replays the
   * journal from byte 0), so afterSeq is honored client-side — bytes below
   * the requested offset are read and discarded. The journal is an
   * immutable, deterministic byte stream, so re-reading from 0 is safe.
   */
  public async *streamEvents(jobId: string, opts?: { afterSeq?: number }): AsyncIterable<JobEvent> {
    if (this.bridgeInfo()?.typedEvents) {
      yield* this.streamTypedEvents(jobId, opts?.afterSeq ?? 0);
      return;
    }
    const after = opts?.afterSeq ?? 0;
    const response = await this.fetchImpl(
      `${this.baseUrl.replace(/\/+$/, "")}/api/model-jobs/${encodeURIComponent(jobId)}/stream`,
      { method: "GET", credentials: "include" }
    );
    if (!response.ok || !response.body) {
      throw new PocketTransportHttpError(
        `stream ${jobId} -> ${response.status}`,
        response.status,
        ""
      );
    }
    const reader = response.body.getReader();
    try {
      let offset = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const start = offset;
        offset += value.byteLength;
        if (offset <= after) continue; // entirely below the resume point
        const event: JobEvent = {
          jobId,
          seq: offset,
          eventId: `chunk:${start}-${offset}`,
          type: "provider_chunk",
          createdAt: new Date().toISOString(),
          payload: {
            encoding: "base64",
            byteOffset: start,
            data: BufferCompat.fromBytes(value)
          }
        };
        yield event;
      }
    } finally {
      reader.releaseLock();
    }
  }

  public async cancelJob(jobId: string, _reason = "Cancelled by client"): Promise<JobSnapshot> {
    // Stock DELETE handles both abort (running) and delete (terminal); the
    // bridge adds no cancel endpoint because stock already covers it and the
    // per-instance principal owns every row in this server's database.
    await this.request(`/api/model-jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
    return this.getJob(jobId);
  }

  public async readResult(jobId: string): Promise<JobResult> {
    const bridge = this.bridgeInfo();
    if (!bridge?.typedResult) {
      throw new PocketTransportUnavailableError(
        "PocketRisu 1.10.0 (unpatched) has no result endpoint with a hash; consume the journal via streamEvents"
      );
    }
    // The receipt carries the journal sha256 the server computed; the bytes
    // themselves stay on the journal stream (streamEvents), never copied here.
    const receipt = await this.request<BridgeResultReceipt>(
      `${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}/result`,
      { method: "GET" }
    );
    return {
      jobId: receipt.jobId,
      resultHash: receipt.resultHash,
      payload: {
        kind: "journal-ref",
        status: receipt.status,
        bytes: receipt.bytes,
        contentType: receipt.contentType,
        upstreamStatus: receipt.upstreamStatus,
        generationId: receipt.generationId,
        error: receipt.error
      },
      finishReason: receipt.status === "done" ? "stop" : "error"
    };
  }

  public async acquireDeliveryLease(jobId: string): Promise<DeliveryLease> {
    if (!this.bridgeInfo()?.deliveryLease) {
      throw new PocketTransportUnavailableError(
        "PocketRisu 1.10.0 (unpatched) has no delivery lease protocol; requires the risu-bg-bridge v1 patch"
      );
    }
    return this.request<DeliveryLease>(`${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}/lease`, {
      method: "POST",
      body: JSON.stringify({ ownerClientId: this.ownerClientId })
    });
  }

  public async renewDeliveryLease(jobId: string, leaseId: string): Promise<DeliveryLease> {
    if (!this.bridgeInfo()?.deliveryLease) {
      throw new PocketTransportUnavailableError(
        "PocketRisu 1.10.0 (unpatched) has no delivery lease protocol; requires the risu-bg-bridge v1 patch"
      );
    }
    return this.request<DeliveryLease>(
      `${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}/lease/${encodeURIComponent(leaseId)}/renew`,
      { method: "POST", body: JSON.stringify({ ownerClientId: this.ownerClientId }) }
    );
  }

  /**
   * Finalization proof seam (patch-backed): the server verifies the lease +
   * fencing token, verifies the optional resultHash against the journal it
   * hashed itself, and durably records the client-asserted materialization
   * fields (messageId, chatRevision, persistedAt) plus the row's own
   * generationId. Chat storage is unreachable from the job relay, so this is
   * the seam — materialization remains client-side and the capability stays
   * durableFinalization: false. Server refusals (expired lease, stale token,
   * hash mismatch) surface as PocketTransportHttpError, never as success.
   */
  public async finalize(jobId: string, req: FinalizeRequest): Promise<FinalizeResult> {
    if (typeof this.bridgeInfo()?.finalizeProof !== "string") {
      throw new PocketTransportUnavailableError(
        "PocketRisu 1.10.0 (unpatched) has no finalization seam; materialize client-side"
      );
    }
    const result = await this.request<{
      jobId: string;
      status: "completed" | "failed";
      resultHash?: string;
      finalizedAt?: string;
      replayed?: boolean;
      error?: string;
    }>(`${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}/finalize`, {
      method: "POST",
      body: JSON.stringify({
        leaseId: req.leaseId,
        fencingToken: req.fencingToken,
        materializationProof: req.materializationProof
      })
    });
    return { jobId: result.jobId, status: result.status, error: result.error };
  }

  public async ackResult(
    jobId: string,
    consumerId: string,
    resultHash: string,
    consumerGroup?: string
  ): Promise<void> {
    if (!this.bridgeInfo()?.auxAck) {
      throw new PocketTransportUnavailableError(
        "PocketRisu 1.10.0 (unpatched) has no result ACK protocol; requires the risu-bg-bridge v1 patch"
      );
    }
    // The server verifies the provided hash against the journal before
    // recording the ACK — an ACK is a claim the consumer really consumed
    // THIS result, and a wrong hash is a 409.
    await this.request<{ success: boolean; duplicate: boolean }>(
      `${BRIDGE_BASE}/jobs/${encodeURIComponent(jobId)}/ack`,
      {
        method: "POST",
        body: JSON.stringify({ consumerId, consumerGroup, resultHash })
      }
    );
  }
}

/** Minimal base64 helper that works without Node Buffer (plugin context). */
const BufferCompat = {
  fromBytes(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(bytes).toString("base64");
    return b64;
  }
};