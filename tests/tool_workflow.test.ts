import test from "node:test";
import assert from "node:assert";
import { SqliteBgStorageEngine } from "../src/storage/sqliteStorage.js";
import { ToolExecutionEngine } from "../src/engine/tools.js";
import { ToolCallCheckpoint } from "../src/contract/types.js";
function makeJob(id: string): any {
  return {
    recordVersion: 1,
    identity: { principalId: 'u', clientJobId: id, requestFingerprint: 'f-' + id },
    kind: 'tool-workflow',
    execution: { providerRef: 'p', modelRef: 'm', credentialRef: 'c', requestEnvelopeRef: 'e', attempt: 1, executionEpoch: 1 },
    generation: { chatId: 'c', characterId: 'ch', generationId: 'g', mode: 'm', expectedChatRevision: 1 },
    versioning: { contractVersion: 1, jobSchemaVersion: 1, pipelineVersion: 'v1', pluginVersion: '1', adapterVersion: '1' },
    recovery: { state: 'running', retryPolicy: { maxAttempts: 3, initialDelayMs: 1000, backoffFactor: 2, idempotencySupported: false } },
    delivery: { deliveryState: 'undelivered', fencingToken: 0n },
    audit: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  };
}


test("ToolExecutionEngine: replay policy 'safe' allows automatic re-execution after crash", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const toolEngine = new ToolExecutionEngine(storage);
  let callCount = 0;
  toolEngine.registerServerTool("search_notes", async (name, args) => {
    callCount++;
    return { matches: [`Result for ${args.query}`] };
  });

  // Checkpoint tool call with replayPolicy='safe'
  await storage.putJob("u", makeJob("job-1"));
  const cp = await toolEngine.checkpointTool(
    "job-1",
    "call-1",
    "search_notes",
    { query: "Risu" },
    "server",
    "safe"
  );
  assert.strictEqual(cp.state, "pending");

  // First execution
  const res1 = await toolEngine.executeServerTool("job-1", "call-1");
  assert.strictEqual(res1.result.matches[0], "Result for Risu");
  assert.strictEqual(callCount, 1);
  assert.strictEqual(res1.checkpoint.state, "succeeded");

  // Second execution with succeeded state: should replay existing result without calling handler again
  const res2 = await toolEngine.executeServerTool("job-1", "call-1");
  assert.strictEqual(res2.result.matches[0], "Result for Risu");
  assert.strictEqual(callCount, 1);

  await storage.close();
});

test("ToolExecutionEngine: replay policy 'idempotent' requires idempotency key to retry", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const toolEngine = new ToolExecutionEngine(storage);
  let executionCount = 0;
  toolEngine.registerServerTool("charge_card", async (name, args, key) => {
    executionCount++;
    return { charged: true, key };
  });

  // 1. With idempotency key: evaluate allows execute
  const cpWithKey: ToolCallCheckpoint = {
    jobId: "job-2",
    toolCallId: "call-2",
    toolName: "charge_card",
    argsHash: "h1",
    args: { amount: 50 },
    executorType: "server",
    replayPolicy: "idempotent",
    state: "failed", // simulated crash or failure
    idempotencyKey: "idemp-key-12345",
    attempt: 1
  };
  const evalWithKey = toolEngine.evaluateToolCall(cpWithKey, "idempotent", "server");
  assert.strictEqual(evalWithKey.action, "execute");

  // 2. Without idempotency key: evaluate blocks to prevent double charge
  const cpWithoutKey: ToolCallCheckpoint = {
    ...cpWithKey,
    idempotencyKey: undefined
  };
  const evalWithoutKey = toolEngine.evaluateToolCall(cpWithoutKey, "idempotent", "server");
  assert.strictEqual(evalWithoutKey.action, "blocked");

  await storage.close();
});

test("ToolExecutionEngine: replay policy 'confirm' requires explicit approval after crash", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const toolEngine = new ToolExecutionEngine(storage);

  const cpConfirm: ToolCallCheckpoint = {
    jobId: "job-3",
    toolCallId: "call-3",
    toolName: "send_email",
    argsHash: "h2",
    args: { recipient: "alice@example.com" },
    executorType: "server",
    replayPolicy: "confirm",
    state: "failed", // crash / failure occurred
    attempt: 1
  };

  const evalConfirm = toolEngine.evaluateToolCall(cpConfirm, "confirm", "server");
  assert.strictEqual(evalConfirm.action, "blocked");

  await storage.close();
});

test("ToolExecutionEngine: replay policy 'never' is strictly blocked from auto-reexecuting", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const toolEngine = new ToolExecutionEngine(storage);

  const cpNever: ToolCallCheckpoint = {
    jobId: "job-4",
    toolCallId: "call-4",
    toolName: "format_disk",
    argsHash: "h3",
    args: {},
    executorType: "server",
    replayPolicy: "never",
    state: "failed",
    attempt: 1
  };

  const evalNever = toolEngine.evaluateToolCall(cpNever, "never", "server");
  assert.strictEqual(evalNever.action, "blocked");

  await storage.close();
});

test("ToolExecutionEngine: approval executor and client executor checkpoints", async () => {
  const storage = new SqliteBgStorageEngine(":memory:");
  await storage.init();

  const toolEngine = new ToolExecutionEngine(storage);

  // Approval tool starts blocked_confirm
  await storage.putJob("u", makeJob("job-5"));
  const cpApproval = await toolEngine.checkpointTool(
    "job-5",
    "call-approval",
    "delete_database",
    {},
    "approval",
    "confirm"
  );
  assert.strictEqual(cpApproval.state, "blocked_confirm");

  // User grants approval
  const approved = await toolEngine.approveTool("job-5", "call-approval");
  assert.strictEqual(approved.approvalGranted, true);
  assert.strictEqual(approved.state, "pending");

  // Client executor
  const cpClient = await toolEngine.checkpointTool(
    "job-5",
    "call-client",
    "browser_geolocation",
    {},
    "client",
    "safe"
  );
  const evalClient = toolEngine.evaluateToolCall(cpClient, "safe", "client");
  assert.strictEqual(evalClient.action, "await_client");

  // Client reconnects and provides result
  const recorded = await toolEngine.recordToolResult("job-5", "call-client", { lat: 37.5, lon: 127.0 });
  assert.strictEqual(recorded.state, "succeeded");
  assert.strictEqual(recorded.resultPayload.lat, 37.5);

  await storage.close();
});
