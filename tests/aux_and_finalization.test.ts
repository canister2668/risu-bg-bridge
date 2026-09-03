import test from "node:test";
import assert from "node:assert";
import { SqliteBgStorageEngine } from "../src/storage/sqliteStorage.js";
import { ResumableFinalizer } from "../src/engine/finalization.js";
import { PersistentHostBackgroundModelsBridge } from "../src/client/hostBridge.js";
import { DurableEngineAdapter } from "../src/adapters/durableAdapter.js";
import { JobMetadata, CreateBackgroundJobRequest, DurableGenerationContext } from "../src/contract/types.js";
import { calculatePayloadHash } from "../src/engine/stateMachine.js";

function makeJob(overrides: Partial<JobMetadata> = {}): JobMetadata {
  return {
    recordVersion: 1,
    identity: {
      principalId: "p1",
      clientJobId: "aux-job-1",
      requestFingerprint: "fingerprint-aux"
    },
    kind: "aux",
    execution: {
      providerRef: "openai",
      modelRef: "gpt-4o",
      credentialRef: "provider-account://openai/default",
      requestEnvelopeRef: "envelope://p1/aux-job-1",
      attempt: 1,
      executionEpoch: 1
    },
    generation: {
      chatId: "chat-100",
      characterId: "char-200",
      generationId: "gen-300",
      mode: "translation",
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
      state: "succeeded",
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
    result: {
      resultRef: "result://aux-job-1",
      resultHash: calculatePayloadHash({ translation: "Bonjour" })
    },
    audit: {
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    ...overrides
  };
}

test("Aux job durable discovery, consumer group ACKs, and unconsumed filter", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const adapter = new DurableEngineAdapter("pocket", storage);
  const bridge = new PersistentHostBackgroundModelsBridge("p1", "client-1", adapter.getCapabilities(), storage);

  const job = makeJob();
  await storage.putJob("p1", job);
  await storage.saveResult({
    jobId: "aux-job-1",
    resultHash: job.result!.resultHash!,
    payload: { translation: "Bonjour" }
  });

  // 1. Discover unconsumed aux jobs
  const unconsumed = await storage.listJobs("p1", { kind: "aux", unconsumedBy: "translation-plugin" });
  assert.strictEqual(unconsumed.length, 1);
  assert.strictEqual(unconsumed[0].identity.clientJobId, "aux-job-1");

  // 2. ACK by consumer
  await bridge.ackResult("aux-job-1", "translation-plugin", job.result!.resultHash!, "translation-group");

  // Job should now be completed
  const jobAfterAck = await storage.getJob("p1", "aux-job-1");
  assert.strictEqual(jobAfterAck?.recovery.state, "completed");

  // 3. Re-query unconsumed: should be empty
  const unconsumedAfter = await storage.listJobs("p1", { kind: "aux", unconsumedBy: "translation-plugin" });
  assert.strictEqual(unconsumedAfter.length, 0);

  // 4. Verify ACK record
  const acks = await storage.getAuxAcks("aux-job-1");
  assert.strictEqual(acks.length, 1);
  assert.strictEqual(acks[0].consumerId, "translation-plugin");
  assert.strictEqual(acks[0].consumerGroup, "translation-group");

  await storage.close();
});

test("ResumableFinalizer: skips already completed stages and preserves idempotency", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const finalizer = new ResumableFinalizer(storage);

  let stage1Executions = 0;
  let stage2Executions = 0;

  finalizer.registerStage({
    stageId: "normalize_markdown",
    stageVersion: 1,
    isPureIdempotent: true,
    async execute(input) {
      stage1Executions++;
      return { ...input, normalized: true };
    }
  });

  finalizer.registerStage({
    stageId: "tag_emotions",
    stageVersion: 1,
    isPureIdempotent: true,
    async execute(input) {
      stage2Executions++;
      return { ...input, emotions: ["happy"] };
    }
  });

  const job = makeJob({ kind: "main" });
  await storage.putJob("p1", job);
  const rawResult = {
    jobId: "aux-job-1",
    resultHash: "hash-raw",
    payload: { text: "Hello" }
  };
  const ctx: DurableGenerationContext = {
    chatId: "chat-100",
    characterId: "char-200",
    generationId: "gen-300",
    requestMode: "adventure",
    expectedChatRevision: 1,
    pipelineVersion: "risu-finalize/1"
  };

  // Run first time
  const outcome1 = await finalizer.processDurableGenerationResult(job, rawResult, ctx);
  assert.strictEqual(outcome1.success, true);
  assert.strictEqual(stage1Executions, 1);
  assert.strictEqual(stage2Executions, 1);
  assert.strictEqual(outcome1.finalizedResult.normalized, true);
  assert.deepStrictEqual(outcome1.finalizedResult.emotions, ["happy"]);

  // Run second time (as in crash recovery): stages should NOT re-run
  const outcome2 = await finalizer.processDurableGenerationResult(job, rawResult, ctx);
  assert.strictEqual(outcome2.success, true);
  assert.strictEqual(stage1Executions, 1);
  assert.strictEqual(stage2Executions, 1);
  assert.deepStrictEqual(outcome2.finalizedResult, outcome1.finalizedResult);

  await storage.close();
});

test("ResumableFinalizer: materialization verification detects hash and revision conflicts", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const finalizer = new ResumableFinalizer(storage);
  const job = makeJob({
    result: { resultHash: "hash-expected-123" },
    generation: { ...makeJob().generation, expectedChatRevision: 5 }
  });

  // Valid proof
  const validProof = {
    messageId: "msg-1",
    chatRevision: 5,
    persistedAt: new Date().toISOString(),
    resultHash: "hash-expected-123"
  };
  assert.strictEqual(finalizer.verifyMaterialization(job, validProof).valid, true);

  // Stale revision
  const staleProof = {
    ...validProof,
    chatRevision: 4
  };
  const staleCheck = finalizer.verifyMaterialization(job, staleProof);
  assert.strictEqual(staleCheck.valid, false);
  assert.ok(staleCheck.reason?.includes("ChatRevisionStale"));

  // Hash mismatch
  const mismatchedHashProof = {
    ...validProof,
    resultHash: "different-hash-456"
  };
  const hashCheck = finalizer.verifyMaterialization(job, mismatchedHashProof);
  assert.strictEqual(hashCheck.valid, false);
  assert.ok(hashCheck.reason?.includes("ResultHashMismatch"));

  await storage.close();
});

test("PersistentHostBackgroundModelsBridge: multi-device lease fencing and finalize verification", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const adapter = new DurableEngineAdapter("haejeok", storage);
  const bridgeClientA = new PersistentHostBackgroundModelsBridge("p1", "device-A", adapter.getCapabilities(), storage);
  const bridgeClientB = new PersistentHostBackgroundModelsBridge("p1", "device-B", adapter.getCapabilities(), storage);

  // Create job via Client A
  const req: CreateBackgroundJobRequest = {
    clientJobId: "multi-dev-job",
    kind: "main",
    providerRef: "openai",
    modelRef: "gpt-4o",
    credentialRef: "provider-account://openai/default",
    payload: { prompt: "Test prompt" },
    generation: {
      chatId: "chat-xyz",
      characterId: "char-xyz",
      generationId: "gen-xyz",
      mode: "chat",
      expectedChatRevision: 2
    },
    versioning: {
      contractVersion: 1,
      pipelineVersion: "risu-finalize/1",
      pluginVersion: "1.0"
    }
  };

  await bridgeClientA.createJob(req);

  // Simulate server job reaching succeeded state
  const job = await storage.getJob("p1", "multi-dev-job");
  assert.ok(job);
  const resultPayload = { reply: "Generated reply" };
  const resHash = calculatePayloadHash(resultPayload);
  await storage.saveResult({
    jobId: "multi-dev-job",
    resultHash: resHash,
    payload: resultPayload
  });

  const succeededJob = {
    ...job,
    recovery: { ...job.recovery, state: "succeeded" as const },
    result: { resultRef: "result://multi-dev-job", resultHash: resHash }
  };
  await storage.updateJobCas("p1", "multi-dev-job", job.recordVersion, succeededJob);

  // Client A acquires lease (fencingToken = 1)
  const leaseA = await bridgeClientA.acquireDeliveryLease("multi-dev-job");
  assert.strictEqual(leaseA.fencingToken, "1");

  // Client B attempts to acquire while Client A's lease is active -> Conflict
  await assert.rejects(
    async () => {
      await bridgeClientB.acquireDeliveryLease("multi-dev-job");
    }
  );

  // Expire Client A's lease manually to simulate timeout
  const currentJob = (await storage.getJob("p1", "multi-dev-job"))!;
  currentJob.delivery.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
  await storage.updateJobCas("p1", "multi-dev-job", currentJob.recordVersion, currentJob);

  // Now Client B acquires lease (fencingToken = 2)
  const leaseB = await bridgeClientB.acquireDeliveryLease("multi-dev-job");
  assert.strictEqual(leaseB.fencingToken, "2");

  // Client A attempts to finalize with stale fencingToken 1 -> Rejected
  const staleFinalize = await bridgeClientA.finalize("multi-dev-job", {
    leaseId: leaseA.leaseId,
    fencingToken: leaseA.fencingToken,
    materializationProof: {
      messageId: "msg-a",
      chatRevision: 2,
      persistedAt: new Date().toISOString(),
      resultHash: resHash
    }
  });
  assert.strictEqual(staleFinalize.status, "failed");
  assert.ok(staleFinalize.error?.includes("Stale leaseId or fencing token"));

  // Client B finalizes with current fencingToken 2 -> Succeeded
  const validFinalize = await bridgeClientB.finalize("multi-dev-job", {
    leaseId: leaseB.leaseId,
    fencingToken: leaseB.fencingToken,
    materializationProof: {
      messageId: "msg-b",
      chatRevision: 2,
      persistedAt: new Date().toISOString(),
      resultHash: resHash
    }
  });
  assert.strictEqual(validFinalize.status, "completed");

  const completedJob = await storage.getJob("p1", "multi-dev-job");
  assert.strictEqual(completedJob?.recovery.state, "completed");

  await storage.close();
});
