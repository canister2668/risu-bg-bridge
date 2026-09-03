import test from "node:test";
import assert from "node:assert/strict";

import { BackgroundCapabilities, CreateBackgroundJobRequest } from "../src/contract/types.js";
import {
  PocketModelJobsTransport,
  PocketTransportHttpError,
  PocketTransportUnavailableError
} from "../plugin/src/pocketTransport.js";
import { POCKET_1_10_0_CAPABILITIES } from "../adapters/pocket/adapter.js";
import { FetchLike } from "../plugin/src/negotiation.js";

const BASE = "https://pocket.example";
const CLIENT_JOB_ID = "018f6b2c-4a1b-7c3d-9e2f-3a4b5c6d7e8f";
const BRIDGE = `${BASE}/api/risu-bg-bridge/v1`;

/**
 * The matrix an UNPATCHED 1.10.0 server warrants: everything the locked
 * source does on its own, no bridge block. Tests inject this to pin the
 * round-1 stock behavior; the default (adapter matrix) describes the
 * series-patched build and unlocks the bridge paths.
 */
const UNPATCHED_CAPS: BackgroundCapabilities = {
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
  pipelineVersion: "pocket-send/1",
  adapter: { target: "pocket", version: "1.10.0" }
};

interface CapturedCall {
  url: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
}

function makeReq(): CreateBackgroundJobRequest {
  return {
    clientJobId: CLIENT_JOB_ID,
    kind: "main",
    providerRef: "openai",
    modelRef: "gpt-test",
    credentialRef: "provider-account://openai/default",
    payload: {
      targetUrl: "https://provider.example/v1/chat/completions",
      method: "POST",
      headers: { Authorization: "Bearer client-side-secret" },
      body: JSON.stringify({ model: "gpt-test", messages: [] })
    },
    generation: { chatId: "chat-1", characterId: "char-1", generationId: "gen-1", mode: "otherAx", expectedChatRevision: 1 },
    versioning: { contractVersion: 1, pipelineVersion: "risu-bg-test/1", pluginVersion: "0.0.0" }
  };
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CLIENT_JOB_ID,
    chatId: "chat-1",
    generationId: "gen-1",
    adapterKind: "risu-bg-extension",
    model: "gpt-test",
    targetOrigin: "client",
    kind: "main",
    streaming: false,
    status: "running",
    createdAt: 1_700_000_000_000,
    bytes: 0,
    claimed: false,
    ...overrides
  };
}

/** Bridge snapshot: the stock row plus the fields only the patch tracks. */
function makeBridgeRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makeRow(),
    requestFingerprint: "f1f2f3",
    principalId: "pocket-host:11111111-2222-3333-4444-555555555555",
    deliveryState: "undelivered",
    lease: null,
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
    json: async () => body
  } as unknown as Response;
}

/** Fetch fake that records calls and routes by URL + method. */
class FetchRouter {
  calls: CapturedCall[] = [];
  private routes: Array<{ match: (url: string, method: string) => Response | null }> = [];

  route(fn: (url: string, method: string) => Response | null): void {
    this.routes.push({ match: fn });
  }

  toFetchLike(): FetchLike {
    return async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      this.calls.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
        headers: (init?.headers ?? undefined) as Record<string, string> | undefined,
        credentials: init?.credentials
      });
      for (const r of this.routes) {
        const response = r.match(url, method);
        if (response) return response;
      }
      return jsonResponse({ error: "no route" }, 500);
    };
  }
}

/** Transport wired to an unpatched 1.10.0 server (stock paths only). */
function stockTransport(router: FetchRouter): PocketModelJobsTransport {
  return new PocketModelJobsTransport(router.toFetchLike(), BASE, UNPATCHED_CAPS);
}

/** Transport wired to a series-patched server (default kit matrix). */
function bridgeTransport(router: FetchRouter): PocketModelJobsTransport {
  return new PocketModelJobsTransport(router.toFetchLike(), BASE, POCKET_1_10_0_CAPABILITIES, {
    pollDelayMs: 0
  });
}

test("pocket-transport (unpatched): createJob POSTs the verified model-jobs body and maps the row", async () => {
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "POST" && url.endsWith("/api/model-jobs")) {
      return jsonResponse({ jobId: CLIENT_JOB_ID });
    }
    if (method === "GET" && url.endsWith(`/api/model-jobs/${CLIENT_JOB_ID}`)) {
      return jsonResponse(makeRow());
    }
    return null;
  });
  const transport = stockTransport(router);

  const snapshot = await transport.createJob(makeReq());

  const post = router.calls.find((c) => c.method === "POST");
  assert.ok(post, "POST /api/model-jobs must be called");
  assert.equal(post.url, `${BASE}/api/model-jobs`);
  assert.equal(post.credentials, "include", "auth rides the session cookie, never a header secret");
  assert.deepEqual(post.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(post.body ?? "{}"), {
    id: CLIENT_JOB_ID,
    targetUrl: "https://provider.example/v1/chat/completions",
    method: "POST",
    headers: { Authorization: "Bearer client-side-secret" },
    body: JSON.stringify({ model: "gpt-test", messages: [] }),
    chatId: "chat-1",
    generationId: "gen-1",
    adapterKind: "risu-bg-extension",
    model: "gpt-test",
    kind: "main",
    streaming: false
  });

  assert.deepEqual(snapshot, {
    jobId: CLIENT_JOB_ID,
    state: "running",
    kind: "main",
    fingerprint: "", // stock rows carry no server-side fingerprint (documented gap)
    attempt: 1,
    generationId: "gen-1",
    resultHash: undefined,
    error: undefined,
    updatedAt: new Date(1_700_000_000_000).toISOString(),
    deliveryState: "undelivered"
  });
});

test("pocket-transport (bridge): createJob PUTs idempotently and maps fingerprint + delivery state", async () => {
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "PUT" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}`) {
      return jsonResponse({ job: makeBridgeRow({ status: "done", endedAt: 1_700_000_500_000 }), isNew: true }, 201);
    }
    return null;
  });
  const transport = bridgeTransport(router);

  const snapshot = await transport.createJob(makeReq());

  const put = router.calls.find((c) => c.method === "PUT");
  assert.ok(put, "PUT /api/risu-bg-bridge/v1/jobs/:id must be called when putIdempotency is advertised");
  assert.equal(put.url, `${BRIDGE}/jobs/${CLIENT_JOB_ID}`);
  assert.deepEqual(JSON.parse(put.body ?? "{}"), {
    id: CLIENT_JOB_ID,
    targetUrl: "https://provider.example/v1/chat/completions",
    method: "POST",
    headers: { Authorization: "Bearer client-side-secret" },
    body: JSON.stringify({ model: "gpt-test", messages: [] }),
    chatId: "chat-1",
    generationId: "gen-1",
    adapterKind: "risu-bg-extension",
    model: "gpt-test",
    kind: "main",
    streaming: false
  });
  // The fingerprint is the SERVER-computed digest over this exact body —
  // the client never computes or persists it.
  assert.equal(snapshot.fingerprint, "f1f2f3");
  assert.equal(snapshot.state, "succeeded");
  assert.equal(snapshot.deliveryState, "undelivered");
  assert.ok(router.calls.every((c) => c.method !== "POST"), "no stock POST may happen on the bridge path");
});

test("pocket-transport (bridge): a 409 fingerprint conflict surfaces as an HTTP error, never as success", async () => {
  const router = new FetchRouter();
  router.route((url, method) =>
    method === "PUT" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}`
      ? jsonResponse({ error: "Request fingerprint mismatch for existing job id", jobId: CLIENT_JOB_ID }, 409)
      : null
  );
  const transport = bridgeTransport(router);
  await assert.rejects(
    () => transport.createJob(makeReq()),
    (err: unknown) => err instanceof PocketTransportHttpError && err.status === 409
  );
});

test("pocket-transport (unpatched): row status mapping covers every TERMINAL_STATUS", async () => {
  const router = new FetchRouter();
  let mockStatus = "running";
  router.route((url, method) =>
    method === "GET" && url.includes("/api/model-jobs/") ? jsonResponse(makeRow({ status: mockStatus })) : null
  );
  const transport = stockTransport(router);

  const cases: Array<[string, string]> = [
    ["running", "running"],
    ["done", "succeeded"],
    ["failed", "failed"],
    ["aborted", "cancelled"]
  ];
  for (const [rowStatus, contractState] of cases) {
    mockStatus = rowStatus;
    const snapshot = await transport.getJob(CLIENT_JOB_ID);
    assert.equal(snapshot.state, contractState, `row ${rowStatus} -> ${contractState}`);
  }

  // Claimed rows report as delivered.
  const claimedRouter = new FetchRouter();
  claimedRouter.route(() => jsonResponse(makeRow({ status: "done", claimed: true, endedAt: 1_700_000_500_000 })));
  const t2 = stockTransport(claimedRouter);
  const done = await t2.getJob(CLIENT_JOB_ID);
  assert.equal(done.state, "succeeded");
  assert.equal(done.deliveryState, "delivered");
  assert.equal(done.updatedAt, new Date(1_700_000_500_000).toISOString());
});

test("pocket-transport (bridge): getJob reads the typed snapshot with lease + delivery state", async () => {
  const router = new FetchRouter();
  const lease = {
    leaseId: "lease-1",
    ownerClientId: "owner-1",
    fencingToken: "3",
    expiresAt: new Date(1_700_000_600_000).toISOString()
  };
  router.route((url, method) =>
    method === "GET" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}`
      ? jsonResponse(makeBridgeRow({ status: "done", deliveryState: "leased", lease, endedAt: 1_700_000_500_000 }))
      : null
  );
  const transport = bridgeTransport(router);

  const snapshot = await transport.getJob(CLIENT_JOB_ID);
  assert.equal(router.calls[0].url, `${BRIDGE}/jobs/${CLIENT_JOB_ID}`);
  assert.equal(snapshot.state, "succeeded");
  assert.equal(snapshot.fingerprint, "f1f2f3");
  assert.equal(snapshot.deliveryState, "leased");
  assert.equal(snapshot.leaseExpiresAt, lease.expiresAt);
});

test("pocket-transport (unpatched): HTTP failures surface status and body", async () => {
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "GET" && url.endsWith(`/api/model-jobs/${CLIENT_JOB_ID}`)) {
      return jsonResponse({ error: "job not found" }, 404);
    }
    return null;
  });
  const transport = stockTransport(router);
  await assert.rejects(
    () => transport.getJob(CLIENT_JOB_ID),
    (err: unknown) =>
      err instanceof PocketTransportHttpError && err.status === 404 && err.body.includes("job not found")
  );
});

test("pocket-transport (unpatched): listJobs supports only what 1.10.0 actually lists", async () => {
  const router = new FetchRouter();
  router.route((url) => (url.endsWith("/api/model-jobs?active=1") ? jsonResponse({ jobs: [makeRow(), makeRow({ id: "j2", chatId: "chat-2" })] }) : null));
  const transport = stockTransport(router);

  const all = await transport.listJobs();
  assert.equal(all.length, 2);
  assert.equal(router.calls[0].url, `${BASE}/api/model-jobs?active=1`);

  const filtered = await transport.listJobs({ chatId: "chat-2" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].jobId, "j2");

  // Anything but 'running' is refused rather than approximated.
  await assert.rejects(
    () => transport.listJobs({ state: "succeeded" }),
    PocketTransportUnavailableError
  );
});

test("pocket-transport (bridge): listJobs unconsumedBy uses durable aux discovery; unpatched refuses it", async () => {
  // Patched: GET /aux/pending?consumer=<id> returns un-ACKed terminal aux jobs.
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "GET" && url.startsWith(`${BRIDGE}/aux/pending`)) {
      assert.ok(url.includes("consumer=consumer-1"), "consumer id must ride the query");
      return jsonResponse({
        jobs: [makeBridgeRow({ id: "aux-1", kind: "aux", status: "done", chatId: "chat-9" })]
      });
    }
    return null;
  });
  const transport = bridgeTransport(router);
  const pending = await transport.listJobs({ unconsumedBy: "consumer-1" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].jobId, "aux-1");
  assert.equal(pending[0].kind, "aux");
  assert.equal(pending[0].deliveryState, "undelivered");

  // Unpatched: the operation 1.10.0 never had throws instead of lying.
  const bareRouter = new FetchRouter();
  const bare = stockTransport(bareRouter);
  await assert.rejects(
    () => bare.listJobs({ unconsumedBy: "consumer-1" }),
    PocketTransportUnavailableError
  );
});

test("pocket-transport (unpatched): cancelJob issues DELETE and re-reads the row", async () => {
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "DELETE" && url.endsWith(`/api/model-jobs/${CLIENT_JOB_ID}`)) {
      return jsonResponse({ ok: true });
    }
    if (method === "GET" && url.endsWith(`/api/model-jobs/${CLIENT_JOB_ID}`)) {
      return jsonResponse(makeRow({ status: "aborted" }));
    }
    return null;
  });
  const transport = stockTransport(router);
  const snapshot = await transport.cancelJob(CLIENT_JOB_ID, "user asked");
  assert.equal(snapshot.state, "cancelled");
  assert.ok(router.calls.some((c) => c.method === "DELETE"));
});

test("pocket-transport (unpatched): streamEvents replays raw journal bytes with client-side resume", async () => {
  const chunks = [new Uint8Array([65, 66, 67]), new Uint8Array([68, 69, 70, 71, 72])]; // "ABC", "DEFGH"

  function makeStreamTransport(): { transport: PocketModelJobsTransport; router: FetchRouter } {
    const router = new FetchRouter();
    router.route((url) =>
      url.endsWith(`/api/model-jobs/${CLIENT_JOB_ID}/stream`)
        ? ({ ok: true, status: 200, body: new ReadableStream({
            start(controller) {
              for (const c of chunks) controller.enqueue(c);
              controller.close();
            }
          }) } as unknown as Response)
        : null
    );
    return { transport: stockTransport(router), router };
  }

  // Full replay: two chunk events with monotonic byte-end seqs.
  {
    const { transport } = makeStreamTransport();
    const events = [];
    for await (const e of transport.streamEvents(CLIENT_JOB_ID)) events.push(e);
    assert.equal(events.length, 2);
    assert.equal(events[0].seq, 3);
    assert.equal(events[0].payload.byteOffset, 0);
    assert.equal(events[0].type, "provider_chunk");
    assert.equal(events[1].seq, 8);
    assert.equal(events[1].payload.byteOffset, 3);
    const joined = events.map((e) => Buffer.from(e.payload.data, "base64").toString()).join("");
    assert.equal(joined, "ABCDEFGH");
    assert.equal(events[0].eventId, "chunk:0-3");
  }

  // Resume from byte 3: bytes below the offset are read and discarded, the
  // stream itself always starts at 0 (verified 1.10.0 streamJob behavior).
  {
    const { transport } = makeStreamTransport();
    const events = [];
    for await (const e of transport.streamEvents(CLIENT_JOB_ID, { afterSeq: 3 })) events.push(e);
    assert.equal(events.length, 1);
    assert.equal(events[0].seq, 8);
    assert.equal(events[0].payload.byteOffset, 3);
    assert.equal(Buffer.from(events[0].payload.data, "base64").toString(), "DEFGH");
  }

  // A stream that errors mid-read propagates as a transport error.
  {
    const router = new FetchRouter();
    router.route(() =>
      ({ ok: false, status: 500 } as unknown as Response)
    );
    const transport = stockTransport(router);
    await assert.rejects(
      () => transport.streamEvents(CLIENT_JOB_ID).next(),
      PocketTransportHttpError
    );
  }
});

test("pocket-transport (bridge): streamEvents pages typed events server-side and ends on the terminal marker", async () => {
  const router = new FetchRouter();
  let poll = 0;
  router.route((url, method) => {
    if (method !== "GET" || !url.startsWith(`${BRIDGE}/jobs/${CLIENT_JOB_ID}/events`)) return null;
    poll += 1;
    if (poll === 1) {
      // Still running: one chunk page, no marker yet.
      return jsonResponse({
        jobId: CLIENT_JOB_ID,
        status: "running",
        events: [{ seq: 4, type: "provider_chunk", payload: { encoding: "base64", byteOffset: 0, data: Buffer.from("ABCD").toString("base64") } }],
        bytes: 4,
        final: false,
        truncated: false
      });
    }
    if (poll === 2) {
      // Resumed from byte 4; job finished: last chunk + result_ready marker.
      return jsonResponse({
        jobId: CLIENT_JOB_ID,
        status: "done",
        events: [
          { seq: 6, type: "provider_chunk", payload: { encoding: "base64", byteOffset: 4, data: Buffer.from("EF").toString("base64") } },
          { seq: 7, type: "result_ready", payload: { resultHash: "deadbeef", bytes: 6 } }
        ],
        bytes: 6,
        final: true,
        truncated: false
      });
    }
    return jsonResponse({ error: "should not be polled again" }, 500);
  });
  const transport = bridgeTransport(router);

  const events = [];
  for await (const e of transport.streamEvents(CLIENT_JOB_ID)) events.push(e);

  assert.equal(events.length, 3);
  // Page 1 must have honored nothing to discard; page 2 resumes server-side.
  assert.ok(router.calls[1]?.url.includes("afterSeq=4"), "second poll must resume at the last seq server-side");
  assert.equal(events[0].type, "provider_chunk");
  assert.equal(events[0].seq, 4);
  assert.equal(events[1].seq, 6);
  assert.equal(events[2].type, "result_ready");
  assert.equal(events[2].payload.resultHash, "deadbeef");
  assert.equal(events[2].seq, 7);
  // Typed events carry the contract envelope fields.
  assert.equal(events[0].jobId, CLIENT_JOB_ID);
  assert.ok(events[0].eventId.startsWith("provider_chunk:"));
  // Terminal marker ends the iteration — no further poll happens.
  assert.equal(poll, 2);
});

test("pocket-transport (bridge): truncated pages chain immediately until the final page", async () => {
  const router = new FetchRouter();
  let poll = 0;
  router.route((url, method) => {
    if (method !== "GET" || !url.startsWith(`${BRIDGE}/jobs/${CLIENT_JOB_ID}/events`)) return null;
    poll += 1;
    if (poll === 1) {
      return jsonResponse({
        jobId: CLIENT_JOB_ID,
        status: "done",
        events: [{ seq: 2, type: "provider_chunk", payload: { encoding: "base64", byteOffset: 0, data: Buffer.from("AB").toString("base64") } }],
        bytes: 6,
        final: false,
        truncated: true
      });
    }
    return jsonResponse({
      jobId: CLIENT_JOB_ID,
      status: "done",
      events: [
        { seq: 6, type: "provider_chunk", payload: { encoding: "base64", byteOffset: 2, data: Buffer.from("CDEF").toString("base64") } },
        { seq: 7, type: "result_ready", payload: { resultHash: "h", bytes: 6 } }
      ],
      bytes: 6,
      final: true,
      truncated: false
    });
  });
  const transport = bridgeTransport(router);
  const events = [];
  for await (const e of transport.streamEvents(CLIENT_JOB_ID)) events.push(e);
  assert.equal(events.length, 3);
  assert.ok(router.calls[1]?.url.includes("afterSeq=2"), "the truncated page must resume at seq 2");
  assert.equal(events.at(-1)?.type, "result_ready");
});

test("pocket-transport (unpatched): operations 1.10.0 never had throw instead of lying", async () => {
  const transport = stockTransport(new FetchRouter());
  await assert.rejects(() => transport.readResult("j"), PocketTransportUnavailableError);
  await assert.rejects(() => transport.acquireDeliveryLease("j"), PocketTransportUnavailableError);
  await assert.rejects(() => transport.renewDeliveryLease("j", "l"), PocketTransportUnavailableError);
  await assert.rejects(() => transport.finalize("j", {} as any), PocketTransportUnavailableError);
  await assert.rejects(() => transport.ackResult("j", "consumer", "hash"), PocketTransportUnavailableError);
});

test("pocket-transport (bridge): readResult returns the server-hashed journal receipt", async () => {
  const router = new FetchRouter();
  router.route((url, method) =>
    method === "GET" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}/result`
      ? jsonResponse({
          jobId: CLIENT_JOB_ID,
          status: "done",
          resultHash: "abc0123",
          bytes: 6,
          contentType: "text/event-stream",
          upstreamStatus: 200,
          generationId: "gen-1"
        })
      : null
  );
  const transport = bridgeTransport(router);
  const result = await transport.readResult(CLIENT_JOB_ID);
  assert.equal(result.jobId, CLIENT_JOB_ID);
  assert.equal(result.resultHash, "abc0123");
  assert.equal(result.finishReason, "stop");
  // The receipt references the journal; the bytes stay on the stream.
  assert.equal(result.payload.kind, "journal-ref");
  assert.equal(result.payload.bytes, 6);
  assert.equal(result.payload.upstreamStatus, 200);
});

test("pocket-transport (bridge): delivery leases acquire + renew with a stable owner identity", async () => {
  const router = new FetchRouter();
  const lease = {
    leaseId: "lease-9",
    ownerClientId: "client-a",
    fencingToken: "1",
    expiresAt: new Date(1_700_000_600_000).toISOString()
  };
  router.route((url, method) => {
    if (method === "POST" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}/lease`) {
      const body = JSON.parse(router.calls.at(-1)?.body ?? "{}");
      assert.equal(typeof body.ownerClientId, "string");
      assert.ok(body.ownerClientId.length > 0, "ownerClientId defaults to a minted UUIDv7");
      return jsonResponse(lease);
    }
    if (method === "POST" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}/lease/lease-9/renew`) {
      return jsonResponse({ ...lease, expiresAt: new Date(1_700_000_700_000).toISOString() });
    }
    return null;
  });
  const transport = new PocketModelJobsTransport(router.toFetchLike(), BASE, POCKET_1_10_0_CAPABILITIES, {
    ownerClientId: "client-a"
  });

  const acquired = await transport.acquireDeliveryLease(CLIENT_JOB_ID);
  assert.deepEqual(acquired, lease);

  const renewed = await transport.renewDeliveryLease(CLIENT_JOB_ID, "lease-9");
  assert.equal(renewed.leaseId, "lease-9");
  assert.equal(renewed.expiresAt, new Date(1_700_000_700_000).toISOString());
});

test("pocket-transport (bridge): finalize posts the proof seam and surfaces 409 refusals", async () => {
  const router = new FetchRouter();
  let attempt = 0;
  router.route((url, method) => {
    if (method !== "POST" || url !== `${BRIDGE}/jobs/${CLIENT_JOB_ID}/finalize`) return null;
    attempt += 1;
    if (attempt === 1) {
      const body = JSON.parse(router.calls.at(-1)?.body ?? "{}");
      assert.deepEqual(body, {
        leaseId: "lease-1",
        fencingToken: "2",
        materializationProof: { messageId: "m-1", chatRevision: 4, persistedAt: "2026-09-03T00:00:00.000Z", resultHash: "h1" }
      });
      return jsonResponse({ jobId: CLIENT_JOB_ID, status: "completed", resultHash: "h1", finalizedAt: "2026-09-03T00:00:01.000Z", replayed: false });
    }
    return jsonResponse({ error: "Fencing token mismatch (stale lease)", currentFencingToken: "3" }, 409);
  });
  const transport = bridgeTransport(router);

  const result = await transport.finalize(CLIENT_JOB_ID, {
    leaseId: "lease-1",
    fencingToken: "2",
    materializationProof: { messageId: "m-1", chatRevision: 4, persistedAt: "2026-09-03T00:00:00.000Z", resultHash: "h1" }
  });
  assert.deepEqual(result, { jobId: CLIENT_JOB_ID, status: "completed", error: undefined });

  // A stale token is the server's 409 — surfaced, never swallowed.
  await assert.rejects(
    () =>
      transport.finalize(CLIENT_JOB_ID, {
        leaseId: "lease-1",
        fencingToken: "1",
        materializationProof: { messageId: "m-2", chatRevision: 5, persistedAt: "2026-09-03T00:00:02.000Z" }
      }),
    (err: unknown) => err instanceof PocketTransportHttpError && err.status === 409
  );
});

test("pocket-transport (bridge): ackResult posts the verified consumer ACK", async () => {
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "POST" && url === `${BRIDGE}/jobs/${CLIENT_JOB_ID}/ack`) {
      const body = JSON.parse(router.calls.at(-1)?.body ?? "{}");
      assert.deepEqual(body, { consumerId: "consumer-1", consumerGroup: "risu-bg", resultHash: "h1" });
      return jsonResponse({ success: true, duplicate: false });
    }
    return null;
  });
  const transport = bridgeTransport(router);
  await transport.ackResult(CLIENT_JOB_ID, "consumer-1", "h1", "risu-bg");
  assert.ok(router.calls.some((c) => c.method === "POST" && c.url.endsWith("/ack")));
});

test("pocket-transport: getCapabilities prefers the patched endpoint, falls back to the verified matrix", async () => {
  // Patched server answers with its own (strictly valid) capabilities.
  const patchedRouter = new FetchRouter();
  patchedRouter.route((url) =>
    url.endsWith("/api/risu-bg-bridge/v1/capabilities")
      ? jsonResponse(POCKET_1_10_0_CAPABILITIES)
      : null
  );
  const patched = new PocketModelJobsTransport(patchedRouter.toFetchLike(), BASE);
  assert.deepEqual(await patched.getCapabilities(), POCKET_1_10_0_CAPABILITIES);

  // Unpatched 1.10.0: no capabilities route; report the adapter's verified
  // matrix rather than an unprovable guess.
  const bareRouter = new FetchRouter();
  bareRouter.route(() => jsonResponse({ error: "not found" }, 404));
  const bare = new PocketModelJobsTransport(bareRouter.toFetchLike(), BASE);
  assert.deepEqual(await bare.getCapabilities(), POCKET_1_10_0_CAPABILITIES);
  assert.equal(bareRouter.calls.length, 1, "only the capabilities probe, nothing else");
});

test("pocket-transport: bridge gating follows what the live server advertises, fail-closed", async () => {
  // A server whose probe answers a VALID matrix WITHOUT the bridge block
  // must not get bridge calls: after getCapabilities(), the transport falls
  // back to stock behavior for everything.
  const router = new FetchRouter();
  router.route((url, method) => {
    if (method === "GET" && url.endsWith("/api/risu-bg-bridge/v1/capabilities")) {
      const noBridge = JSON.parse(JSON.stringify(POCKET_1_10_0_CAPABILITIES));
      delete (noBridge as Record<string, unknown>).bridge;
      return jsonResponse(noBridge);
    }
    if (method === "POST" && url.endsWith("/api/model-jobs")) {
      return jsonResponse({ jobId: CLIENT_JOB_ID });
    }
    if (method === "GET" && url.endsWith(`/api/model-jobs/${CLIENT_JOB_ID}`)) {
      return jsonResponse(makeRow());
    }
    return null;
  });
  const transport = new PocketModelJobsTransport(router.toFetchLike(), BASE);
  await transport.getCapabilities(); // probe updates the gating matrix

  await transport.createJob(makeReq()); // must use the stock POST path
  assert.ok(router.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/model-jobs")));
  assert.ok(router.calls.every((c) => c.url !== `${BRIDGE}/jobs/${CLIENT_JOB_ID}`), "no bridge job call may happen");
  await assert.rejects(() => transport.acquireDeliveryLease(CLIENT_JOB_ID), PocketTransportUnavailableError);
});