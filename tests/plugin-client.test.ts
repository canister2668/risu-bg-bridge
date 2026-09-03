import test from "node:test";
import assert from "node:assert/strict";

import { CreateBackgroundJobRequest } from "../src/contract/types.js";
import { calculateFingerprint } from "../src/engine/fingerprint.js";
import { IdempotentJobRegistry } from "../src/engine/fingerprint.js";
import { InMemoryEventJournal } from "../src/engine/journal.js";
import { HostBackgroundModelsBridge } from "../src/client/hostBridge.js";
import {
  RisuBackgroundClient,
  ToolWorkflowUnsupportedError,
  NoExecutionPathError
} from "../plugin/src/client.js";
import { isAcceptableClientJobId } from "../plugin/src/uuidv7.js";
import { STOCK_UNAVAILABLE } from "../plugin/src/negotiation.js";
import { ForegroundUnavailableError, RisuaiPluginHost } from "../adapters/vanilla/foregroundAdapter.js";
import { LedgerStorage } from "../plugin/src/ledger.js";

type GenRequest = Omit<CreateBackgroundJobRequest, "clientJobId">;

function makeReq(overrides: Partial<GenRequest> = {}): GenRequest {
  return {
    kind: "main",
    providerRef: "openai",
    modelRef: "gpt-test",
    credentialRef: "provider-account://openai/default",
    payload: { messages: [{ role: "user", content: "hi" }] },
    generation: { chatId: "chat-1", characterId: "char-1", generationId: "gen-1", mode: "otherAx", expectedChatRevision: 1 },
    versioning: { contractVersion: 1, pipelineVersion: "risu-bg-test/1", pluginVersion: "0.0.0" },
    ...overrides
  };
}

function fingerprintOf(req: GenRequest): string {
  return calculateFingerprint({ ...req, clientJobId: "" } as CreateBackgroundJobRequest);
}

class MapStorage implements LedgerStorage {
  map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  ledgerEntry(fp: string): any {
    const raw = this.map.get(`risu-bg-ledger:${fp}`);
    return raw ? JSON.parse(raw) : undefined;
  }
}

const DURABLE_CAPS = {
  contractVersion: 1,
  features: {
    tabCloseDurable: true,
    restartRecovery: false,
    eventReplay: true,
    mainJobs: true,
    auxJobs: true,
    toolWorkflows: false,
    deliveryLease: false,
    durableFinalization: false,
    serverProviders: false,
    browserProviderPersistence: false
  },
  pipelineVersion: "durable-test/1",
  adapter: { target: "pocket", version: "1.10.0-bgbridge" }
};

function makeBridge(caps: any = DURABLE_CAPS): HostBackgroundModelsBridge {
  return new HostBackgroundModelsBridge(
    "principal-1",
    "client-1",
    caps,
    new IdempotentJobRegistry(),
    new InMemoryEventJournal()
  );
}

test("client: durable path when the host bridge negotiates main jobs", async () => {
  const storage = new MapStorage();
  const bridge = makeBridge();
  const client = new RisuBackgroundClient({ hostBridge: bridge, storage, now: () => 1_700_000_000_000 });

  const out = await client.generate(makeReq());
  assert.equal(out.strategy, "durable");
  assert.equal(out.snapshot.state, "reserved");
  assert.ok(isAcceptableClientJobId(out.snapshot.jobId));
  assert.equal(out.capabilities.features.mainJobs, true);

  // The ledger recorded submission for THIS request's fingerprint.
  const entry = storage.ledgerEntry(fingerprintOf(makeReq()));
  assert.equal(entry?.stage, "submitted");
  assert.equal(entry?.serverState, "reserved");
});

test("client: a retried request reuses the same clientJobId (client-side idempotency)", async () => {
  const bridge = makeBridge();
  const client = new RisuBackgroundClient({ hostBridge: bridge, storage: null, now: () => 1_700_000_000_000 });

  const first = await client.generate(makeReq());
  const second = await client.generate(makeReq());
  assert.equal(first.strategy, "durable");
  assert.equal(second.strategy, "durable");
  assert.equal(second.snapshot.jobId, first.snapshot.jobId, "same fingerprint must reuse the id");
  // And the server side saw exactly one job.
  const jobs = await bridge.listJobs();
  assert.equal(jobs.length, 1);
});

test("client: foreground fallback through Risuai.runLLMModel when nothing durable answers", async () => {
  const storage = new MapStorage();
  let captured: unknown = null;
  const host: RisuaiPluginHost = {
    runLLMModel: async (arg) => {
      captured = arg;
      return { result: "stock answer" };
    }
  };
  const client = new RisuBackgroundClient({ host, storage, now: () => 1_700_000_000_000 });

  const out = await client.generate(makeReq());
  assert.equal(out.strategy, "foreground");
  assert.equal(out.text, "stock answer");
  assert.ok(isAcceptableClientJobId(out.clientJobId));
  assert.deepEqual(out.capabilities, STOCK_UNAVAILABLE);
  assert.ok(out.reason, "the outcome must say why it fell back");

  // The stock call shape is exactly runLLMModel({messages, mode, allowPlugins}).
  assert.deepEqual(captured, {
    messages: [{ role: "user", content: "hi" }],
    mode: "otherAx",
    allowPlugins: true
  });

  const entry = storage.ledgerEntry(fingerprintOf(makeReq()));
  assert.equal(entry?.stage, "foreground-completed");
});

test("client: runLLMModel result shapes normalize and unknown shapes fail closed", async () => {
  const shapes: Array<[unknown, string]> = [
    ["plain string", "plain string"],
    [{ result: "from-result" }, "from-result"],
    [{ content: "from-content" }, "from-content"],
    [{ text: "from-text" }, "from-text"]
  ];
  for (const [raw, expected] of shapes) {
    const host: RisuaiPluginHost = { runLLMModel: async () => raw };
    const client = new RisuBackgroundClient({ host, now: () => 1 });
    const out = await client.generate(makeReq());
    assert.equal(out.strategy, "foreground");
    assert.equal(out.text, expected);
  }

  const badHost: RisuaiPluginHost = { runLLMModel: async () => ({ unexpected: true }) };
  const client = new RisuBackgroundClient({ host: badHost, now: () => 1 });
  await assert.rejects(() => client.generate(makeReq()), ForegroundUnavailableError);

  const noPayloadHost: RisuaiPluginHost = { runLLMModel: async () => "text" };
  const noPayloadClient = new RisuBackgroundClient({ host: noPayloadHost, now: () => 1 });
  await assert.rejects(
    () => noPayloadClient.generate(makeReq({ payload: {} })),
    (err: unknown) => err instanceof ForegroundUnavailableError && /messages must be an array/.test(err.message)
  );

  const noMethodHost = {} as RisuaiPluginHost;
  await assert.rejects(
    () => new RisuBackgroundClient({ host: noMethodHost, now: () => 1 }).generate(makeReq()),
    ForegroundUnavailableError
  );
});

test("client: a failing foreground fallback records the failure in the ledger", async () => {
  const storage = new MapStorage();
  const host: RisuaiPluginHost = {
    runLLMModel: async () => {
      throw new Error("model down");
    }
  };
  const client = new RisuBackgroundClient({ host, storage, now: () => 1_700_000_000_000 });

  await assert.rejects(() => client.generate(makeReq()), /model down/);
  const entry = storage.ledgerEntry(fingerprintOf(makeReq()));
  assert.equal(entry?.stage, "foreground-failed");
  assert.equal(entry?.error, "model down");
});

test("client: tool-workflow requests are refused, never silently degraded", async () => {
  // Durable bridge without tool support.
  const withBridge = new RisuBackgroundClient({
    hostBridge: makeBridge(),
    now: () => 1
  });
  await assert.rejects(() => withBridge.generate(makeReq({ kind: "tool-workflow" })), ToolWorkflowUnsupportedError);
  // ...and against a stock host with no bridge at all.
  const stock = new RisuBackgroundClient({
    host: { runLLMModel: async () => "should not run" },
    now: () => 1
  });
  await assert.rejects(() => stock.generate(makeReq({ kind: "tool-workflow" })), ToolWorkflowUnsupportedError);
});

test("client: no bridge and no host leaves no execution path", async () => {
  const client = new RisuBackgroundClient({ now: () => 1 });
  await assert.rejects(() => client.generate(makeReq()), NoExecutionPathError);
});

test("client: an available bridge without mainJobs still cannot take the durable path", async () => {
  const capsNoMain = {
    ...DURABLE_CAPS,
    features: { ...DURABLE_CAPS.features, mainJobs: false }
  };
  const client = new RisuBackgroundClient({
    hostBridge: makeBridge(capsNoMain),
    now: () => 1
  });
  await assert.rejects(
    () => client.generate(makeReq()),
    (err: unknown) => err instanceof NoExecutionPathError && /main jobs/.test(err.message)
  );
});

test("client: negotiation is cached for the TTL and the bridge outranks HTTP", async () => {
  let fetchCalls = 0;
  const fetch404 = async () => {
    fetchCalls++;
    return { status: 404, ok: false, json: async () => ({}) } as unknown as Response;
  };

  let clock = 1_000;
  const client = new RisuBackgroundClient({
    fetchImpl: fetch404,
    baseUrl: "https://risu.example/",
    negotiationTtlMs: 60_000,
    now: () => clock
  });

  const first = await client.negotiate();
  assert.equal(first.available, false);
  assert.equal(fetchCalls, 1);

  await client.negotiate(); // cached
  assert.equal(fetchCalls, 1);

  await client.negotiate(true); // forced
  assert.equal(fetchCalls, 2);

  clock += 60_001; // TTL expired
  await client.negotiate();
  assert.equal(fetchCalls, 3);

  // A valid host bridge short-circuits: HTTP is never probed.
  const bridged = new RisuBackgroundClient({
    hostBridge: makeBridge(),
    fetchImpl: fetch404,
    baseUrl: "https://risu.example/",
    negotiationTtlMs: 0,
    now: () => clock
  });
  const viaBridge = await bridged.negotiate(true);
  assert.equal(viaBridge.available, true);
  assert.equal(viaBridge.source, "bridge");
  assert.equal(fetchCalls, 3);
});

test("client: stockCapabilities() reports the all-absent matrix", () => {
  assert.deepEqual(RisuBackgroundClient.stockCapabilities(), STOCK_UNAVAILABLE);
  assert.equal(RisuBackgroundClient.stockCapabilities().pipelineVersion, "foreground/stock");
});