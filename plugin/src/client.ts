import {
  BackgroundCapabilities,
  CreateBackgroundJobRequest,
  JobSnapshot
} from "../../src/contract/index.js";
import { BackgroundModelsApi } from "../../src/client/hostBridge.js";
import { calculateFingerprint } from "../../src/engine/fingerprint.js";
import {
  RisuaiPluginHost,
  runForegroundGeneration,
  VanillaForegroundAdapter
} from "../../adapters/vanilla/foregroundAdapter.js";
import { ClientJobLedger, LedgerStorage } from "./ledger.js";
import { NegotiationResult, probeHostBridge, probeHttpCapabilities, FetchLike } from "./negotiation.js";
import { isAcceptableClientJobId, uuidv7 } from "./uuidv7.js";

/**
 * RisuBackgroundClient — the plugin-side facade from the design's Plan B:
 * ONE public client that works on every deployment flavor.
 *
 *   1. Negotiate: ask the host backgroundModels object (design §4) or the
 *      patched server's capabilities endpoint (§5) what the target supports.
 *      Any unprovable answer means "not available".
 *   2. Decide per request:
 *        - durable path: capabilities.mainJobs AND a bridge is present →
 *          create the job server-side with a client-minted UUIDv7 id and a
 *          request fingerprint (§7 PUT idempotency, both halves: server
 *          IdempotentJobRegistry + ClientJobLedger).
 *        - stock path: foreground fallback through Risuai.runLLMModel
 *          (vanilla semantics — the tab must stay open).
 *   3. Refuse what the target cannot do: a 'tool-workflow' request against a
 *      target without toolWorkflows fails loudly instead of being silently
 *      degraded into a plain generation.
 */

export interface BackgroundClientDeps {
  /** Host-provided backgroundModels bridge (authoritative when present). */
  hostBridge?: BackgroundModelsApi | null;
  /** RisuAI plugin host surface for the stock foreground fallback. */
  host?: RisuaiPluginHost;
  /** fetch implementation for HTTP negotiation / pocket transport. */
  fetchImpl?: FetchLike;
  /** Server base URL for HTTP probing (patched risu-bg-bridge v1 servers). */
  baseUrl?: string;
  /** Durable ledger storage (localStorage-shaped); null = memory only. */
  storage?: LedgerStorage | null;
  /** Negotiation cache TTL in ms; default 60s. 0 disables caching. */
  negotiationTtlMs?: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export type GenerationOutcome =
  | {
      strategy: "durable";
      snapshot: JobSnapshot;
      capabilities: BackgroundCapabilities;
    }
  | {
      strategy: "foreground";
      clientJobId: string;
      text: string;
      capabilities: BackgroundCapabilities;
      reason?: string;
    };

export class ToolWorkflowUnsupportedError extends Error {
  constructor(targetVersion: string) {
    super(
      `ToolWorkflowUnsupported: the negotiated target (${targetVersion}) has no tool-workflow transport; refusing to degrade the request to a plain generation`
    );
    this.name = "ToolWorkflowUnsupportedError";
  }
}

export class NoExecutionPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoExecutionPathError";
  }
}

const DEFAULT_TTL_MS = 60_000;

export class RisuBackgroundClient {
  private ledger: ClientJobLedger;
  private negotiation: NegotiationResult | null = null;
  private negotiatedAt = 0;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private deps: BackgroundClientDeps) {
    this.ledger = new ClientJobLedger(deps.storage ?? null);
    this.ttlMs = deps.negotiationTtlMs ?? DEFAULT_TTL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Negotiates capabilities. The host bridge is authoritative (design §4:
   * backgroundModels is the public surface); HTTP probing is the secondary
   * channel for patched Pocket servers where no host bridge exists. Both are
   * validated strictly — a response we cannot prove is treated as absent.
   * Results are cached for negotiationTtlMs; force bypasses the cache.
   */
  public async negotiate(force = false): Promise<NegotiationResult> {
    if (!force && this.negotiation && this.ttlMs > 0 && this.now() - this.negotiatedAt < this.ttlMs) {
      return this.negotiation;
    }
    let result = await probeHostBridge(this.deps.hostBridge);
    if (!result.available && this.deps.fetchImpl && this.deps.baseUrl) {
      result = await probeHttpCapabilities(this.deps.fetchImpl, this.deps.baseUrl);
    }
    this.negotiation = result;
    this.negotiatedAt = this.now();
    return result;
  }

  /**
   * Runs one generation request. `req` omits clientJobId; the client mints
   * it (UUIDv7) and binds it to the request fingerprint in the ledger, so a
   * retry after a lost response reuses the same identity (§7).
   */
  public async generate(
    req: Omit<CreateBackgroundJobRequest, "clientJobId">
  ): Promise<GenerationOutcome> {
    const negotiation = await this.negotiate();
    const capabilities = negotiation.capabilities;

    if (req.kind === "tool-workflow" && !capabilities.features.toolWorkflows) {
      throw new ToolWorkflowUnsupportedError(capabilities.adapter.version);
    }

    const fullRequest: CreateBackgroundJobRequest = {
      ...req,
      clientJobId: "" // filled from the ledger below
    };
    const fingerprint = calculateFingerprint(fullRequest);

    // Client-side idempotency: same fingerprint reuses the same id.
    let clientJobId: string;
    const existing = this.ledger.findByFingerprint(fingerprint);
    if (existing) {
      clientJobId = existing.clientJobId;
    } else {
      clientJobId = uuidv7(this.now());
      if (!isAcceptableClientJobId(clientJobId)) {
        throw new Error(`uuidv7 produced an id the transports would reject: ${clientJobId}`);
      }
      this.ledger.reserve(fingerprint, clientJobId);
    }

    const durablePossible =
      negotiation.available &&
      capabilities.features.mainJobs &&
      this.deps.hostBridge !== null &&
      this.deps.hostBridge !== undefined;

    if (durablePossible && this.deps.hostBridge) {
      const snapshot = await this.deps.hostBridge.createJob({ ...req, clientJobId });
      this.ledger.record(fingerprint, { stage: "submitted", serverState: snapshot.state });
      return { strategy: "durable", snapshot, capabilities };
    }

    if (!this.deps.host) {
      throw new NoExecutionPathError(
        `No execution path: negotiation is unavailable (${negotiation.reason ?? "no durable main jobs"}) ` +
          `and no Risuai host was provided for the foreground fallback`
      );
    }

    try {
      const text = await runForegroundGeneration(this.deps.host, { ...req, clientJobId });
      this.ledger.record(fingerprint, { stage: "foreground-completed" });
      return {
        strategy: "foreground",
        clientJobId,
        text,
        capabilities,
        reason: negotiation.reason
      };
    } catch (err) {
      this.ledger.record(fingerprint, {
        stage: "foreground-failed",
        error: (err as Error).message
      });
      throw err;
    }
  }

  /** The stock matrix reported when nothing durable is available. */
  public static stockCapabilities(): BackgroundCapabilities {
    return new VanillaForegroundAdapter().getCapabilities();
  }
}