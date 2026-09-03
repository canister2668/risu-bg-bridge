import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { CreateBackgroundJobRequest } from "../src/contract/types.js";
import {
  Pocket110Adapter,
  PocketModelJobsUnsupportedError,
  PocketInvalidPayloadError,
  POCKET_1_10_0_CAPABILITIES
} from "../adapters/pocket/adapter.js";
import { probeHttpCapabilities } from "../plugin/src/negotiation.js";
import { loadYamlFile } from "../scripts/lib/miniyaml.mjs";
import { kitRoot } from "./kit-cache-utils.js";

const adapter = new Pocket110Adapter();

const CLIENT_JOB_ID = "018f6b2c-4a1b-7c3d-9e2f-3a4b5c6d7e8f"; // UUIDv7-shaped

function makeReq(overrides: Partial<CreateBackgroundJobRequest> = {}): CreateBackgroundJobRequest {
  return {
    clientJobId: CLIENT_JOB_ID,
    kind: "main",
    providerRef: "openai",
    modelRef: "gpt-test",
    credentialRef: "provider-account://openai/default",
    payload: {
      targetUrl: "https://provider.example/v1/chat/completions",
      method: "POST",
      headers: { Authorization: "Bearer secret-stays-client-side" },
      body: JSON.stringify({ model: "gpt-test", messages: [] }),
      streaming: false,
      timeoutMs: 30000
    },
    generation: { chatId: "chat-1", characterId: "char-1", generationId: "gen-1", mode: "otherAx", expectedChatRevision: 1 },
    versioning: { contractVersion: 1, pipelineVersion: "risu-bg-test/1", pluginVersion: "0.0.0" },
    ...overrides
  };
}

test("pocket-adapter: capability matrix reports exactly what the patched 1.10.0 target does", () => {
  const caps = adapter.getCapabilities();
  assert.deepEqual(caps, POCKET_1_10_0_CAPABILITIES);
  assert.deepEqual(
    caps.features,
    {
      tabCloseDurable: true,
      restartRecovery: false,
      eventReplay: true,
      mainJobs: true,
      auxJobs: true,
      toolWorkflows: false,
      deliveryLease: true, // patch-backed since series step pocket-102
      durableFinalization: false, // finalize proof seam only; materialization stays client-side
      serverProviders: false,
      browserProviderPersistence: false
    }
  );
  assert.equal(caps.contractVersion, 1);
  assert.equal(caps.pipelineVersion, "pocket-send/1");
  assert.deepEqual(caps.adapter, { target: "pocket", version: "1.10.0-bgbridge" });
});

test("pocket-adapter: bridge extension block names exactly what the series installs", () => {
  const bridge = POCKET_1_10_0_CAPABILITIES.bridge;
  assert.equal(bridge.version, 1);
  assert.deepEqual(
    bridge,
    {
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
  );
  // The two headline honest-negatives must stay: no secret-persisting
  // restart recovery, no server-side materialization ledger.
  assert.equal(bridge.restartRecovery, "fail-closed-no-secret-persistence");
  assert.ok(bridge.finalizeProof.startsWith("client-asserted-"));
});

test("pocket-adapter: mapClientRequest produces the verified POST /api/model-jobs body", () => {
  const body = adapter.mapClientRequest(CLIENT_JOB_ID, makeReq());
  assert.deepEqual(body, {
    id: CLIENT_JOB_ID,
    targetUrl: "https://provider.example/v1/chat/completions",
    method: "POST",
    headers: { Authorization: "Bearer secret-stays-client-side" },
    body: JSON.stringify({ model: "gpt-test", messages: [] }),
    chatId: "chat-1",
    generationId: "gen-1",
    adapterKind: "risu-bg-extension",
    model: "gpt-test",
    kind: "main",
    streaming: false,
    timeoutMs: 30000
  });

  // Credential identity must never ride the transport: 1.10.0 relays
  // client-supplied headers, so credentialRef/Epoch stay client-side.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("credentialRef"));
  assert.ok(!serialized.includes("credentialEpoch"));
  assert.ok(!("credentialRef" in body));
});

test("pocket-adapter: kind mapping — aux stays aux, main/background map to main", () => {
  assert.equal(adapter.mapClientRequest(CLIENT_JOB_ID, makeReq({ kind: "aux" })).kind, "aux");
  assert.equal(adapter.mapClientRequest(CLIENT_JOB_ID, makeReq()).kind, "main");
});

test("pocket-adapter: refuses everything the locked transport cannot express", () => {
  // No tool-workflow transport in 1.10.0 — refuse instead of degrading.
  assert.throws(
    () => adapter.mapClientRequest(CLIENT_JOB_ID, makeReq({ kind: "tool-workflow" })),
    PocketModelJobsUnsupportedError
  );

  // The server validates ids with a UUID regex and answers 400 otherwise;
  // refuse locally with a clear error instead.
  assert.throws(
    () => adapter.mapClientRequest("not-a-uuid", makeReq()),
    PocketInvalidPayloadError
  );

  // No targetUrl: 1.10.0 model-jobs is a provider relay, not a semantic API.
  assert.throws(
    () => adapter.mapClientRequest(CLIENT_JOB_ID, makeReq({ payload: { method: "POST" } })),
    PocketInvalidPayloadError
  );

  // Non-string body: the server rejects those with 400 (verified in
  // model-jobs.cjs) — refuse early.
  assert.throws(
    () => adapter.mapClientRequest(CLIENT_JOB_ID, makeReq({ payload: { targetUrl: "https://x.example/", body: { object: true } } })),
    PocketInvalidPayloadError
  );
});

test("pocket-adapter: no durable finalization — handleFinalization must not pretend", async () => {
  const job = {
    identity: { principalId: "p1", clientJobId: CLIENT_JOB_ID, requestFingerprint: "f" }
  } as any;
  await assert.rejects(
    () => adapter.handleFinalization(job, {}),
    PocketModelJobsUnsupportedError
  );
});

test("pocket-adapter: the capabilities served by the patched server equal the adapter matrix", async () => {
  // series.yaml step pocket-002 registers GET /api/risu-bg-bridge/v1/capabilities
  // on the 1.10.0 server. The matrix it serves and the matrix this adapter
  // reports are two independent declarations of the same facts — if they ever
  // disagree, one of them is a lie and this test finds it.
  const series = await loadYamlFile(fs, path.join(kitRoot, "adapters", "pocket", "series.yaml"));
  const step = (series.steps as Array<Record<string, any>>).find((s) => s.id === "pocket-002");
  assert.ok(step, "series must keep the pocket-002 capabilities step");
  const content = step.content as string;
  assert.ok(content.includes("'/api/risu-bg-bridge/v1/capabilities'"));

  for (const [flag, value] of Object.entries(POCKET_1_10_0_CAPABILITIES.features)) {
    assert.ok(
      content.includes(`${flag}: ${value}`),
      `series pocket-002 content must serve ${flag}: ${value}`
    );
  }
  assert.ok(content.includes(`pipelineVersion: '${POCKET_1_10_0_CAPABILITIES.pipelineVersion}'`));
  assert.ok(content.includes("targetVersion: '1.10.0'"));

  // The adapter block the strict validator requires (round-1's served matrix
  // lacked adapter.target/version and failed isBackgroundCapabilities).
  assert.ok(content.includes("target: 'pocket'"));
  assert.ok(content.includes("version: '1.10.0-bgbridge'"));

  // Bridge parity: every extension field the adapter declares must be served
  // verbatim by the patched server. Booleans render bare, strings quoted.
  const bridge = POCKET_1_10_0_CAPABILITIES.bridge;
  for (const [key, value] of Object.entries(bridge) as Array<[string, string | number | boolean]>) {
    const rendered = typeof value === "string" ? `${key}: '${value}'` : `${key}: ${value}`;
    assert.ok(
      content.includes(rendered),
      `series pocket-002 bridge block must serve ${rendered}`
    );
  }
});

test("pocket-adapter: the patched-server response passes strict capability validation", async () => {
  // The exact object shape the patched server serves (features + adapter +
  // bridge) must survive probeHttpCapabilities' strict validator. This is the
  // regression test for the round-1 defect where the served matrix lacked
  // adapter.target/version and every probe of a patched server reported
  // "unavailable".
  const served = JSON.parse(JSON.stringify(POCKET_1_10_0_CAPABILITIES));
  const probe = await probeHttpCapabilities(
    async () => ({ ok: true, status: 200, json: async () => served } as unknown as Response),
    "https://pocket.example"
  );
  assert.equal(probe.available, true, `probe must accept the patched matrix: ${probe.reason ?? ""}`);
  assert.equal(probe.source, "http");
  assert.deepEqual(probe.capabilities, POCKET_1_10_0_CAPABILITIES);

  // A bridge-less response (stock-shaped, e.g. a future unpatched variant)
  // is still strictly valid — the transport's gating decides what to use.
  const noBridge = JSON.parse(JSON.stringify(POCKET_1_10_0_CAPABILITIES));
  delete (noBridge as Record<string, unknown>).bridge;
  const probe2 = await probeHttpCapabilities(
    async () => ({ ok: true, status: 200, json: async () => noBridge } as unknown as Response),
    "https://pocket.example"
  );
  assert.equal(probe2.available, true);
});