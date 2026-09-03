import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadYamlFile } from "../scripts/lib/miniyaml.mjs";
import {
  loadLock,
  verifyLockAgainstCache,
  sha256Hex,
  TARGET_VERSION_GATES,
  LockSchemaError,
  LockVersionGateError,
  UnverifiableLockError,
  LockVerificationError
} from "../scripts/lib/lock.mjs";
import { targetsDir, findKitCache } from "./kit-cache-utils.js";

const deps = { fs, yaml: { loadYamlFile } };
const schemaPath = path.join(targetsDir, "lock-schema.json");
const pocketCache = findKitCache("pocket");

test("locks: TARGET_VERSION_GATES pins pocket to exactly 1.10.0 (AGENTS.md)", () => {
  assert.equal(TARGET_VERSION_GATES.pocket?.exact, "1.10.0");
});

test("locks: the shipped pocket lock loads, passes the schema, and holds the 1.10.0 gate", async () => {
  const lock = await loadLock(deps, path.join(targetsDir, "pocket.lock.yaml"), schemaPath);
  assert.equal(lock.target, "pocket");
  assert.equal(lock.upstream.version, "1.10.0");
  assert.equal(lock.package.name, "pocketrisu");
  assert.equal(lock.package.version, "1.10.0");
  assert.equal(lock.status, "verified-local");
  assert.ok(Object.keys(lock.files).length >= 50, `expected 51 pinned files, found ${Object.keys(lock.files).length}`);
  assert.ok("bg-worker.cjs" in lock.files, "the series patches bg-worker.cjs");
  assert.ok("server.cjs" in lock.files, "the series patches server.cjs");
  // A verified-local lock must still be honest about what is NOT verified.
  assert.ok(lock.gaps.length >= 1);
});

test("locks: a pocket lock at any other version is refused by the AGENTS.md gate", async () => {
  const real = await fs.readFile(path.join(targetsDir, "pocket.lock.yaml"), "utf8");
  const mutated = real.replaceAll('"1.10.0"', '"1.11.2"');
  assert.notEqual(mutated, real);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-lockgate-"));
  const lockPath = path.join(tmp, "pocket.lock.yaml");
  await fs.writeFile(lockPath, mutated, "utf8");
  await assert.rejects(
    () => loadLock(deps, lockPath, schemaPath),
    (err: unknown) => err instanceof LockVersionGateError && /1\.10\.0/.test(err.message)
  );
});

test("locks: unknown lock keys and empty gaps fail schema validation", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-lockschema-"));
  const lockPath = path.join(tmp, "vanilla.lock.yaml");
  const base = [
    'target: "vanilla"',
    "lockFormat: 1",
    'status: "declared-only"',
    "upstream:",
    '  "product": "RisuAI"',
    '  "version": "0.0.0-test"',
    "  commit: null",
    "  tag: null",
    "source:",
    '  "kind": "unverified"',
    "  imageRef: null",
    "package:",
    '  "name": "risuai"',
    '  "version": "0.0.0-test"',
    "files:",
    `  "a.cjs": ${"f".repeat(64)}`,
    "notes:",
    '  - "synthetic lock"',
    "gaps:"
  ].join("\n");

  // `gaps:` with no items parses as null in this YAML subset — an empty gaps
  // list cannot even be expressed, so it fails as a type violation.
  await fs.writeFile(lockPath, base, "utf8");
  await assert.rejects(() => loadLock(deps, lockPath, schemaPath), LockSchemaError);

  // Same for an unknown top-level key: the schema is strict.
  await fs.writeFile(lockPath, base + '\nbogusKey: "nope"\n', "utf8");
  await assert.rejects(() => loadLock(deps, lockPath, schemaPath), LockSchemaError);
});

/** Minimal schema-shaped lock object for direct verifyLockAgainstCache calls. */
function syntheticLock(files: Record<string, string>, status = "verified-local") {
  return {
    target: "pocket",
    lockFormat: 1,
    status,
    upstream: { product: "PocketRisu", version: "1.10.0", commit: null, tag: null },
    source: { kind: "docker-image-extract", imageRef: "risuai:synthetic", imageId: null, repoDigest: null, labelVersion: null, note: null },
    package: { name: "pocketrisu", version: "1.10.0" },
    files,
    notes: ["synthetic"],
    gaps: ["synthetic fixture lock"]
  } as any;
}

async function writeSyntheticCache(
  dir: string,
  opts: { content?: string; inventoryFiles?: Record<string, string>; omitInventory?: boolean; packageJson?: string } = {}
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), opts.packageJson ?? JSON.stringify({ name: "pocketrisu", version: "1.10.0" }));
  const content = opts.content ?? "const a = 1;\n";
  await fs.writeFile(path.join(dir, "a.cjs"), content);
  if (!opts.omitInventory) {
    await fs.writeFile(
      path.join(dir, "INVENTORY.json"),
      JSON.stringify({
        target: "pocket",
        source: { kind: "docker-image-extract", imageRef: "risuai:synthetic" },
        files: opts.inventoryFiles ?? { "a.cjs": sha256Hex(content) }
      })
    );
  }
}

test("locks: verifyLockAgainstCache passes a consistent synthetic snapshot", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cachegood-"));
  const content = "const a = 1;\n";
  await writeSyntheticCache(tmp);
  const report = await verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": sha256Hex(content) }), tmp);
  assert.ok(report.some((line) => line.includes("hash-verified")));
  assert.ok(report.some((line) => line.includes("pocketrisu@1.10.0")));
});

test("locks: drifted, missing, and cross-record-mismatched snapshots all fail", async () => {
  const content = "const a = 1;\n";
  const goodHash = sha256Hex(content);
  const failureMentioning = (needle: string) => (err: unknown) =>
    err instanceof LockVerificationError && err.failures.some((f: string) => f.includes(needle));

  // drifted file content
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cachedrift-"));
    await writeSyntheticCache(tmp, { content: "const a = 2;\n", inventoryFiles: { "a.cjs": goodHash } });
    await assert.rejects(() => verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": goodHash }), tmp), failureMentioning("hash mismatch for a.cjs"));
  }

  // missing pinned file
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cachemiss-"));
    await writeSyntheticCache(tmp);
    await fs.rm(path.join(tmp, "a.cjs"));
    await assert.rejects(() => verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": goodHash }), tmp), failureMentioning("locked file missing from snapshot"));
  }

  // package identity mismatch
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cachepkg-"));
    await writeSyntheticCache(tmp, { packageJson: JSON.stringify({ name: "pocketrisu", version: "9.9.9" }) });
    await assert.rejects(() => verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": goodHash }), tmp), failureMentioning("9.9.9"));
  }

  // missing INVENTORY.json
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cacheinv-"));
    await writeSyntheticCache(tmp, { omitInventory: true });
    await assert.rejects(() => verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": goodHash }), tmp), failureMentioning("INVENTORY.json"));
  }

  // INVENTORY/lock hash disagreement and key-set disagreement
  {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cachexcheck-"));
    await writeSyntheticCache(tmp, {
      inventoryFiles: { "a.cjs": sha256Hex("different bytes\n"), "b.cjs": sha256Hex("x") }
    });
    await assert.rejects(() => verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": goodHash }), tmp), failureMentioning("hash disagreement"));
    await assert.rejects(() => verifyLockAgainstCache(fs, syntheticLock({ "a.cjs": goodHash }), tmp), failureMentioning("list different files"));
  }
});

test("locks: a lock that is not verified-local refuses verification outright", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "risu-bg-cachedecl-"));
  await writeSyntheticCache(tmp);
  const lock = syntheticLock({ "a.cjs": sha256Hex("const a = 1;\n") }, "declared-only");
  await assert.rejects(
    () => verifyLockAgainstCache(fs, lock, tmp),
    (err: unknown) =>
      err instanceof UnverifiableLockError &&
      err.message.includes("declared-only") &&
      err.gaps.length === 1
  );
});

test(
  "locks: the real pocket snapshot verifies against the shipped lock and still reports exactly 1.10.0",
  { skip: !pocketCache ? "no local pocket cache snapshot (targets/cache)" : false },
  async () => {
    assert.ok(pocketCache);
    const lock = await loadLock(deps, path.join(targetsDir, "pocket.lock.yaml"), schemaPath);
    const report = await verifyLockAgainstCache(fs, lock, pocketCache);
    assert.ok(report.some((line: string) => line.includes(`${Object.keys(lock.files).length} source files hash-verified`)));
    assert.ok(report.some((line: string) => line.includes("PocketRisu 1.10.0")));

    // Independent identity check straight from the snapshot's own package.json
    // — AGENTS.md requires the Pocket target to be exactly v1.10.0.
    const pkg = JSON.parse(await fs.readFile(path.join(pocketCache, "package.json"), "utf8"));
    assert.equal(pkg.name, "pocketrisu");
    assert.equal(pkg.version, "1.10.0");
  }
);