import { BackgroundCapabilities } from "../../src/contract/index.js";

/**
 * Capability negotiation (design §5): before creating any job the client
 * asks the target what it actually supports, and every unknown answer is
 * treated as "not available". Negotiation is fail-closed by construction:
 *
 *   - transport errors, non-200 responses, malformed JSON → unavailable
 *   - a response that is not a *strictly valid* BackgroundCapabilities
 *     object (contractVersion must be 1, all ten feature flags present and
 *     boolean, pipelineVersion/adapter typed) → unavailable
 *   - the caller then falls back to the stock foreground path — an upgraded
 *     code path may never be unlocked by a response we could not prove.
 */

export const FEATURE_KEYS = [
  "tabCloseDurable",
  "restartRecovery",
  "eventReplay",
  "mainJobs",
  "auxJobs",
  "toolWorkflows",
  "deliveryLease",
  "durableFinalization",
  "serverProviders",
  "browserProviderPersistence"
] as const;

export const CAPABILITIES_PATH = "/api/risu-bg-bridge/v1/capabilities";

/** Strict validator: unknown shapes are never capabilities. */
export function isBackgroundCapabilities(value: unknown): value is BackgroundCapabilities {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.contractVersion !== 1) return false;
  if (typeof v.pipelineVersion !== "string") return false;
  const features = v.features;
  if (features === null || typeof features !== "object" || Array.isArray(features)) return false;
  const f = features as Record<string, unknown>;
  for (const key of FEATURE_KEYS) {
    if (typeof f[key] !== "boolean") return false;
  }
  const featureKeys = Object.keys(f);
  if (featureKeys.length !== FEATURE_KEYS.length) return false;
  const adapter = v.adapter;
  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) return false;
  const a = adapter as Record<string, unknown>;
  if (typeof a.target !== "string") return false;
  if (a.target !== "vanilla" && a.target !== "haejeok" && a.target !== "pocket") return false;
  if (typeof a.version !== "string") return false;
  return true;
}

export interface NegotiationResult {
  available: boolean;
  /** Present only when available; the all-false stock matrix otherwise. */
  capabilities: BackgroundCapabilities;
  source: "bridge" | "http";
  /** Human-readable failure reason when not available. */
  reason?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Probes a patched server (risu-bg-bridge v1) over HTTP. Any failure —
 * network, status, shape — collapses to { available: false }.
 */
export async function probeHttpCapabilities(
  fetchImpl: FetchLike,
  baseUrl: string,
  opts: { timeoutMs?: number } = {}
): Promise<NegotiationResult> {
  const url = `${baseUrl.replace(/\/+$/, "")}${CAPABILITIES_PATH}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
      credentials: "include"
    });
    if (response.status !== 200) {
      return {
        available: false,
        capabilities: STOCK_UNAVAILABLE,
        source: "http",
        reason: `capabilities endpoint answered ${response.status}`
      };
    }
    const body: unknown = await response.json();
    if (!isBackgroundCapabilities(body)) {
      return {
        available: false,
        capabilities: STOCK_UNAVAILABLE,
        source: "http",
        reason: "capabilities response failed strict validation"
      };
    }
    return { available: true, capabilities: body, source: "http" };
  } catch (err) {
    return {
      available: false,
      capabilities: STOCK_UNAVAILABLE,
      source: "http",
      reason: `capabilities probe failed: ${(err as Error).message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface BridgeLike {
  getCapabilities?: () => Promise<BackgroundCapabilities>;
}

/**
 * Negotiates against the host-provided backgroundModels object (design §4:
 * the plugin's public surface is that object, not raw HTTP). Objects whose
 * getCapabilities result fails strict validation are treated as unavailable.
 */
export async function probeHostBridge(
  bridge: BridgeLike | undefined | null
): Promise<NegotiationResult> {
  if (bridge === null || bridge === undefined || typeof bridge.getCapabilities !== "function") {
    return {
      available: false,
      capabilities: STOCK_UNAVAILABLE,
      source: "bridge",
      reason: "host does not expose a backgroundModels bridge"
    };
  }
  try {
    const caps = await bridge.getCapabilities();
    if (!isBackgroundCapabilities(caps)) {
      return {
        available: false,
        capabilities: STOCK_UNAVAILABLE,
        source: "bridge",
        reason: "bridge capabilities failed strict validation"
      };
    }
    return { available: true, capabilities: caps, source: "bridge" };
  } catch (err) {
    return {
      available: false,
      capabilities: STOCK_UNAVAILABLE,
      source: "bridge",
      reason: `bridge getCapabilities threw: ${(err as Error).message}`
    };
  }
}

/**
 * Stock matrix returned while nothing is available. Identical semantics to
 * adapters/vanilla/foregroundAdapter.ts VANILLA_FOREGROUND_CAPABILITIES;
 * duplicated as a literal so this module has no dependency on adapter code.
 */
export const STOCK_UNAVAILABLE: BackgroundCapabilities = {
  contractVersion: 1,
  features: {
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
  adapter: { target: "vanilla", version: "stock-runLLMModel" }
};