#!/usr/bin/env node
// apply.mjs — apply a patch series to a verified target snapshot.
//
// Usage:
//   node scripts/apply.mjs --series adapters/pocket/series.yaml --out <dir> [--check]
//
// Guarantees, in order:
//   1. The series file is structurally valid (loadSeries, fail-closed).
//   2. The lock named by the series loads, passes the AGENTS.md version
//      gate, hash-verifies against the cache snapshot, and agrees with
//      INVENTORY.json (verifyLockAgainstCache).
//   3. Every step targets a file that the lock actually pins — a series may
//      never touch an unpinned file.
//   4. All steps are planned in memory first; a single anchor failure means
//      nothing is written.
//   5. The output directory is never the cache itself and never contains
//      unrelated files that would be silently overwritten.
//
// --check plans and prints the result without writing anything.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLock, verifyLockAgainstCache } from "./lib/lock.mjs";
import { loadYamlFile } from "./lib/miniyaml.mjs";
import { applySeries, loadSeries, planSeries } from "./lib/series.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const targetsDir = path.join(repoRoot, "targets");

function die(message) {
  console.error(`apply: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--series") out.series = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--check") out.check = true;
    else die(`unknown argument: ${a}`);
  }
  if (!out.series) die("missing required --series <path>");
  if (!out.out) die("missing required --out <dir>");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const seriesPath = path.resolve(args.series);
const outDir = path.resolve(args.out);

// 1. Series structure.
const series = await loadSeries(fs.promises, seriesPath).catch((err) => die(err.message));
console.log(`apply: series '${series.series}' (${series.steps.length} steps, target '${series.target}')`);

// 2. Lock + snapshot verification.
const lockPath = path.isAbsolute(series.lock) ? series.lock : path.join(targetsDir, series.lock);
const deps = { fs: fs.promises, yaml: { loadYamlFile } };
const lock = await loadLock(deps, lockPath, path.join(targetsDir, "lock-schema.json")).catch((err) =>
  die(err.message)
);
const cacheRoot = path.join(targetsDir, "cache");
const candidates = [];
if (fs.existsSync(cacheRoot)) {
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inv = path.join(cacheRoot, entry.name, "INVENTORY.json");
    if (fs.existsSync(inv)) {
      try {
        if (JSON.parse(fs.readFileSync(inv, "utf8")).target === series.target) {
          candidates.push(path.join(cacheRoot, entry.name));
        }
      } catch {
        /* unreadable inventory — not a candidate */
      }
    }
  }
}
if (candidates.length !== 1) {
  die(`expected exactly one cache snapshot for target '${series.target}', found ${candidates.length}`);
}
const cacheDir = candidates[0];
const verifyReport = await verifyLockAgainstCache(fs.promises, lock, cacheDir).catch((err) => die(err.message));
console.log(`apply: lock verified against ${cacheDir}`);
if (lock.target !== series.target) {
  die(`series target '${series.target}' does not match lock target '${lock.target}'`);
}

// 3. Every step file must be pinned by the lock.
for (const step of series.steps) {
  if (!Object.prototype.hasOwnProperty.call(lock.files, step.file)) {
    die(
      `step '${step.id}' targets '${step.file}', which the lock does not pin. ` +
        `A series may only patch files hash-verified in ${path.basename(lockPath)}.`
    );
  }
}

// 4. Plan in memory against the pristine snapshot.
const sources = new Map();
for (const step of series.steps) {
  if (sources.has(step.file)) continue;
  sources.set(
    step.file,
    await fs.promises.readFile(path.join(cacheDir, step.file), "utf8")
  );
}

let plan;
try {
  plan = planSeries(series, sources);
} catch (err) {
  die(`planning failed — nothing was written:\n${err.message}`);
}

for (const r of plan.results) {
  console.log(`apply:   ${r.id} -> ${r.action} (${r.file})`);
}
const appliedCount = plan.results.filter((r) => r.action === "applied").length;
const alreadyCount = plan.results.filter((r) => r.action === "already-applied").length;
console.log(`apply: plan OK — ${appliedCount} to apply, ${alreadyCount} already applied`);

if (args.check) {
  console.log("apply: --check given; nothing written.");
  process.exit(0);
}

// 5. Output directory safety.
const relOut = path.relative(cacheDir, outDir);
if (relOut === "" || (!relOut.startsWith("..") && !path.isAbsolute(relOut))) {
  die(`--out (${outDir}) is inside the cache snapshot (${cacheDir}) — refusing to write there`);
}
if (fs.existsSync(outDir)) {
  const allowed = new Set([...plan.outputs.keys()]);
  const stray = fs.readdirSync(outDir).filter((name) => !allowed.has(name));
  if (outDir === cacheDir || stray.length > 0) {
    die(
      `--out (${outDir}) exists and contains entries not produced by this series ` +
        `(first stray: ${stray[0] ?? outDir}). Refusing to overwrite unrelated content.`
    );
  }
  console.log(`apply: output directory holds only files this series produces; rebuilding in place`);
} else {
  fs.mkdirSync(outDir, { recursive: true });
}

// Phase 2: the only disk write.
const written = await applySeries(fs.promises, plan, outDir);
console.log(`apply: wrote ${written.length} file(s) to ${outDir}`);
console.log(`apply: done — series '${series.series}' applied against ${lock.upstream.product} ${lock.upstream.version}`);