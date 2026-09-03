import test from "node:test";
import assert from "node:assert";

import {
  calculateFingerprint,
  canonicalize,
  IdempotentJobRegistry,
  ConflictError,
  CasConflictError
} from "../src/engine/fingerprint.js";
import {
  validateTransition,
  transitionJob,
  calculatePayloadHash
} from "../src/engine/stateMachine.js";
import { InMemoryEventJournal } from "../src/engine/journal.js";
import {
  DeliveryLeaseManager,
  LeaseAcquisitionConflictError,
  FencingTokenStaleError,
  JobAlreadyCompletedError,
  LeaseExpiredError,
  InvalidLeaseStateError
} from "../src/engine/lease.js";
import { RetryPolicyEngine } from "../src/engine/retry.js";
import { HostBackgroundModelsBridge } from "../src/client/hostBridge.js";
import {
  HaejeokBackgroundAdapter,
  VanillaBackgroundAdapter,
  PocketBackgroundAdapter,
  TARGET_ADAPTER_GOALS
} from "../src/adapters/fixtures.js";
import { CreateBackgroundJobRequest, JobMetadata } from "../src/contract/types.js";

function makeJob(overrides: Partial<JobMetadata> = {}): JobMetadata {
  return {
    recordVersion: 1,
    identity: { principalId: "p1", clientJobId: "c1", requestFingerprint: "f1" },
    kind: "main",
    execution: {
      providerRef: "p",
      modelRef: "m",
      credentialRef: "cr",
      requestEnvelopeRef: "re",
      attempt: 1,
      executionEpoch: 1
    },
    generation: {
      chatId: "ch1",
      characterId: "char1",
      generationId: "g1",
      mode: "adventure",
      expectedChatRevision: 1
    },
    versioning: {
      contractVersion: 1,
      jobSchemaVersion: 1,
      pipelineVersion: "p1",
      pluginVersion: "1",
      adapterVersion: "1"
    },
    recovery: {
      state: "reserved",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: false }
    },
    delivery: { deliveryState: "undelivered", fencingToken: 0n },
    audit: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ...overrides
  };
}

function makeRequest(overrides: Partial<CreateBackgroundJobRequest> = {}): CreateBackgroundJobRequest {
  return {
    clientJobId: "job-1",
    kind: "main",
    providerRef: "openai",
    modelRef: "gpt-4",
    credentialRef: "cred-1",
    credentialEpoch: "epoch-1",
    payload: { messages: ["hello"] },
    generation: {
      chatId: "chat-1",
      characterId: "char-1",
      generationId: "gen-1",
      mode: "adventure",
      expectedChatRevision: 1
    },
    versioning: { contractVersion: 1, pipelineVersion: "v1", pluginVersion: "1.0" },
    ...overrides
  };
}

test("canonicalize sorts keys but does not drop payload key/token fields", () => {
  const canonicalObj = canonicalize({
    temperature: 0.7,
    model: "gpt-4",
    Payload: {
      messages: [{ role: "user", content: "hello" }],
      key: "enter",
      token: "tool-arg"
    }
  }) as Record<string, any>;

  assert.strictEqual(canonicalObj.model, "gpt-4");
  assert.strictEqual(canonicalObj.Payload.key, "enter");
  assert.strictEqual(canonicalObj.Payload.token, "tool-arg");

  const serialized = JSON.stringify(canonicalObj);
  const expected =
    '{"Payload":{"key":"enter","messages":[{"content":"hello","role":"user"}],"token":"tool-arg"},"model":"gpt-4","temperature":0.7}';
  assert.strictEqual(serialized, expected);
});

test("fingerprint includes credentialRef, credentialEpoch, and payload tool args", () => {
  const base = makeRequest({ payload: { messages: ["hello"], key: "enter" } });
  const same = makeRequest({ payload: { key: "enter", messages: ["hello"] } });
  const differentToolKey = makeRequest({ payload: { messages: ["hello"], key: "shift" } });
  const differentEpoch = makeRequest({
    payload: { messages: ["hello"], key: "enter" },
    credentialEpoch: "epoch-2"
  });
  const differentCred = makeRequest({
    payload: { messages: ["hello"], key: "enter" },
    credentialRef: "cred-2"
  });

  const f1 = calculateFingerprint(base);
  assert.strictEqual(f1, calculateFingerprint(same));
  assert.notStrictEqual(f1, calculateFingerprint(differentToolKey));
  assert.notStrictEqual(f1, calculateFingerprint(differentEpoch));
  assert.notStrictEqual(f1, calculateFingerprint(differentCred));
  assert.strictEqual(f1.length, 64);
});

test("IdempotentJobRegistry PUT idempotency and CAS updates", () => {
  const registry = new IdempotentJobRegistry();
  const req = makeRequest({ clientJobId: "unique-job-id" });

  const res1 = registry.putJob("user-123", req);
  assert.strictEqual(res1.isNew, true);
  assert.strictEqual(res1.job.recordVersion, 1);
  assert.strictEqual(res1.job.recovery.state, "reserved");
  assert.strictEqual(res1.job.execution.credentialRef, "cred-1");
  assert.strictEqual(res1.job.execution.credentialEpoch, "epoch-1");

  const res2 = registry.putJob("user-123", req);
  assert.strictEqual(res2.isNew, false);
  assert.deepEqual(res2.job, res1.job);

  assert.throws(() => {
    registry.putJob("user-123", { ...req, modelRef: "claude-3-opus" });
  }, ConflictError);

  const queued = transitionJob(res1.job, "queued");
  const stored = registry.updateJob("user-123", "unique-job-id", 1, queued);
  assert.strictEqual(stored.recordVersion, 2);
  assert.strictEqual(stored.recovery.state, "queued");

  assert.throws(() => {
    registry.updateJob("user-123", "unique-job-id", 1, queued);
  }, CasConflictError);
});

test("Job state machine rejects ambiguous -> queued", () => {
  let job = makeJob();
  job = transitionJob(job, "queued");
  job = transitionJob(job, "running");
  job = transitionJob(job, "ambiguous");
  assert.strictEqual(validateTransition("ambiguous", "queued"), false);
  assert.throws(() => {
    transitionJob(job, "queued");
  });

  const resultData = { resultRef: "ref-1", resultHash: calculatePayloadHash("some payload") };
  job = makeJob({ recovery: { ...job.recovery, state: "running" } });
  job = transitionJob(job, "succeeded", { result: resultData });
  job = transitionJob(job, "finalizing");
  job = transitionJob(job, "completed");
  assert.throws(() => {
    transitionJob(job, "running");
  });
});

test("InMemoryEventJournal stores monotonic unique sequences", async () => {
  const journal = new InMemoryEventJournal();
  const e1 = await journal.appendEvent("test-job-id", "state", { state: "queued" });
  const e2 = await journal.appendEvent("test-job-id", "provider_chunk", "He");
  const e3 = await journal.appendEvent("test-job-id", "provider_chunk", "llo");
  assert.strictEqual(e1.seq, 1);
  assert.strictEqual(e2.seq, 2);
  assert.strictEqual(e3.seq, 3);
  const filterEvents = await journal.getEvents("test-job-id", 1);
  assert.strictEqual(filterEvents.length, 2);
});

test("Delivery lease finalize requires leaseId, owner, expiry, and finalizing state", () => {
  const initialJob = makeJob({
    result: { resultRef: "ref-1", resultHash: calculatePayloadHash("success") },
    recovery: {
      state: "succeeded",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: false }
    }
  });

  const { updatedJob: jobLeasedA, lease: leaseA } = DeliveryLeaseManager.acquireLease(
    initialJob,
    "client-A",
    10000
  );
  assert.strictEqual(jobLeasedA.recovery.state, "finalizing");
  assert.strictEqual(jobLeasedA.delivery.leaseId, leaseA.leaseId);

  assert.throws(() => {
    DeliveryLeaseManager.acquireLease(jobLeasedA, "client-B", 10000);
  }, LeaseAcquisitionConflictError);

  const { updatedJob: jobRenewed } = DeliveryLeaseManager.renewLease(
    jobLeasedA,
    leaseA.leaseId,
    1n,
    20000
  );
  assert.strictEqual(jobRenewed.delivery.fencingToken, 1n);

  assert.throws(() => {
    DeliveryLeaseManager.finalizeWithFencing(
      jobRenewed,
      leaseA.leaseId,
      0n,
      "client-A",
      { messageId: "msg1", chatRevision: 1, persistedAt: "" }
    );
  }, FencingTokenStaleError);

  assert.throws(() => {
    DeliveryLeaseManager.finalizeWithFencing(
      initialJob,
      leaseA.leaseId,
      1n,
      "client-A",
      { messageId: "msg1", chatRevision: 1, persistedAt: "" }
    );
  }, InvalidLeaseStateError);

  const expired = {
    ...jobRenewed,
    delivery: { ...jobRenewed.delivery, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }
  };
  assert.throws(() => {
    DeliveryLeaseManager.renewLease(expired, leaseA.leaseId, 1n, 20000);
  }, LeaseExpiredError);
  assert.throws(() => {
    DeliveryLeaseManager.finalizeWithFencing(
      expired,
      leaseA.leaseId,
      1n,
      "client-A",
      { messageId: "msg1", chatRevision: 1, persistedAt: "" }
    );
  }, LeaseExpiredError);

  const jobCompleted = DeliveryLeaseManager.finalizeWithFencing(
    jobRenewed,
    leaseA.leaseId,
    1n,
    "client-A",
    {
      messageId: "msg-123",
      chatRevision: 2,
      persistedAt: new Date().toISOString()
    }
  );
  assert.strictEqual(jobCompleted.recovery.state, "completed");
  assert.strictEqual(jobCompleted.delivery.deliveryState, "delivered");
  assert.throws(() => {
    DeliveryLeaseManager.acquireLease(jobCompleted, "client-A", 10000);
  }, JobAlreadyCompletedError);
});

test("RetryPolicyEngine uses send evidence instead of blindly retrying 503", () => {
  const nonIdempotent = makeJob({
    execution: {
      providerRef: "p",
      modelRef: "m",
      credentialRef: "cr",
      requestEnvelopeRef: "re",
      attempt: 1,
      executionEpoch: 1
    },
    recovery: {
      state: "running",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: false }
    }
  });

  assert.strictEqual(RetryPolicyEngine.evaluate(nonIdempotent, "CLIENT_400").action, "fail");
  assert.strictEqual(RetryPolicyEngine.evaluate(nonIdempotent, "NETWORK_TIMEOUT").action, "ambiguous");
  assert.strictEqual(
    RetryPolicyEngine.evaluate(nonIdempotent, "SERVER_503", new Date(), { requestSent: "unknown" }).action,
    "ambiguous"
  );
  assert.strictEqual(
    RetryPolicyEngine.evaluate(nonIdempotent, "SERVER_503", new Date(), { requestSent: true }).action,
    "ambiguous"
  );
  assert.strictEqual(
    RetryPolicyEngine.evaluate(nonIdempotent, "SERVER_503", new Date(), { requestSent: false }).action,
    "retry"
  );
  assert.strictEqual(
    RetryPolicyEngine.evaluate(nonIdempotent, "SERVER_503", new Date(), { definitiveRejection: true }).action,
    "fail"
  );

  const idempotent = makeJob({
    execution: { ...nonIdempotent.execution },
    recovery: {
      state: "running",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: true }
    }
  });
  assert.strictEqual(
    RetryPolicyEngine.evaluate(idempotent, "NETWORK_TIMEOUT", new Date(), { requestSent: true }).action,
    "retry"
  );

  const limited = makeJob({
    execution: { ...nonIdempotent.execution, attempt: 3 },
    recovery: {
      state: "running",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: true }
    }
  });
  assert.strictEqual(RetryPolicyEngine.evaluate(limited, "SERVER_503", new Date(), { requestSent: false }).action, "fail");
});

test("reference in-memory contract: host bridge job/lease/finalize roundtrip", async () => {
  const van = new VanillaBackgroundAdapter();
  const hj = new HaejeokBackgroundAdapter();
  const pk = new PocketBackgroundAdapter();

  assert.strictEqual(van.getCapabilities().features.tabCloseDurable, false);
  assert.strictEqual(hj.getCapabilities().features.tabCloseDurable, true);
  assert.strictEqual(hj.getCapabilities().features.restartRecovery, false);
  assert.strictEqual(hj.getCapabilities().features.toolWorkflows, false);
  assert.strictEqual(hj.getCapabilities().features.deliveryLease, false);
  assert.strictEqual(hj.getCapabilities().features.durableFinalization, false);
  assert.strictEqual(hj.getCapabilities().features.serverProviders, false);
  assert.strictEqual(hj.getCapabilities().features.eventReplay, false);
  assert.strictEqual(pk.getCapabilities().features.restartRecovery, false);
  assert.strictEqual(pk.getCapabilities().features.deliveryLease, false);
  assert.strictEqual(pk.getCapabilities().features.durableFinalization, false);
  assert.strictEqual(pk.getCapabilities().features.serverProviders, false);
  assert.strictEqual(TARGET_ADAPTER_GOALS.haejeok.restartRecovery, true);
  assert.notDeepStrictEqual(hj.getCapabilities().features, TARGET_ADAPTER_GOALS.haejeok);

  const registry = new IdempotentJobRegistry();
  const journal = new InMemoryEventJournal();
  const bridge = new HostBackgroundModelsBridge(
    "principal-1",
    "browser-client-xyz",
    hj.getCapabilities(),
    registry,
    journal
  );

  const req = makeRequest({
    clientJobId: "e2e-job-123",
    payload: { prompt: "Compose multi-device resume" },
    generation: {
      chatId: "chat-xyz",
      characterId: "char-1",
      generationId: "gen-99",
      mode: "standard",
      expectedChatRevision: 1
    },
    versioning: { contractVersion: 1, pipelineVersion: "risu-finalize/1", pluginVersion: "1.0" }
  });

  const snapshot = await bridge.createJob(req);
  assert.strictEqual(snapshot.state, "reserved");

  const jobMetadata = registry.getJob("principal-1", "e2e-job-123")!;
  const queuedJob = transitionJob(jobMetadata, "queued");
  const runningJob = transitionJob(queuedJob, "running");
  registry.updateJob("principal-1", "e2e-job-123", jobMetadata.recordVersion, runningJob);

  bridge._simulateServerSucceeded("e2e-job-123", { content: "Generated reply" });
  assert.strictEqual((await bridge.getJob("e2e-job-123")).state, "succeeded");

  const lease = await bridge.acquireDeliveryLease("e2e-job-123");
  assert.strictEqual((await bridge.getJob("e2e-job-123")).state, "finalizing");

  const finRes = await bridge.finalize("e2e-job-123", {
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    materializationProof: {
      messageId: "msg-9999",
      chatRevision: 2,
      persistedAt: new Date().toISOString()
    }
  });
  assert.strictEqual(finRes.status, "completed");
  assert.strictEqual((await bridge.getJob("e2e-job-123")).state, "completed");
  assert.strictEqual((await bridge.readResult("e2e-job-123")).payload.content, "Generated reply");
});
