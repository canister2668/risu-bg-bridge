import test from "node:test";
import assert from "node:assert";
import { SqliteBgStorageEngine } from "../src/storage/sqliteStorage.js";
import { InMemoryCredentialResolver } from "../src/engine/credentials.js";
import { BackgroundWorker, ModelExecutionHandler } from "../src/engine/worker.js";
import { JobMetadata } from "../src/contract/types.js";
import { transitionJob } from "../src/engine/stateMachine.js";

function makeJob(overrides: Partial<JobMetadata> = {}): JobMetadata {
  return {
    recordVersion: 1,
    identity: {
      principalId: "user-1",
      clientJobId: "job-rec-1",
      requestFingerprint: "fingerprint-123"
    },
    kind: "main",
    execution: {
      providerRef: "openai",
      modelRef: "gpt-4o",
      credentialRef: "provider-account://openai/default",
      credentialEpoch: "epoch-1",
      requestEnvelopeRef: "envelope://user-1/job-rec-1",
      attempt: 1,
      executionEpoch: 1
    },
    generation: {
      chatId: "chat-100",
      characterId: "char-200",
      generationId: "gen-300",
      mode: "adventure",
      expectedChatRevision: 1
    },
    versioning: {
      contractVersion: 1,
      jobSchemaVersion: 1,
      pipelineVersion: "risu-finalize/1",
      pluginVersion: "1.0",
      adapterVersion: "v1"
    },
    recovery: {
      state: "running",
      retryPolicy: {
        maxAttempts: 3,
        initialDelayMs: 1000,
        backoffFactor: 2,
        idempotencySupported: false
      }
    },
    delivery: {
      deliveryState: "undelivered",
      fencingToken: 0n
    },
    audit: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    ...overrides
  };
}

test("BackgroundWorker: successful execution lifecycle", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const credResolver = new InMemoryCredentialResolver();
  credResolver.registerCredential("provider-account://openai/default", { apiKey: "sk-secret-key" }, "epoch-1");

  await storage.saveRequestEnvelope("envelope://user-1/job-rec-1", {
    messages: [{ role: "user", content: "Hi" }]
  });

  const job = makeJob({ recovery: { ...makeJob().recovery, state: "queued" } });
  await storage.putJob("user-1", job);

  const modelHandler: ModelExecutionHandler = {
    async execute(j, payload, secret) {
      assert.strictEqual(secret.apiKey, "sk-secret-key");
      return {
        result: { text: "Hello there!" },
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        finishReason: "stop"
      };
    }
  };

  const worker = new BackgroundWorker(storage, credResolver, modelHandler);
  const completed = await worker.executeJob(job);

  assert.strictEqual(completed.recovery.state, "succeeded");
  assert.ok(completed.result?.resultHash);

  const savedResult = await storage.getResult("job-rec-1");
  assert.strictEqual(savedResult?.payload.text, "Hello there!");

  await storage.close();
});

test("BackgroundWorker restart recovery: uncertain send with non-idempotent provider transitions to ambiguous", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const credResolver = new InMemoryCredentialResolver();
  credResolver.registerCredential("provider-account://openai/default", { apiKey: "sk-secret-key" }, "epoch-1");

  // Server crashed while job was running with idempotencySupported = false
  const crashedJob = makeJob({
    identity: { principalId: "user-1", clientJobId: "crash-job-1", requestFingerprint: "f-crash" },
    recovery: {
      state: "running",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: false }
    }
  });
  await storage.putJob("user-1", crashedJob);

  const dummyHandler: ModelExecutionHandler = {
    async execute() { throw new Error("not called in recovery"); }
  };
  const worker = new BackgroundWorker(storage, credResolver, dummyHandler);

  const recoveryResult = await worker.runRestartRecovery();
  assert.strictEqual(recoveryResult.recoveredCount, 1);
  assert.strictEqual(recoveryResult.states["crash-job-1"], "ambiguous");

  const jobInDb = await storage.getJob("user-1", "crash-job-1");
  assert.strictEqual(jobInDb?.recovery.state, "ambiguous");
  assert.ok(jobInDb?.recovery.ambiguousReason?.includes("AmbiguousExecution"));

  await storage.close();
});

test("BackgroundWorker restart recovery: idempotent provider re-queues with incremented attempt", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const credResolver = new InMemoryCredentialResolver();
  credResolver.registerCredential("provider-account://openai/default", { apiKey: "sk-secret-key" }, "epoch-1");

  // Idempotent provider allows safe re-queuing
  const crashedJob = makeJob({
    identity: { principalId: "user-1", clientJobId: "idempotent-crash", requestFingerprint: "f-idemp" },
    execution: { ...makeJob().execution, attempt: 1, executionEpoch: 1 },
    recovery: {
      state: "running",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: true }
    }
  });
  await storage.putJob("user-1", crashedJob);

  const dummyHandler: ModelExecutionHandler = {
    async execute() { throw new Error("not called in recovery"); }
  };
  const worker = new BackgroundWorker(storage, credResolver, dummyHandler);

  const recoveryResult = await worker.runRestartRecovery();
  assert.strictEqual(recoveryResult.recoveredCount, 1);
  assert.strictEqual(recoveryResult.states["idempotent-crash"], "queued");

  const jobInDb = await storage.getJob("user-1", "idempotent-crash");
  assert.strictEqual(jobInDb?.recovery.state, "queued");
  assert.strictEqual(jobInDb?.execution.attempt, 2);
  assert.strictEqual(jobInDb?.execution.executionEpoch, 2);

  await storage.close();
});

test("BackgroundWorker restart recovery: revoked or epoch-mismatched credential marks job failed", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const credResolver = new InMemoryCredentialResolver();
  // Register credential but revoke it
  credResolver.registerCredential("provider-account://openai/default", { apiKey: "sk-key" }, "epoch-1", true, "User revoked key");

  const crashedJob = makeJob({
    identity: { principalId: "user-1", clientJobId: "cred-fail-job", requestFingerprint: "f-cred" },
    recovery: {
      state: "running",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: true }
    }
  });
  await storage.putJob("user-1", crashedJob);

  const dummyHandler: ModelExecutionHandler = {
    async execute() { throw new Error("not called in recovery"); }
  };
  const worker = new BackgroundWorker(storage, credResolver, dummyHandler);

  const recoveryResult = await worker.runRestartRecovery();
  assert.strictEqual(recoveryResult.recoveredCount, 1);
  assert.strictEqual(recoveryResult.states["cred-fail-job"], "failed");

  const jobInDb = await storage.getJob("user-1", "cred-fail-job");
  assert.strictEqual(jobInDb?.recovery.state, "failed");
  assert.ok(jobInDb?.recovery.ambiguousReason?.includes("User revoked key"));

  await storage.close();
});

test("BackgroundWorker restart recovery: stale finalizing job lease cleared back to succeeded", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const credResolver = new InMemoryCredentialResolver();

  // Job was finalizing when server rebooted
  const finalizingJob = makeJob({
    identity: { principalId: "user-1", clientJobId: "finalizing-crash", requestFingerprint: "f-fin" },
    result: { resultRef: "result://user-1/finalizing-crash", resultHash: "hash-123" },
    recovery: {
      state: "finalizing",
      retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: false }
    },
    delivery: {
      deliveryState: "leased",
      fencingToken: 1n,
      leaseOwner: "client-dead",
      leaseId: "lease-xyz",
      leaseExpiresAt: new Date(Date.now() + 60000).toISOString()
    }
  });
  await storage.putJob("user-1", finalizingJob);

  const dummyHandler: ModelExecutionHandler = {
    async execute() { throw new Error("not called in recovery"); }
  };
  const worker = new BackgroundWorker(storage, credResolver, dummyHandler);

  const recoveryResult = await worker.runRestartRecovery();
  assert.strictEqual(recoveryResult.recoveredCount, 1);
  assert.strictEqual(recoveryResult.states["finalizing-crash"], "succeeded");

  const jobInDb = await storage.getJob("user-1", "finalizing-crash");
  assert.strictEqual(jobInDb?.recovery.state, "succeeded");
  assert.strictEqual(jobInDb?.delivery.deliveryState, "undelivered");
  assert.strictEqual(jobInDb?.delivery.leaseOwner, undefined);

  await storage.close();
});
