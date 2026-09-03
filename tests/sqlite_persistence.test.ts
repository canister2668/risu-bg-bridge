import test from "node:test";
import assert from "node:assert";
import { SqliteBgStorageEngine } from "../src/storage/sqliteStorage.js";
import { JobMetadata, CreateBackgroundJobRequest } from "../src/contract/types.js";
import { calculateFingerprint, ConflictError, CasConflictError } from "../src/engine/fingerprint.js";
import { transitionJob } from "../src/engine/stateMachine.js";

function makeJob(overrides: Partial<JobMetadata> = {}): JobMetadata {
  return {
    recordVersion: 1,
    identity: {
      principalId: "user-1",
      clientJobId: "job-sql-1",
      requestFingerprint: "fingerprint-123"
    },
    kind: "main",
    execution: {
      providerRef: "openai",
      modelRef: "gpt-4o",
      credentialRef: "provider-account://openai/default",
      credentialEpoch: "epoch-1",
      requestEnvelopeRef: "envelope://user-1/job-sql-1",
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
      state: "reserved",
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

test("SqliteBgStorageEngine: initialization, table creation, and foreign keys", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();
  // Successfully creates tables without error
  await storage.close();
});

test("SqliteBgStorageEngine: clientJobId PUT idempotency and fingerprint collision detection", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const job1 = makeJob();
  const put1 = await storage.putJob("user-1", job1);
  assert.strictEqual(put1.isNew, true);
  assert.strictEqual(put1.job.identity.clientJobId, "job-sql-1");

  // Re-PUT exact same job -> returns existing, isNew=false
  const put2 = await storage.putJob("user-1", job1);
  assert.strictEqual(put2.isNew, false);
  assert.strictEqual(put2.job.identity.clientJobId, "job-sql-1");

  // Re-PUT with different fingerprint -> throws ConflictError
  const jobConflicting = makeJob({
    identity: {
      ...job1.identity,
      requestFingerprint: "different-fingerprint-456"
    }
  });

  await assert.rejects(
    async () => {
      await storage.putJob("user-1", jobConflicting);
    },
    ConflictError
  );

  await storage.close();
});

test("SqliteBgStorageEngine: CAS compare-and-set updates prevent concurrent race overwrites", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const job = makeJob();
  await storage.putJob("user-1", job);

  // Successful CAS update from version 1 to 2
  const queuedJob = transitionJob(job, "queued");
  const updated1 = await storage.updateJobCas("user-1", "job-sql-1", 1, queuedJob);
  assert.strictEqual(updated1.recordVersion, 2);
  assert.strictEqual(updated1.recovery.state, "queued");

  // Stale CAS update using version 1 should fail with CasConflictError
  await assert.rejects(
    async () => {
      await storage.updateJobCas("user-1", "job-sql-1", 1, queuedJob);
    },
    CasConflictError
  );

  // Correct CAS update using version 2 should succeed to version 3
  const runningJob = transitionJob(updated1, "running");
  const updated2 = await storage.updateJobCas("user-1", "job-sql-1", 2, runningJob);
  assert.strictEqual(updated2.recordVersion, 3);
  assert.strictEqual(updated2.recovery.state, "running");

  await storage.close();
});

test("SqliteBgStorageEngine: typed monotonic event journal and result store", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const job = makeJob();
  await storage.putJob("user-1", job);

  await storage.appendEvent({
    jobId: "job-sql-1",
    seq: 1,
    eventId: "ev-1",
    type: "state",
    createdAt: new Date().toISOString(),
    payload: { state: "reserved" }
  });

  await storage.appendEvent({
    jobId: "job-sql-1",
    seq: 2,
    eventId: "ev-2",
    type: "provider_chunk",
    createdAt: new Date().toISOString(),
    payload: { chunk: "Hello" }
  });

  const allEvents = await storage.getEvents("job-sql-1", 0);
  assert.strictEqual(allEvents.length, 2);
  assert.strictEqual(allEvents[0].seq, 1);
  assert.strictEqual(allEvents[1].seq, 2);

  const afterSeq1 = await storage.getEvents("job-sql-1", 1);
  assert.strictEqual(afterSeq1.length, 1);
  assert.strictEqual(afterSeq1[0].seq, 2);

  // Result store
  await storage.saveResult({
    jobId: "job-sql-1",
    resultHash: "hash-res-999",
    payload: { reply: "World" },
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    finishReason: "stop"
  });

  const res = await storage.getResult("job-sql-1");
  assert.ok(res);
  assert.strictEqual(res.resultHash, "hash-res-999");
  assert.strictEqual(res.payload.reply, "World");
  assert.strictEqual(res.usage?.totalTokens, 15);

  await storage.close();
});

test("SqliteBgStorageEngine: durable discovery and filtering", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const jobA = makeJob({
    identity: { principalId: "p1", clientJobId: "job-A", requestFingerprint: "f-A" },
    kind: "main",
    generation: { chatId: "c1", characterId: "ch1", generationId: "g1", mode: "m", expectedChatRevision: 1 }
  });
  const jobB = makeJob({
    identity: { principalId: "p1", clientJobId: "job-B", requestFingerprint: "f-B" },
    kind: "aux",
    generation: { chatId: "c2", characterId: "ch2", generationId: "g2", mode: "m", expectedChatRevision: 1 }
  });

  await storage.putJob("p1", jobA);
  await storage.putJob("p1", jobB);

  const all = await storage.listJobs("p1");
  assert.strictEqual(all.length, 2);

  const auxList = await storage.listJobs("p1", { kind: "aux" });
  assert.strictEqual(auxList.length, 1);
  assert.strictEqual(auxList[0].identity.clientJobId, "job-B");

  const chatFilter = await storage.listJobs("p1", { chatId: "c1" });
  assert.strictEqual(chatFilter.length, 1);
  assert.strictEqual(chatFilter[0].identity.clientJobId, "job-A");

  await storage.close();
});
