import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadYamlFile } from "../scripts/lib/miniyaml.mjs";
import { loadLock, verifyLockAgainstCache } from "../scripts/lib/lock.mjs";
import { loadSeries, planSeries, applySeries } from "../scripts/lib/series.mjs";
import { kitRoot, targetsDir, findKitCache } from "./kit-cache-utils.js";

const execFileAsync = promisify(execFile);
const deps = { fs, yaml: { loadYamlFile } };
const pocketCache = findKitCache("pocket");
const skipNoCache = !pocketCache ? "no local pocket cache snapshot (targets/cache)" : false;

/** Round-2 shape of the shipped series, in order. */
const EXPECTED_STEPS = [
  "pocket-001",
  "pocket-002",
  "pocket-101",
  "pocket-102",
  "pocket-103",
  "pocket-104"
];

/**
 * The real shipped series against the real hash-verified 1.10.0 snapshot.
 * This is the strongest test in the kit: it proves the exact patched bytes
 * the adapter kit would ship are producible today, are idempotent, and are
 * syntactically valid JavaScript.
 */
test(
  "pocket-series: plans, applies idempotently, and produces syntactically valid patches",
  { skip: skipNoCache },
  async () => {
    assert.ok(pocketCache);
    const seriesPath = path.join(kitRoot, "adapters", "pocket", "series.yaml");
    const lockPath = path.join(targetsDir, "pocket.lock.yaml");

    const series = await loadSeries(fs, seriesPath);
    assert.equal(series.series, "pocket-1.10.0-bgbridge");
    assert.equal(series.target, "pocket");
    assert.equal(series.lock, "pocket.lock.yaml");
    assert.deepEqual(
      series.steps.map((s) => s.id),
      EXPECTED_STEPS
    );

    // Every step may only touch a file the lock pins (apply.mjs rule, verified
    // here at the lib level so the guarantee is not CLI-only).
    const lock = await loadLock(deps, lockPath, path.join(targetsDir, "lock-schema.json"));
    for (const step of series.steps) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(lock.files, step.file),
        `step ${step.id} targets unpinned file ${step.file}`
      );
    }

    // The snapshot still hash-verifies against the lock (this also re-runs
    // the AGENTS.md exact-1.10.0 gate inside loadLock).
    await verifyLockAgainstCache(fs, lock, pocketCache);

    // Phase 1 against pristine sources.
    const sources = new Map<string, string>();
    for (const step of series.steps) {
      if (!sources.has(step.file)) {
        sources.set(step.file, await fs.readFile(path.join(pocketCache, step.file), "utf8"));
      }
    }
    const pristine = planSeries(series, sources);
    assert.deepEqual(
      pristine.results.map((r) => `${r.id}:${r.action}`),
      EXPECTED_STEPS.map((id) => `${id}:applied`),
      "every step must apply against the pristine 1.10.0 snapshot"
    );

    // Idempotence: replanning against the patched output is already-applied
    // with byte-identical results.
    const replanned = planSeries(series, pristine.outputs);
    assert.deepEqual(
      replanned.results.map((r) => `${r.id}:${r.action}`),
      EXPECTED_STEPS.map((id) => `${id}:already-applied`)
    );
    for (const [file, content] of pristine.outputs) {
      assert.equal(replanned.outputs.get(file), content);
    }

    // The patches contain exactly what they claim.
    const patchedWorker = pristine.outputs.get("bg-worker.cjs");
    const patchedServer = pristine.outputs.get("server.cjs");
    const patchedModelJobs = pristine.outputs.get("model-jobs.cjs");
    assert.ok(patchedWorker && patchedWorker.includes("upstreamTruncated"));
    assert.ok(
      patchedWorker.includes("LLM stream closed before a completion signal; partial output was discarded")
    );
    assert.ok(patchedServer && patchedServer.includes("app.get('/api/risu-bg-bridge/v1/capabilities'"));
    // The route registers at server.cjs top level (column 0), matching the
    // locked source's own route registration style.
    assert.match(patchedServer, /^app\.get\('\/api\/risu-bg-bridge\/v1\/capabilities'/m);
    // The server wires the bridge with the authenticated host principal.
    assert.ok(patchedServer.includes("modelJobs.registerBridgeRoutes(app, { auth: checkProxyAuth, principalId: bgBridgePrincipal })"));
    assert.ok(patchedModelJobs);

    // Round-2 bridge content in model-jobs.cjs: schema, statements, routes.
    assert.match(patchedModelJobs, /ALTER TABLE model_jobs ADD COLUMN request_fingerprint TEXT/);
    assert.match(patchedModelJobs, /ALTER TABLE model_jobs ADD COLUMN principal_id TEXT/);
    assert.match(patchedModelJobs, /CREATE TABLE IF NOT EXISTS bg_delivery_leases/);
    assert.match(patchedModelJobs, /CREATE TABLE IF NOT EXISTS bg_aux_acks/);
    assert.match(patchedModelJobs, /CREATE TABLE IF NOT EXISTS bg_finalize_proofs/);
    for (const route of [
      "app.put('/api/risu-bg-bridge/v1/jobs/:id'",
      "app.get('/api/risu-bg-bridge/v1/jobs/:id'",
      "app.get('/api/risu-bg-bridge/v1/jobs/:id/events'",
      "app.get('/api/risu-bg-bridge/v1/jobs/:id/result'",
      "app.post('/api/risu-bg-bridge/v1/jobs/:id/lease'",
      "app.post('/api/risu-bg-bridge/v1/jobs/:id/lease/:leaseId/renew'",
      "app.post('/api/risu-bg-bridge/v1/jobs/:id/finalize'",
      "app.post('/api/risu-bg-bridge/v1/jobs/:id/ack'",
      "app.get('/api/risu-bg-bridge/v1/aux/pending'"
    ]) {
      assert.ok(patchedModelJobs.includes(route), `model-jobs.cjs must register ${route}`);
    }
    // The fingerprint stamp lives inside createJob (between the insert and
    // activeJobs.set), proving it is part of the same synchronous section.
    const createJobBody = patchedModelJobs.slice(
      patchedModelJobs.indexOf("function createJob(arg)")
    );
    assert.ok(createJobBody.includes("stmtInsert.run("));
    assert.ok(createJobBody.includes("stmtSetBridgeMeta.run("));
    assert.ok(
      createJobBody.indexOf("stmtInsert.run(") < createJobBody.indexOf("stmtSetBridgeMeta.run(")
    );
    assert.ok(
      createJobBody.indexOf("stmtSetBridgeMeta.run(") < createJobBody.indexOf("activeJobs.set(jobId, job)"),
      "bridge meta must be stamped in the same synchronous section as the insert"
    );
    // registerBridgeRoutes is exported.
    assert.match(patchedModelJobs, /return \{\s*\n\s*registerRoutes,\s*\n\s*registerBridgeRoutes,/);

    // SECURITY invariant: the persisted columns are digest + principal only;
    // the patched file must never persist raw request material.
    for (const forbidden of [
      "INSERT INTO model_jobs (target_url",
      "INSERT INTO model_jobs (headers",
      "request_headers",
      "request_body"
    ]) {
      assert.ok(!patchedModelJobs.includes(forbidden), `patched model-jobs must not persist ${forbidden}`);
    }

    // Phase 2 writes, then the patched files must parse as JavaScript.
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-pocketseries-"));
    await applySeries(fs, pristine, outDir);
    for (const file of pristine.outputs.keys()) {
      const { stdout, stderr } = await execFileAsync("node", ["--check", path.join(outDir, file)]);
      assert.equal(stderr, "", `node --check ${file} reported errors`);
      assert.equal(stdout, "");
    }
  }
);

test(
  "pocket-series: the rebase-check CLI reports the shipped series as clean",
  { skip: skipNoCache },
  async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [path.join(kitRoot, "scripts", "rebase-check.mjs"), "--series", path.join(kitRoot, "adapters", "pocket", "series.yaml")],
      { cwd: kitRoot }
    );
    for (const id of EXPECTED_STEPS) {
      assert.match(stdout, new RegExp(`${id}: applied`));
    }
    assert.match(stdout, /applies cleanly/);
  }
);

// NOTE: drift is deliberately NOT tested through the CLI. The CLI discovers
// its snapshot by scanning targets/cache for INVENTORY.json, and creating a
// fixture directory there — even transiently — could make a concurrent
// session's verify/apply run see two candidates and fail. Snapshot drift is
// covered at the library level in kit-locks (hash mismatch, missing INVENTORY,
// cross-record disagreement) and kit-apply (anchor count drift).