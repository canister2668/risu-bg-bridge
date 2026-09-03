#!/usr/bin/env node
// verify.mjs — fail-closed verification of a target lock against its cache
// snapshot (and, transitively, the AGENTS.md version gate via loadLock).
//
// Usage:
//   node scripts/verify.mjs --target pocket
//   node scripts/verify.mjs --target all
//   node scripts/verify.mjs --lock targets/pocket.lock.yaml
//
// Exit code 0 only when every listed lock loads, passes its version gate,
// matches the snapshot's package identity, hash-verifies every pinned file,
// and agrees with INVENTORY.json. Anything else exits 1 with the exact
// failures — including when a target has only a declared record and no lock.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLock, verifyLockAgainstCache } from "./lib/lock.mjs";
import { loadYamlFile } from "./lib/miniyaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const targetsDir = path.join(repoRoot, "targets");
const schemaPath = path.join(targetsDir, "lock-schema.json");

function die(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--lock") out.lock = argv[++i];
    else die(`unknown argument: ${a}`);
  }
  if (!out.target && !out.lock) die("pass --target <name|all> or --lock <path>");
  return out;
}

function listLocks() {
  return fs
    .readdirSync(targetsDir)
    .filter((f) => f.endsWith(".lock.yaml"))
    .sort();
}

function cacheDirFor(lockName) {
  // Conventional layout: targets/cache/<dir>/ holds the snapshot named in
  // the lock's imageRef lineage. The lock does not store the cache path, so
  // discover it: exactly one cache dir whose INVENTORY.target matches.
  const cacheRoot = path.join(targetsDir, "cache");
  if (!fs.existsSync(cacheRoot)) return null;
  const matches = [];
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inv = path.join(cacheRoot, entry.name, "INVENTORY.json");
    if (!fs.existsSync(inv)) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(inv, "utf8"));
      const lockTarget = lockName.replace(/\.lock\.yaml$/, "");
      if (doc.target === lockTarget) matches.push(path.join(cacheRoot, entry.name));
    } catch {
      // unreadable inventory -> not a candidate
    }
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    die(`multiple cache snapshots claim target for '${lockName}':\n  ${matches.join("\n  ")}`);
  }
  return matches[0];
}

async function verifyOne(lockPath) {
  const deps = { fs: fs.promises, yaml: { loadYamlFile } };
  const lock = await loadLock(deps, lockPath, schemaPath);
  const cacheDir = cacheDirFor(path.basename(lockPath));
  if (!cacheDir) {
    die(`no cache snapshot found for lock '${lockPath}' (expected targets/cache/*/INVENTORY.json with matching target)`);
  }
  const report = await verifyLockAgainstCache(fs.promises, lock, cacheDir);
  console.log(`verify: OK ${path.basename(lockPath)}`);
  for (const line of report) console.log(`  ${line}`);
  return { lockPath, cacheDir };
}

const args = parseArgs(process.argv.slice(2));
const lockFiles = [];
if (args.lock) {
  lockFiles.push(path.resolve(args.lock));
} else if (args.target === "all") {
  lockFiles.push(...listLocks().map((f) => path.join(targetsDir, f)));
  if (lockFiles.length === 0) die("no *.lock.yaml files exist under targets/");
} else {
  const p = path.join(targetsDir, `${args.target}.lock.yaml`);
  if (!fs.existsSync(p)) {
    const declared = fs
      .readdirSync(targetsDir)
      .filter((f) => f.endsWith(".declared.yaml"))
      .join(", ");
    die(
      `no lock for target '${args.target}' (${p} missing).` +
        (declared ? ` Declared-only records (no lock, nothing verifiable): ${declared}.` : "")
    );
  }
  lockFiles.push(p);
}

const results = [];
try {
  for (const lockPath of lockFiles) {
    results.push(await verifyOne(lockPath));
  }
} catch (err) {
  die(err.message);
}

console.log(`verify: ${results.length} lock(s) verified, all gates passed.`);