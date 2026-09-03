#!/usr/bin/env node
// rebase-check.mjs — after an upstream refresh, classify a patch series
// against a snapshot without writing anything.
//
// Usage:
//   node scripts/rebase-check.mjs --series adapters/pocket/series.yaml
//
// Exit 0  — every step would apply cleanly or is already applied.
// Exit 1  — at least one step is ambiguous or its anchor no longer resolves:
//           the series must be REBASED by a human against the new source.
//           The message names the first failing step and its counts.
//
// This is a thin operator-facing wrapper over the same planSeries engine
// apply.mjs uses — one engine, two entry points, no divergent semantics.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLock, verifyLockAgainstCache } from "./lib/lock.mjs";
import { loadYamlFile } from "./lib/miniyaml.mjs";
import { loadSeries, planSeries } from "./lib/series.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const targetsDir = path.join(repoRoot, "targets");

function die(message) {
  console.error(`rebase-check: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--series") out.series = argv[++i];
    else die(`unknown argument: ${a}`);
  }
  if (!out.series) die("missing required --series <path>");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const seriesPath = path.resolve(args.series);

const series = await loadSeries(fs.promises, seriesPath).catch((err) => die(err.message));
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
        /* not a candidate */
      }
    }
  }
}
if (candidates.length !== 1) {
  die(`expected exactly one cache snapshot for target '${series.target}', found ${candidates.length}`);
}
const cacheDir = candidates[0];
await verifyLockAgainstCache(fs.promises, lock, cacheDir).catch((err) =>
  die(`snapshot no longer matches the lock — the snapshot itself has drifted:\n${err.message}`)
);

for (const step of series.steps) {
  if (!Object.prototype.hasOwnProperty.call(lock.files, step.file)) {
    die(`step '${step.id}' targets '${step.file}', which the lock does not pin`);
  }
}

const sources = new Map();
for (const step of series.steps) {
  if (!sources.has(step.file)) {
    sources.set(step.file, await fs.promises.readFile(path.join(cacheDir, step.file), "utf8"));
  }
}

try {
  const plan = planSeries(series, sources);
  for (const r of plan.results) {
    console.log(`rebase-check: ${r.id}: ${r.action}`);
  }
  const applied = plan.results.filter((r) => r.action === "applied").length;
  const already = plan.results.filter((r) => r.action === "already-applied").length;
  console.log(`rebase-check: series applies cleanly — ${applied} to apply, ${already} already applied. No rebase needed.`);
} catch (err) {
  die(
    `series does NOT apply cleanly against the current snapshot.\n` +
      `${err.message}\n` +
      `rebase-check: rewrite the failing step's anchors against the new source, or extend the series with a new step. Never relax the count checks.`
  );
}