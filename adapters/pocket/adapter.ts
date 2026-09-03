import { BackgroundAdapter } from "../../src/adapters/contract.js";
import { BackgroundCapabilities, CreateBackgroundJobRequest, JobMetadata } from "../../src/contract/index.js";

/**
 * Transport payload the Pocket 1.10.0 adapter expects on
 * CreateBackgroundJobRequest.payload. PocketRisu's model-jobs API is a raw
 * provider relay: the server re-issues an HTTP request to `targetUrl` and
 * journals the response bytes. The adapter therefore maps the client job to
 * that relay shape instead of inventing a semantic job API.
 *
 * Verified against the locked 1.10.0 source (targets/pocket.lock.yaml):
 * POST /api/model-jobs accepts exactly { id, targetUrl, method, headers,
 * body, chatId, generationId, adapterKind, model, kind, streaming, timeoutMs }.
 * The bridge v1 surface added by this kit's patch series additionally accepts
 * PUT /api/risu-bg-bridge/v1/jobs/:id with the same body shape (idempotent
 * create-or-replay keyed on a canonical request fingerprint).
 */
export interface PocketTransportPayload {
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  /** Must be a string; the server rejects non-string bodies with 400. */
  body?: string;
  streaming?: boolean;
  timeoutMs?: number;
}

/** POST /api/model-jobs (and bridge PUT) request body, byte-faithful to the locked source. */
export interface PocketModelJobCreate {
  id: string;
  targetUrl: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  chatId: string;
  generationId?: string;
  adapterKind?: string;
  model?: string;
  kind: "main" | "background" | "aux";
  streaming: boolean;
  timeoutMs?: number;
}

/**
 * Bridge v1 extension block served by the PATCHED 1.10.0 server
 * (series steps pocket-002..pocket-104) next to the standard feature matrix.
 *
 * This is a kit extension, not part of the common BackgroundCapabilities
 * contract: the strict validator (plugin/src/negotiation.ts) ignores extra
 * top-level keys, and every field here names a feature the patch series
 * actually installs — nothing is advertised that a step does not create.
 */
export interface PocketBridgeExtension {
  version: 1;
  /** PUT /jobs/:id create-or-replay with 409 on fingerprint conflict. */
  putIdempotency: boolean;
  /** Canonicalization scheme for the PUT fingerprint. */
  requestFingerprint: "sha256-canonical-json";
  /** All bridge rows are scoped to one authenticated host principal. */
  principalScoping: "single-host-instance";
  /** Typed journal replay with server-side afterSeq (GET /jobs/:id/events). */
  typedEvents: boolean;
  /** Typed result receipt with journal hash (GET /jobs/:id/result). */
  typedResult: boolean;
  /** Hash scheme used for results (the journal bytes ARE the result). */
  resultHash: "sha256-journal-bytes";
  /** Durable aux discovery (GET /aux/pending?consumer=). */
  auxDiscovery: boolean;
  /** Durable per-consumer ACK (POST /jobs/:id/ack). */
  auxAck: boolean;
  /** Delivery leases with monotonic fencing tokens (POST /jobs/:id/lease...). */
  deliveryLease: boolean;
  /**
   * The finalize seam: the server verifies the journal resultHash plus the
   * lease/fencing and durably records the client-asserted materialization
   * fields (messageId, chatRevision, persistedAt). Chat storage is not
   * reachable from the job relay, so materialization itself stays
   * client-side and durableFinalization stays false.
   */
  finalizeProof: "client-asserted-generationId+server-verified-resultHash";
  /**
   * Restart recovery is fail-closed: reconstructing an approved request
   * would persist the provider credentials the target deliberately keeps
   * memory-only, so boot keeps failing running jobs and a re-PUT replays
   * the failed row instead of resuming.
   */
  restartRecovery: "fail-closed-no-secret-persistence";
}

/**
 * Capability matrix for the exact PocketRisu 1.10.0 target pinned by
 * targets/pocket.lock.yaml, AS PATCHED by this kit's series
 * (adapters/pocket/series.yaml, steps pocket-001..pocket-104). The same
 * matrix — including the bridge block — is served by the patched server
 * itself at GET /api/risu-bg-bridge/v1/capabilities (step pocket-002);
 * tests/kit-pocket-adapter.test.ts asserts the two stay identical.
 *
 *   tabCloseDurable      true  — jobs and journals live server-side
 *                                (model-jobs.cjs sqlite + journal files).
 *   restartRecovery      false — boot policy stays markRunningJobsFailed
 *                                ('server restart'). Reconstructing an
 *                                approved upstream request would persist
 *                                provider credentials the target keeps
 *                                memory-only, so recovery stays fail-closed
 *                                and a re-PUT replays the failed row.
 *   eventReplay           true — journals are raw byte streams; the patched
 *                                server additionally serves typed replay
 *                                with server-side afterSeq resume
 *                                (bridge GET /jobs/:id/events).
 *   mainJobs              true — kind 'main' with per-chat single-generation
 *                                guard (409 on conflict).
 *   auxJobs               true — kind 'aux', claimable via
 *                                /api/pending-sends/:chatId/claim AND, when
 *                                bridge-created, discoverable + ackable via
 *                                bridge /aux/pending + /jobs/:id/ack.
 *   toolWorkflows        false — no tool checkpoint/replay exists in 1.10.0
 *                                and the series adds none.
 *   deliveryLease        true  — bridge /jobs/:id/lease + renew with
 *                                monotonic fencing tokens (patch-backed).
 *   durableFinalization  false — the bridge finalize endpoint records a
 *                                proof (hash-verified result + client-asserted
 *                                materialization fields), but chat
 *                                materialization is still client-side; the
 *                                flag stays false until a server-side stage
 *                                ledger exists.
 *   serverProviders      false — provider requests are relayed with
 *                                client-supplied headers; auth material is
 *                                memory-only, never a server-side provider
 *                                store. The series preserves this invariant:
 *                                only the sha256 fingerprint digest is
 *                                persisted, never the raw request.
 *   browserProviderPersistence false — no browser provider persistence.
 */
export const POCKET_1_10_0_CAPABILITIES: BackgroundCapabilities & { bridge: PocketBridgeExtension } = {
  contractVersion: 1,
  features: {
    tabCloseDurable: true,
    restartRecovery: false,
    eventReplay: true,
    mainJobs: true,
    auxJobs: true,
    toolWorkflows: false,
    deliveryLease: true,
    durableFinalization: false,
    serverProviders: false,
    browserProviderPersistence: false
  },
  pipelineVersion: "pocket-send/1",
  adapter: {
    target: "pocket",
    version: "1.10.0-bgbridge"
  },
  bridge: {
    version: 1,
    putIdempotency: true,
    requestFingerprint: "sha256-canonical-json",
    principalScoping: "single-host-instance",
    typedEvents: true,
    typedResult: true,
    resultHash: "sha256-journal-bytes",
    auxDiscovery: true,
    auxAck: true,
    deliveryLease: true,
    finalizeProof: "client-asserted-generationId+server-verified-resultHash",
    restartRecovery: "fail-closed-no-secret-persistence"
  }
};

export class PocketModelJobsUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PocketModelJobsUnsupportedError";
  }
}

export class PocketInvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PocketInvalidPayloadError";
  }
}

/**
 * Adapter for the exact PocketRisu 1.10.0 transport verified in
 * targets/cache/pocket-1.10.0-nodeonly-20260829, as patched by this kit's
 * series. Deliberately narrower than the reference fixture in
 * src/adapters/fixtures.ts: this class only claims what the locked source
 * plus the applied series actually do.
 */
export class Pocket110Adapter implements BackgroundAdapter {
  public readonly target = "pocket" as const;

  public getCapabilities(): BackgroundCapabilities & { bridge: PocketBridgeExtension } {
    return POCKET_1_10_0_CAPABILITIES;
  }

  /**
   * Maps a contract CreateBackgroundJobRequest to the POST /api/model-jobs /
   * bridge PUT /jobs/:id body verified in model-jobs.cjs. Fail-closed on
   * anything the locked transport cannot express:
   *
   *  - kind 'tool-workflow' — the target has no tool replay (toolWorkflows
   *    is false in capabilities; claiming otherwise here would be a lie).
   *  - payloads without targetUrl — the server requires a provider URL.
   *  - non-UUID clientJobId — the server validates ids with
   *    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
   *    and answers 400 otherwise; refusing early keeps the error local.
   *
   * credentialRef/credentialEpoch are intentionally NOT forwarded: 1.10.0
   * keeps auth material memory-only and relays client-supplied headers, so
   * credentials stay client-side inside `payload.headers`. The bridge PUT
   * fingerprint is computed SERVER-side over the mapped body, so the
   * credential identity is covered without it ever being persisted.
   */
  public mapClientRequest(clientJobId: string, req: CreateBackgroundJobRequest): PocketModelJobCreate {
    if (req.kind === "tool-workflow") {
      throw new PocketModelJobsUnsupportedError(
        "PocketRisu 1.10.0 has no tool-workflow transport (toolWorkflows: false); refusing to map"
      );
    }

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientJobId)) {
      throw new PocketInvalidPayloadError(
        `clientJobId '${clientJobId}' is not a UUID; the 1.10.0 server would reject it with 400`
      );
    }

    const payload = req.payload as Partial<PocketTransportPayload> | undefined;
    if (!payload || typeof payload.targetUrl !== "string" || payload.targetUrl === "") {
      throw new PocketInvalidPayloadError(
        "payload.targetUrl is required: PocketRisu 1.10.0 model-jobs is a provider relay, not a semantic job API"
      );
    }
    if (payload.body !== undefined && payload.body !== null && typeof payload.body !== "string") {
      throw new PocketInvalidPayloadError(
        "payload.body must be a string; the 1.10.0 server rejects non-string bodies with 400"
      );
    }

    return {
      id: clientJobId,
      targetUrl: payload.targetUrl,
      method: payload.method,
      headers: payload.headers,
      body: payload.body,
      chatId: req.generation.chatId,
      generationId: req.generation.generationId,
      adapterKind: "risu-bg-extension",
      model: req.modelRef,
      kind: req.kind === "aux" ? "aux" : "main",
      streaming: payload.streaming === true,
      timeoutMs: typeof payload.timeoutMs === "number" ? payload.timeoutMs : undefined
    };
  }

  /**
   * Chat materialization is still client-side on 1.10.0: this adapter has no
   * transport handle and no server-side stage ledger to verify against, so
   * durable finalization (durableFinalization: false) is not available here
   * and this adapter must not pretend otherwise.
   *
   * The patched server DOES expose the finalize proof seam —
   * POST /api/risu-bg-bridge/v1/jobs/:id/finalize (series pocket-102),
   * reachable through PocketModelJobsTransport.finalize — which verifies the
   * journal resultHash and the lease/fencing server-side and durably records
   * the client-asserted generationId/messageId/chatRevision. That seam is
   * the transport's to call, not the adapter's; materialization proof
   * verification against chat storage remains client-side by design.
   */
  public async handleFinalization(job: JobMetadata, _proof: unknown): Promise<void> {
    throw new PocketModelJobsUnsupportedError(
      `PocketRisu 1.10.0 has no durable finalization; job '${job.identity.clientJobId}' must be materialized client-side ` +
        "(the patched bridge finalize seam is reachable via PocketModelJobsTransport.finalize, not the adapter)"
    );
  }
}