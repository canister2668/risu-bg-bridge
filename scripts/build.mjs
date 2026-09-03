#!/usr/bin/env node
// build.mjs — produce a verified, reproducible Docker build context for a
// locked target.
//
// Usage:
//   node scripts/build.mjs --target pocket --out /path/to/context
//
// What it does, in order — every step fails closed:
//   1. Verify the target's lock against its cache snapshot (hashes, package
//      identity, INVENTORY cross-check, AGENTS.md version gate).
//   2. Plan the adapter series in memory against the pristine snapshot.
//   3. Check the adapter Dockerfile: its FROM must equal the locked imageRef
//      and its COPY source lines must be exactly the files the series
//      patches — no more, no less — so the Dockerfile cannot drift behind a
//      series edit.
//   4. Write the patched files plus the Dockerfile into the context
//      directory, and a BUILD-MANIFEST.json recording lock hashes, series
//      hash, applied steps, and the pinned image identity.
//
// It never runs docker itself; it prints the exact docker build command for
// a human (or CI) to run. Building an image is a local operation, but the
// kit keeps the boundary explicit.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { loadLock, verifyLockAgainstCache } from "./lib/lock.mjs";
import { loadYamlFile } from "./lib/miniyaml.mjs";
import { applySeries, loadSeries, planSeries } from "./lib/series.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const targetsDir = path.join(repoRoot, "targets");

function die(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else die(`unknown argument: ${a}`);
  }
  if (!out.target) die("missing required --target <pocket|...>");
  if (!out.out) die("missing required --out <dir>");
  return out;
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
const target = args.target;
const outDir = path.resolve(args.out);
const lockPath = path.join(targetsDir, `${target}.lock.yaml`);
const seriesPath = path.join(repoRoot, "adapters", target, "series.yaml");
const dockerfilePath = path.join(repoRoot, "adapters", target, "Dockerfile");

for (const p of [lockPath, seriesPath, dockerfilePath]) {
  if (!fs.existsSync(p)) die(`missing ${p} — target '${target}' has no lock/series/Dockerfile kit`);
}

// 1. Lock verification (includes AGENTS.md version gate via loadLock).
const deps = { fs: fs.promises, yaml: { loadYamlFile } };
const lock = await loadLock(deps, lockPath, path.join(targetsDir, "lock-schema.json")).catch((err) =>
  die(err.message)
);
const cacheRoot = path.join(targetsDir, "cache");
const candidates = fs
  .readdirSync(cacheRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => path.join(cacheRoot, e.name))
  .filter((dir) => {
    const inv = path.join(dir, "INVENTORY.json");
    if (!fs.existsSync(inv)) return false;
    try {
      return JSON.parse(fs.readFileSync(inv, "utf8")).target === target;
    } catch {
      return false;
    }
  });
if (candidates.length !== 1) {
  die(`expected exactly one cache snapshot for target '${target}', found ${candidates.length}`);
}
const cacheDir = candidates[0];
await verifyLockAgainstCache(fs.promises, lock, cacheDir).catch((err) =>
  die(`lock verification failed:\n${err.message}`)
);
console.log(`build: lock verified — ${lock.upstream.product} ${lock.upstream.version} (${lock.source.imageRef})`);

// 2. Plan the series in memory.
const series = await loadSeries(fs.promises, seriesPath).catch((err) => die(err.message));
if (series.target !== target) die(`series target '${series.target}' != --target '${target}'`);
const sources = new Map();
for (const step of series.steps) {
  if (!sources.has(step.file)) {
    sources.set(step.file, await fs.promises.readFile(path.join(cacheDir, step.file), "utf8"));
  }
}
const plan = (() => {
  try {
    return planSeries(series, sources);
  } catch (err) {
    die(`planning failed:\n${err.message}`);
  }
})();
const touched = [...plan.touched].sort();
console.log(`build: series '${series.series}' plans cleanly (${touched.length} file(s): ${touched.join(", ")})`);

// 3. Dockerfile consistency: FROM must match the lock; COPY set must equal
//    the series's touched files exactly.
const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
const fromMatch = /^FROM\s+(\S+)\s*$/m.exec(dockerfile);
if (!fromMatch) die(`no FROM line in ${dockerfilePath}`);
if (fromMatch[1] !== lock.source.imageRef) {
  die(`Dockerfile FROM '${fromMatch[1]}' != locked imageRef '${lock.source.imageRef}'`);
}
const copySources = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+\S+\s*$/gm)].map((m) => m[1]).sort();
if (copySources.join(",") !== touched.join(",")) {
  die(
    `Dockerfile COPY lines do not match the series:\n` +
      `  Dockerfile copies: ${copySources.join(", ") || "(none)"}\n` +
      `  series patches:     ${touched.join(", ")}\n` +
      `Update ${dockerfilePath} to match adapters/${target}/series.yaml.`
  );
}
console.log(`build: Dockerfile FROM/COPY verified against the lock and series`);

// 4. Materialize the context.
if (fs.existsSync(outDir)) {
  const allowed = new Set([...plan.outputs.keys(), "Dockerfile", "BUILD-MANIFEST.json"]);
  const stray = fs.readdirSync(outDir).filter((name) => !allowed.has(name));
  if (stray.length > 0) {
    die(`--out ${outDir} exists and contains unrelated entries (first: ${stray[0]}); refusing to overwrite`);
  }
} else {
  fs.mkdirSync(outDir, { recursive: true });
}

const written = await applySeries(fs.promises, plan, outDir);
fs.copyFileSync(dockerfilePath, path.join(outDir, "Dockerfile"));

const manifest = {
  target,
  upstream: { product: lock.upstream.product, version: lock.upstream.version },
  source: {
    imageRef: lock.source.imageRef,
    imageId: lock.source.imageId,
    lockSha256: sha256File(lockPath),
    seriesSha256: sha256File(seriesPath),
    dockerfileSha256: sha256File(dockerfilePath),
    cacheSnapshot: path.relative(repoRoot, cacheDir),
  },
  series: series.series,
  steps: plan.results.map((r) => ({ id: r.id, file: r.file, action: r.action })),
  tool: "risu-bg-extension scripts/build.mjs",
  builtAt: new Date().toISOString().slice(0, 10),
};
fs.writeFileSync(path.join(outDir, "BUILD-MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`build: context written to ${outDir}`);
for (const f of written) console.log(`build:   ${path.relative(outDir, f)}`);
console.log(`build:   Dockerfile`);
console.log(`build:   BUILD-MANIFEST.json`);
console.log(
  `build: build the image with: docker build -t ${lock.upstream.product.toLowerCase()}-${lock.upstream.version}-bgbridge ${outDir}`
);