import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { loadYamlFile } from "../scripts/lib/miniyaml.mjs";
import { loadSeries, planSeries } from "../scripts/lib/series.mjs";
import { kitRoot, findKitCache } from "./kit-cache-utils.js";

const pocketCache = findKitCache("pocket");
const skipNoCache = !pocketCache ? "no local pocket cache snapshot (targets/cache)" : false;

/**
 * Round-2 pins: the exact bridge schemas, statements, and fail-closed
 * invariants the series must install in model-jobs.cjs. These are textual
 * pins on purpose — the locked snapshot cannot be executed here (its
 * better-sqlite3/express runtime is not a kit dependency), so the contract
 * with the patch is pinned at the byte level and anything that drifts
 * (upstream refresh, series edit) fails loudly.
 */
test(
  "pocket-bridge: schema, statements, and invariants the series must install",
  { skip: skipNoCache },
  async () => {
    assert.ok(pocketCache);
    const series = await loadSeries(fs, path.join(kitRoot, "adapters", "pocket", "series.yaml"));
    const sources = new Map<string, string>();
    for (const step of series.steps) {
      if (!sources.has(step.file)) {
        sources.set(step.file, await fs.readFile(path.join(pocketCache, step.file), "utf8"));
      }
    }
    const patched = planSeries(series, sources).outputs.get("model-jobs.cjs");
    assert.ok(patched, "series must patch model-jobs.cjs");

    // ── schema (pocket-101): only digests + principal on model_jobs, plus
    //    the three bridge tables ────────────────────────────────────────────
    const step101 = series.steps.find((s) => s.id === "pocket-101");
    assert.ok(step101 && step101.content, "series must keep the pocket-101 schema step");
    const schema = step101.content as string;
    assert.match(schema, /ALTER TABLE model_jobs ADD COLUMN request_fingerprint TEXT/);
    assert.match(schema, /ALTER TABLE model_jobs ADD COLUMN principal_id TEXT/);
    // SECURITY: no new column may carry request material. The only string
    // columns added to model_jobs are the fingerprint digest + the principal.
    const alterLines = schema.split("\n").filter((l) => l.includes("ALTER TABLE model_jobs ADD COLUMN"));
    assert.equal(alterLines.length, 2, "exactly two new model_jobs columns: digest + principal");
    for (const forbidden of ["headers", "body", "target_url", "credential", "authorization"]) {
      assert.ok(
        !schema.toLowerCase().includes(`add column ${forbidden}`),
        `pocket-101 must never add a ${forbidden} column`
      );
    }
    for (const table of ["bg_delivery_leases", "bg_aux_acks", "bg_finalize_proofs"]) {
      assert.ok(schema.includes(`CREATE TABLE IF NOT EXISTS ${table} (`), `${table} must be created`);
    }
    // Fencing token is an INTEGER monotonically bumped by the server.
    assert.match(schema, /fencing_token INTEGER NOT NULL/);
    // The lease table is keyed by job (one live lease per job).
    assert.match(schema, /job_id TEXT PRIMARY KEY/);

    // ── statements + behaviors (pocket-102) ────────────────────────────────
    const step102 = series.steps.find((s) => s.id === "pocket-102");
    assert.ok(step102 && step102.content, "series must keep the pocket-102 store step");
    const store = step102.content as string;

    // Principal scoping is enforced in SQL, not by convention: every bridge
    // row query filters principal_id.
    assert.match(
      store,
      /UPDATE model_jobs SET request_fingerprint = \?, principal_id = \? WHERE id = \?/
    );
    assert.match(
      store,
      /WHERE kind = 'aux' AND status IN \('done', 'failed'\) AND claimed = 0 AND principal_id = \?/
    );
    for (const stmt of ["stmtLeaseGet", "stmtLeasePut", "stmtLeaseRenew", "stmtAckGet", "stmtAckPut", "stmtProofGet", "stmtProofPut", "stmtSetBridgeMeta", "stmtListAuxPending"]) {
      assert.ok(store.includes(`const ${stmt} = db.prepare(`), `${stmt} must be prepared`);
    }

    // PUT idempotency semantics: replay on same fingerprint, 409 on mismatch,
    // 409 fail-closed on fingerprint-less (stock) rows, 404 on foreign rows.
    assert.match(store, /if \(row\.request_fingerprint === fingerprint\)/);
    assert.ok(store.includes("Request fingerprint mismatch for existing job id"));
    assert.ok(store.includes("exists without a bridge fingerprint"));
    assert.ok(store.includes("row.principal_id !== principalId"));

    // Fencing: acquire bumps the previous token (expired or absent → prev+1),
    // finalize compares the exact current token and lease.
    assert.match(store, /\(lease \? Number\(lease\.fencing_token\) : 0\) \+ 1/);
    assert.match(store, /String\(lease\.fencing_token\) !== fencingToken/);
    assert.ok(store.includes("Fencing token mismatch (stale lease)"));
    assert.ok(store.includes("Lease expired; finalization refused"));

    // The finalize seam records client-asserted materialization fields but
    // verifies the server-verifiable part (journal hash + lease).
    assert.ok(store.includes("stmtProofPut.run("));
    assert.ok(store.includes("materializationProof requires messageId, chatRevision and persistedAt"));
    assert.ok(store.includes("Result hash mismatch against the journal"));

    // Aux ACK verifies a provided hash against the journal before recording.
    assert.ok(store.includes("Already acknowledged with a different result hash"));
    // One ACK row per (job, consumer): pinned in pocket-101's DDL.
    assert.match(schema, /PRIMARY KEY \(job_id, consumer_id\)/);

    // Typed events: provider_chunk seq = end byte offset; afterSeq honored
    // server-side; one terminal marker (result_ready / error) on the final
    // page; a byte budget with a truncated flag.
    assert.match(store, /seq: offset \+ bytesRead/);
    assert.match(store, /TERMINAL_STATUSES\.includes\(row\.status\) && !truncated && afterSeq <= bytes/);
    assert.match(store, /type: 'result_ready'/);
    assert.match(store, /type: 'error'/);
    assert.ok(store.includes("truncated = true"));

    // registerBridgeRoutes refuses to run unscoped (no principal → TypeError).
    assert.ok(store.includes("requires a non-empty principalId"));

    // ── patched-file invariants (cross-step) ────────────────────────────────
    // Restart recovery stays fail-closed: the boot policy of failing running
    // jobs is untouched, and nothing in the patch reconstructs requests.
    assert.match(patched, /function markRunningJobsFailed\(reason = 'server restart'\)/);
    assert.match(patched, /^\s{4}markRunningJobsFailed\(\);/m);
    assert.ok(
      !patched.includes("markRunningJobsSucceeded"),
      "the patch must not soften the fail-closed boot policy"
    );
    // registerBridgeRoutes is exported for server.cjs wiring.
    assert.match(patched, /registerBridgeRoutes,/);

    // SECURITY (whole patched file): no raw request material may reach a
    // persistence call. Headers/body flow only to normalizeUpstreamHeaders /
    // the fingerprint hash / the upstream fetch — never into db.exec or a
    // prepared .run/.get of the bridge statements.
    const persistedCalls = patched.match(/stmt(?:Insert|SetBridgeMeta|LeasePut|LeaseRenew|AckPut|ProofPut|Claim|Delete)\.run\(/g) ?? [];
    assert.ok(persistedCalls.length > 0, "sanity: patched file still contains the stock + bridge writes");
    for (const leak of [
      "stmtInsert.run(jobId, chatId, arg.headers",
      "JSON.stringify(arg.headers)",
      "JSON.stringify(arg.body)",
      "arg.body, principalId"
    ]) {
      assert.ok(!patched.includes(leak), `raw request material must never be persisted: ${leak}`);
    }
  }
);

test(
  "pocket-bridge: server.cjs wiring pins the principal + capability honesty",
  { skip: skipNoCache },
  async () => {
    assert.ok(pocketCache);
    const series = await loadSeries(fs, path.join(kitRoot, "adapters", "pocket", "series.yaml"));
    const sources = new Map<string, string>();
    for (const step of series.steps) {
      if (!sources.has(step.file)) {
        sources.set(step.file, await fs.readFile(path.join(pocketCache, step.file), "utf8"));
      }
    }
    const patchedServer = planSeries(series, sources).outputs.get("server.cjs");
    assert.ok(patchedServer, "series must patch server.cjs");
    const step002 = series.steps.find((s) => s.id === "pocket-002");
    assert.ok(step002 && step002.content, "series must keep the pocket-002 wiring step");
    const wiring = step002.content as string;

    // The principal is the existing non-secret host identity, not a new
    // identity store: pocket-host:<instanceId>.
    assert.match(wiring, /const bgBridgePrincipal = `pocket-host:\$\{instanceId\}`;/);
    assert.match(wiring, /registerBridgeRoutes\(app, \{ auth: checkProxyAuth, principalId: bgBridgePrincipal \}\)/);

    // Bridge routes are registered under /proxy2-level auth, same as the
    // stock model-jobs surface they extend.
    assert.ok(wiring.includes("checkProxyAuth"));

    // The served capabilities keep the two honest negatives:
    assert.match(wiring, /restartRecovery: false/);
    assert.match(wiring, /durableFinalization: false/);
    assert.match(wiring, /restartRecovery: 'fail-closed-no-secret-persistence'/);
    assert.match(wiring, /finalizeProof: 'client-asserted-generationId\+server-verified-resultHash'/);

    // And the strict validator's required adapter block is present.
    assert.match(wiring, /target: 'pocket'/);
    assert.match(wiring, /version: '1\.10\.0-bgbridge'/);
  }
);