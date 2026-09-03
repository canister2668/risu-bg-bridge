import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundCapabilities } from "../src/contract/types.js";
import {
  CAPABILITIES_PATH,
  FEATURE_KEYS,
  isBackgroundCapabilities,
  probeHostBridge,
  probeHttpCapabilities,
  STOCK_UNAVAILABLE,
  FetchLike
} from "../plugin/src/negotiation.js";

const FULL_FEATURES = {
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
};

const VALID_CAPS: BackgroundCapabilities = {
  contractVersion: 1,
  features: { ...FULL_FEATURES },
  pipelineVersion: "pocket-send/1",
  adapter: { target: "pocket", version: "1.10.0-bgbridge" }
};

function responseLike(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

test("negotiation: the capabilities shape is validated strictly", () => {
  assert.equal(FEATURE_KEYS.length, 10);
  assert.ok(isBackgroundCapabilities(VALID_CAPS));

  // Wrong contract version.
  assert.ok(!isBackgroundCapabilities({ ...VALID_CAPS, contractVersion: 2 }));
  // Missing flag.
  const missingFlag = { ...VALID_CAPS, features: { ...FULL_FEATURES } } as any;
  delete missingFlag.features.toolWorkflows;
  assert.ok(!isBackgroundCapabilities(missingFlag));
  // Extra unknown flag — the shape must be exact, not a superset.
  assert.ok(
    !isBackgroundCapabilities({
      ...VALID_CAPS,
      features: { ...FULL_FEATURES, futureFeature: true }
    })
  );
  // Non-boolean flag.
  assert.ok(!isBackgroundCapabilities({ ...VALID_CAPS, features: { ...FULL_FEATURES, mainJobs: "yes" } }));
  // Adapter target outside the contract's target set.
  assert.ok(
    !isBackgroundCapabilities({ ...VALID_CAPS, adapter: { target: "random-target", version: "x" } })
  );
  // Missing pieces entirely.
  assert.ok(!isBackgroundCapabilities(null));
  assert.ok(!isBackgroundCapabilities("capabilities"));
  assert.ok(!isBackgroundCapabilities({ ...VALID_CAPS, pipelineVersion: 42 }));
});

test("negotiation: HTTP probe upgrades only on a provable 200 answer", async () => {
  const calls: string[] = [];
  const fetch200: FetchLike = async (url) => {
    calls.push(url);
    return responseLike(200, VALID_CAPS);
  };

  const good = await probeHttpCapabilities(fetch200, "https://risu.example/");
  assert.deepEqual(good.capabilities, VALID_CAPS);
  assert.ok(good.available);
  assert.equal(good.source, "http");
  assert.equal(calls[0], `https://risu.example${CAPABILITIES_PATH}`);

  // Non-200: unavailable.
  const notFound = await probeHttpCapabilities(async () => responseLike(404, {}), "https://risu.example/");
  assert.equal(notFound.available, false);
  assert.match(notFound.reason ?? "", /404/);
  assert.deepEqual(notFound.capabilities, STOCK_UNAVAILABLE);

  // Malformed JSON body: unavailable.
  const badJson = await probeHttpCapabilities(
    async () =>
      ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("invalid JSON");
        }
      }) as unknown as Response,
    "https://risu.example/"
  );
  assert.equal(badJson.available, false);
  assert.match(badJson.reason ?? "", /invalid JSON/);

  // A 200 that is not a valid capabilities object: unavailable, never a guess.
  const wrongShape = await probeHttpCapabilities(
    async () => responseLike(200, { hello: "world" }),
    "https://risu.example/"
  );
  assert.equal(wrongShape.available, false);
  assert.match(wrongShape.reason ?? "", /strict validation/);

  // Network failure: unavailable.
  const network = await probeHttpCapabilities(
    async () => {
      throw new Error("connection refused");
    },
    "https://risu.example/"
  );
  assert.equal(network.available, false);
  assert.match(network.reason ?? "", /connection refused/);
});

test("negotiation: host bridge probe fails closed on absence, throw, or bad shape", async () => {
  const absent = await probeHostBridge(undefined);
  assert.equal(absent.available, false);
  assert.deepEqual(absent.capabilities, STOCK_UNAVAILABLE);

  const noMethod = await probeHostBridge({} as any);
  assert.equal(noMethod.available, false);

  const throwing = await probeHostBridge({
    getCapabilities: async () => {
      throw new Error("bridge exploded");
    }
  });
  assert.equal(throwing.available, false);
  assert.match(throwing.reason ?? "", /bridge exploded/);

  const badShape = await probeHostBridge({
    getCapabilities: async () => ({ nonsense: true }) as any
  });
  assert.equal(badShape.available, false);
  assert.match(badShape.reason ?? "", /strict validation/);

  const good = await probeHostBridge({ getCapabilities: async () => VALID_CAPS });
  assert.ok(good.available);
  assert.equal(good.source, "bridge");
  assert.deepEqual(good.capabilities, VALID_CAPS);
});