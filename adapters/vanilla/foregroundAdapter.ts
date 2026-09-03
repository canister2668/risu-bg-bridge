import { BackgroundAdapter } from "../../src/adapters/contract.js";
import { BackgroundCapabilities, CreateBackgroundJobRequest, JobMetadata } from "../../src/contract/index.js";

/**
 * Minimal shape of the RisuAI plugin host surface this adapter relies on.
 * `Risuai.runLLMModel` is the stock plugin API (verified against the
 * workspace itemx plugin runtime): it runs one generation in the FOREGROUND
 * and resolves with the model text. It is optional at the type level
 * because the adapter must fail closed when the host is a build without it.
 */
export interface RisuaiPluginHost {
  runLLMModel?(arg: {
    messages: unknown[];
    mode?: string;
    allowPlugins?: boolean;
  }): Promise<unknown>;
}

/** All-durable-features-absent matrix for stock RisuAI (vanilla) hosts. */
export const VANILLA_FOREGROUND_CAPABILITIES: BackgroundCapabilities = {
  contractVersion: 1,
  features: {
    // Stock fallback runs in the foreground only: the tab must stay open,
    // nothing survives a restart, there is no server-side job store,
    // journal, lease, or finalizer. Every flag that would imply server-side
    // durability is false.
    tabCloseDurable: false,
    restartRecovery: false,
    eventReplay: false,
    mainJobs: false,
    auxJobs: false,
    toolWorkflows: false,
    deliveryLease: false,
    durableFinalization: false,
    serverProviders: false,
    browserProviderPersistence: false
  },
  pipelineVersion: "foreground/stock",
  adapter: {
    target: "vanilla",
    version: "stock-runLLMModel"
  }
};

export class ForegroundUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForegroundUnavailableError";
  }
}

/**
 * Normalizes the observed runLLMModel result shapes to plain text:
 * string, {result}, {content}, or {text} (verified in the itemx plugin
 * runtime's modelText normalization). Anything else is an error — the
 * fallback never invents content it did not receive.
 */
export function normalizeForegroundResult(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw !== null && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (typeof record.result === "string") return record.result;
    if (typeof record.content === "string") return record.content;
    if (typeof record.text === "string") return record.text;
  }
  throw new ForegroundUnavailableError(
    `runLLMModel returned an unrecognized shape: ${Object.prototype.toString.call(raw)}`
  );
}

/**
 * Stock foreground fallback: run one generation through the host's
 * runLLMModel and return its text. This is the entire vanilla "background"
 * strategy — there is no server to talk to, so the call is synchronous from
 * the chat's point of view and dies with the tab.
 *
 * Fails closed with ForegroundUnavailableError when the host does not expose
 * runLLMModel or returns a shape the normalizer cannot prove.
 */
export async function runForegroundGeneration(
  host: RisuaiPluginHost,
  req: CreateBackgroundJobRequest
): Promise<string> {
  if (typeof host.runLLMModel !== "function") {
    throw new ForegroundUnavailableError(
      "Risuai.runLLMModel is not available on this host; stock foreground fallback cannot run"
    );
  }
  const messages = (req.payload as Record<string, unknown> | undefined)?.messages;
  if (!Array.isArray(messages)) {
    throw new ForegroundUnavailableError(
      "payload.messages must be an array for the foreground fallback"
    );
  }
  const raw = await host.runLLMModel({ messages, mode: "otherAx", allowPlugins: true });
  return normalizeForegroundResult(raw);
}

/**
 * Adapter record for vanilla RisuAI. It exists so capability negotiation has
 * something truthful to report when no server bridge answers: every durable
 * feature is absent, and the only execution path is the foreground fallback
 * above. There is intentionally no series.yaml/Dockerfile for this target —
 * targets/vanilla.declared.yaml records why no vanilla source is (or can
 * be) verified on this host.
 */
export class VanillaForegroundAdapter implements BackgroundAdapter {
  public readonly target = "vanilla" as const;

  public getCapabilities(): BackgroundCapabilities {
    return VANILLA_FOREGROUND_CAPABILITIES;
  }

  public mapClientRequest(_clientJobId: string, _req: CreateBackgroundJobRequest): never {
    throw new ForegroundUnavailableError(
      "Vanilla stock fallback has no server transport; mapClientRequest is not applicable"
    );
  }

  public async handleFinalization(_job: JobMetadata, _proof: unknown): Promise<never> {
    throw new ForegroundUnavailableError(
      "Vanilla stock fallback has no durable finalization; materialization happens inline with generation"
    );
  }
}