#!/usr/bin/env node
// gen-lock.mjs — generate a target lock (targets/<target>.lock.yaml) from a
// hand-authored meta file plus a snapshot's INVENTORY.json.
//
// The meta file carries everything requiring human judgment (upstream
// claims, source identity, package identity, verified notes, honest gaps).
// The file-hash block is generated strictly from INVENTORY.json so the lock
// and the extraction record can never drift apart silently —
// verifyLockAgainstCache cross-checks both at runtime.
//
// Usage:
//   node scripts/gen-lock.mjs \
//     --meta targets/pocket.lock-meta.json \
//     --inventory targets/cache/pocket-1.10.0-nodeonly-20260829/INVENTORY.json \
//     --out targets/pocket.lock.yaml
//
// Fails closed on: schema violations in the meta, any inventory hash that
// does not look like a sha256 hex digest, or a generated lock that cannot be
// re-parsed and re-validated by loadLock (round-trip self-check).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLock, validateNode } from "./lib/lock.mjs";
import { loadYamlFile } from "./lib/miniyaml.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function die(message) {
  console.error(`gen-lock: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--meta") out.meta = argv[++i];
    else if (a === "--inventory") out.inventory = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else die(`unknown argument: ${a}`);
  }
  for (const key of ["meta", "inventory", "out"]) {
    if (!out[key]) die(`missing required --${key}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal YAML emitter for the lock schema's shape (nested maps two levels
// deep, string lists, and one map of path -> sha256 hex). Output is quoted
// everywhere so the strict mini-YAML parser round-trips it exactly.
// ---------------------------------------------------------------------------

function q(value) {
  return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function emitScalar(value) {
  if (value === null || value === undefined) return "null";
  return q(value);
}

function emitMeta(meta, out) {
  out.push(`target: ${emitScalar(meta.target)}`);
  out.push(`lockFormat: ${meta.lockFormat}`);
  out.push(`status: ${emitScalar(meta.status)}`);
  for (const group of ["upstream", "source", "package"]) {
    out.push(`${group}:`);
    for (const [k, v] of Object.entries(meta[group])) {
      out.push(`  ${q(k)}: ${emitScalar(v)}`);
    }
  }
}

function emitFiles(files, out) {
  out.push(`files:`);
  for (const relPath of Object.keys(files).sort()) {
    out.push(`  ${q(relPath)}: ${files[relPath]}`);
  }
}

function emitStringList(name, values, out) {
  out.push(`${name}:`);
  for (const v of values) out.push(`  - ${q(v)}`);
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const schemaPath = path.join(repoRoot, "targets", "lock-schema.json");
const rootSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8")).root;

// Validate the meta against the schema with `files` removed (it is generated,
// not authored); every other rule applies to the meta as-is.
const metaSchema = { ...rootSchema, required: rootSchema.required.filter((k) => k !== "files") };
metaSchema.properties = { ...rootSchema.properties };
delete metaSchema.properties.files;

const meta = JSON.parse(fs.readFileSync(args.meta, "utf8"));
const failures = [];
validateNode(meta, metaSchema, "meta", failures);
if (!Array.isArray(meta.notes) || meta.notes.length === 0) {
  failures.push("meta: notes must be a non-empty list");
}
if (!Array.isArray(meta.gaps) || meta.gaps.length === 0) {
  failures.push("meta: gaps must be a non-empty list");
}
if (meta.status !== "verified-local" && !failures.some((f) => f.includes("status"))) {
  // Non-verified locks are allowed as documentation, but they must not be
  // generated with a files block pretending to pin anything.
  failures.push(`meta: this generator only produces verified-local locks (status is '${meta.status}'); use a declared.yaml document for unverifiable targets`);
}
if (failures.length > 0) die(`meta schema violations:\n  - ` + failures.join("\n  - "));

// Inventory hashes must all look like sha256 hex digests.
const inventory = JSON.parse(fs.readFileSync(args.inventory, "utf8"));
const files = inventory?.files;
if (!files || Object.keys(files).length === 0) die("inventory has no files");
for (const [relPath, hash] of Object.entries(files)) {
  if (!/^[0-9a-f]{64}$/.test(hash)) die(`inventory hash for '${relPath}' is not a sha256 hex digest`);
}

// Emit.
const out = [];
emitMeta(meta, out);
emitFiles(files, out);
emitStringList("notes", meta.notes, out);
emitStringList("gaps", meta.gaps, out);
fs.writeFileSync(args.out, out.join("\n") + "\n", "utf8");
console.log(`gen-lock: wrote ${args.out} (${Object.keys(files).length} files pinned)`);

// Round-trip self-check: the artifact we just wrote must load and validate.
try {
  const lock = await loadLock({ fs: fs.promises, yaml: { loadYamlFile } }, args.out, schemaPath);
  console.log(`gen-lock: round-trip OK — ${lock.target} ${lock.upstream.version} (${lock.status})`);
} catch (err) {
  die(`round-trip self-check failed — the generated lock does not validate: ${err.message}`);
}