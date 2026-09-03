import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import test from "node:test";

const pluginUrl = new URL("../plugin/risu-bg-bridge.plugin.js", import.meta.url);
const releasePluginUrl = new URL("../release/risu-bg-bridge-v0.9.0-beta.2.plugin.js", import.meta.url);

test("standalone plugin advertises a host-native HTTPS update channel", async () => {
  const source = await readFile(pluginUrl, "utf8");
  assert.match(source, /^\/\/@version 0\.9\.0\.2$/m);
  assert.match(
    source,
    /^\/\/@update-url https:\/\/raw\.githubusercontent\.com\/canister2668\/risu-bg-bridge\/refs\/heads\/main\/plugin\/risu-bg-bridge\.plugin\.js$/m,
  );
  const versionLine = source.match(/^\/\/@version[^\n]*/m)?.[0];
  assert.ok(versionLine);
  const versionEnd = source.indexOf(versionLine) + versionLine.length;
  assert.ok(new TextEncoder().encode(source.slice(0, versionEnd)).length <= 512);
  assert.equal(await readFile(releasePluginUrl, "utf8"), source);

  const hostCompare = (v1: string, v2: string) => {
    const left = v1.split(".").map(Number);
    const right = v2.split(".").map(Number);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const a = left[index] || 0;
      const b = right[index] || 0;
      if (a !== b) return a > b ? 1 : -1;
    }
    return 0;
  };
  assert.equal(hostCompare("0.9.0.2", "0.9.0-beta.1"), 1);
  assert.equal(hostCompare("1.0.0", "0.9.0.2"), 1);
});

test("dashboard exposes an available update and a missing core patch", async () => {
  const source = await readFile(pluginUrl, "utf8");
  let openDashboard: (() => Promise<void>) | undefined;
  const body = { innerHTML: "" };
  const elements = new Map<string, { onclick?: () => void }>();
  const document = {
    body,
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
  };
  const Risuai = {
    addProvider: async () => "provider-id",
    registerSetting: async (_name: string, callback: () => Promise<void>) => {
      openDashboard = callback;
      return "setting-id";
    },
    nativeFetch: async () => ({
      status: 206,
      text: async () => "//@name risu_bg_bridge\n//@version 0.9.0.3\n",
    }),
    showContainer: async () => {},
    hideContainer: async () => {},
  };
  await vm.runInNewContext(source, {
    Risuai, crypto: webcrypto, console, setTimeout, clearTimeout, DOMException, document,
  });
  assert.ok(openDashboard);
  await openDashboard!();
  assert.match(body.innerHTML, /UPDATE/);
  assert.match(body.innerHTML, /Version 0\.9\.0\.3 is available/);
  assert.match(body.innerHTML, /Core bridge not detected/);
  assert.match(body.innerHTML, /Open adapter guide/);
});

test("dashboard distinguishes server-provider setup from a missing core patch", async () => {
  const source = await readFile(pluginUrl, "utf8");
  let openDashboard: (() => Promise<void>) | undefined;
  const body = { innerHTML: "" };
  const document = {
    body,
    getElementById: () => ({}),
  };
  const Risuai = {
    addProvider: async () => "provider-id",
    registerSetting: async (_name: string, callback: () => Promise<void>) => {
      openDashboard = callback;
      return "setting-id";
    },
    nativeFetch: async () => ({
      status: 200,
      text: async () => "//@name risu_bg_bridge\n//@version 0.9.0.2\n",
    }),
    showContainer: async () => {},
    hideContainer: async () => {},
    backgroundModels: {
      getCapabilities: async () => ({
        contractVersion: 1,
        adapter: { target: "haejeok", version: "b6704+bg1" },
        features: { tabCloseDurable: true, pluginJobCreation: false, serverProviders: false },
      }),
      listJobs: async () => [],
    },
  };
  await vm.runInNewContext(source, {
    Risuai, crypto: webcrypto, console, setTimeout, clearTimeout, DOMException, document,
  });
  assert.ok(openDashboard);
  await openDashboard!();
  assert.match(body.innerHTML, /CURRENT/);
  assert.match(body.innerHTML, /Core bridge detected · setup required/);
  assert.match(body.innerHTML, /provider registry/);
  assert.doesNotMatch(body.innerHTML, /Core patch required/);
});

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
