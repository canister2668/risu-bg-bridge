import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const pluginUrl = new URL("../plugin/risu-bg-bridge.plugin.js", import.meta.url);

test("standalone plugin has installable API v3 metadata and uses the host bridge", async () => {
  const source = await readFile(pluginUrl, "utf8");
  assert.match(source, /^\/\/@name risu_bg_bridge/m);
  assert.match(source, /^\/\/@api 3\.0/m);

  let provider: ((args: any, signal: AbortSignal) => Promise<any>) | undefined;
  let submitted: any;
  const Risuai = {
    addProvider: async (_name: string, fn: typeof provider) => { provider = fn; },
    registerSetting: async () => "setting-id",
    getArgument: async (key: string) => key === "credential_ref"
      ? "provider-account://openai/default"
      : "test-model",
    getCurrentCharacterIndex: async () => 0,
    getCurrentChatIndex: async () => 0,
    getCharacter: async () => ({ id: "character-1" }),
    getChatFromIndex: async () => ({ id: "chat-1" }),
    backgroundModels: {
      getCapabilities: async () => ({
        contractVersion: 1,
        features: { pluginJobCreation: true, serverProviders: true, tabCloseDurable: true },
        adapter: { target: "haejeok", version: "test" },
      }),
      createJob: async (request: any) => { submitted = request; return { jobId: request.clientJobId }; },
      getJob: async (jobId: string) => ({ jobId, state: "succeeded", kind: "aux" }),
      readResult: async (jobId: string) => ({
        jobId,
        resultHash: "a".repeat(64),
        payload: JSON.stringify({ choices: [{ message: { content: "durable answer" } }] }),
      }),
      ackResult: async () => ({ success: true }),
      cancelJob: async () => ({ success: true }),
    },
  };
  await vm.runInNewContext(source, {
    Risuai,
    crypto: webcrypto,
    console,
    setTimeout,
    clearTimeout,
    DOMException,
    document: {},
  });
  assert.ok(provider);
  const response = await provider!({
    prompt_chat: [{ role: "user", content: "hello" }],
    temperature: 100,
    top_p: 100,
    max_tokens: 64,
    mode: "otherAx",
  }, new AbortController().signal);
  assert.equal(response.success, true);
  assert.equal(response.content, "durable answer");
  assert.equal(submitted.kind, "aux");
  assert.equal(submitted.chatId, "chat-1");
  assert.match(submitted.clientJobId, /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.parse(submitted.body).model, "test-model");
});

test("standalone plugin falls back to an explicit built-in model without plugin recursion", async () => {
  const source = await readFile(pluginUrl, "utf8");
  let provider: ((args: any, signal: AbortSignal) => Promise<any>) | undefined;
  let fallbackCall: any;
  const Risuai = {
    addProvider: async (_name: string, fn: typeof provider) => { provider = fn; },
    registerSetting: async () => "setting-id",
    getArgument: async (key: string) => key === "fallback_model" ? "builtin-model" : "",
    runLLMModel: async (arg: any) => { fallbackCall = arg; return { content: "foreground answer" }; },
    backgroundModels: { getCapabilities: async () => ({
      contractVersion: 1,
      features: { pluginJobCreation: false, serverProviders: false },
    }) },
  };
  await vm.runInNewContext(source, {
    Risuai, crypto: webcrypto, console, setTimeout, clearTimeout, DOMException, document: {},
  });
  const response = await provider!({ prompt_chat: [], mode: "otherAx" }, new AbortController().signal);
  assert.equal(response.success, true);
  assert.equal(response.content, "foreground answer");
  assert.equal(fallbackCall.staticModel, "builtin-model");
  assert.equal(fallbackCall.allowPlugins, false);
});
