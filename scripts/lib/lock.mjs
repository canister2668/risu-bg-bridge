// Target lock loading and fail-closed verification.
//
// A lock file (targets/*.lock.yaml) pins the exact upstream material a patch
// series may be applied to: product version, source identity, package identity
// (from the target's own package.json), and the sha256 of every extracted
// source file. Verification re-computes hashes from the local cache snapshot
// and cross-checks them against the extraction inventory. Anything that cannot
// be proven — wrong version, missing file, hash drift, a lock that is only
// declared rather than verified — is a hard error.

import { createHash } from "node:crypto";

export const TARGET_VERSION_GATES = {
  // AGENTS.md: "the current PocketRisu production target is v1.10.0; never
  // use the obsolete 2026.6.215 tree." Enforced exactly: any other Pocket
  // version fails the gate no matter how plausible it looks.
  pocket: {
    exact: "1.10.0",
    reason: "AGENTS.md pins PocketRisu production target to v1.10.0",
  },
  vanilla: null,
  haejeok: null,
};

export class LockSchemaError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = "LockSchemaError";
  }
}

export class LockVersionGateError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockVersionGateError";
  }
}

export class UnverifiableLockError extends Error {
  constructor(message, gaps = []) {
    super(message);
    this.name = "UnverifiableLockError";
    this.gaps = gaps;
  }
}

export class LockVerificationError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "LockVerificationError";
    this.failures = failures;
  }
}

// ---------------------------------------------------------------------------
// Mini-schema validator. Supports exactly the constructs declared in
// targets/lock-schema.json; an unknown schema construct is an error so the
// schema document and validator can never silently drift apart.
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "map";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number" && Number.isInteger(value)) return "int";
  return "float";
}

function matchesType(value, want) {
  const actual = typeOf(value);
  const parts = want.split("|");
  return parts.includes(actual);
}

/**
 * Validates `value` against a mini-schema node. Node types: "map", "list",
 * "string", "int", "float", "bool", "null", unions with "|" (e.g.
 * "string|null"), "enum" ({values: [...]}) and "const" ({value: ...}).
 * Collects every violation into `failures`; throws only on a malformed
 * schema document itself.
 */
export function validateNode(value, schema, path, failures) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new LockSchemaError(`invalid schema node at ${path}: expected an object`);
  }
  const kind = schema.type;
  if (kind === undefined) {
    throw new LockSchemaError(`schema node at ${path} has no 'type'`);
  }
  if (kind === "const") {
    if (!("value" in schema)) throw new LockSchemaError(`const node at ${path} has no 'value'`);
    if (value !== schema.value) {
      failures.push(`${path}: expected const ${JSON.stringify(schema.value)}, found ${JSON.stringify(value)}`);
    }
    return;
  }
  if (kind === "enum") {
    if (!Array.isArray(schema.values) || schema.values.length === 0) {
      throw new LockSchemaError(`enum node at ${path} has no 'values'`);
    }
    if (!schema.values.includes(value)) {
      failures.push(`${path}: value ${JSON.stringify(value)} not in allowed enum [${schema.values.map((v) => JSON.stringify(v)).join(", ")}]`);
    }
    return;
  }
  if (!matchesType(value, kind)) {
    failures.push(`${path}: expected type ${kind}, found ${typeOf(value)}`);
    return;
  }
  if (typeOf(value) === "null") return;
  if (schema.pattern !== undefined && typeOf(value) === "string") {
    if (!new RegExp(schema.pattern).test(value)) {
      failures.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }
  if (schema.minLength !== undefined && typeOf(value) === "string") {
    if (value.length < schema.minLength) {
      failures.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }

  const actual = typeOf(value);
  if (actual === "map") {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        failures.push(`${path}: missing required key '${key}'`);
      }
    }
    if (schema.allowUnknown === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key)) {
          failures.push(`${path}: unknown key '${key}' (schema is strict)`);
        }
      }
    }
    if (schema.requiredKeysNonEmpty === true && Object.keys(value).length === 0) {
      failures.push(`${path}: must not be empty`);
    }
    if (schema.keyPattern !== undefined) {
      for (const key of Object.keys(value)) {
        if (!new RegExp(schema.keyPattern).test(key)) {
          failures.push(`${path}: key '${key}' does not match pattern ${schema.keyPattern}`);
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key] ?? schema.valueSchema;
      if (childSchema) {
        validateNode(child, childSchema, `${path}.${key}`, failures);
      }
    }
  } else if (actual === "list") {
    const itemSchema = schema.itemSchema;
    if (!itemSchema) {
      throw new LockSchemaError(`invalid schema node at ${path}: list without itemSchema`);
    }
    value.forEach((item, i) => validateNode(item, itemSchema, `${path}[${i}]`, failures));
  }
}

export function validateSchemaDocument(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new LockSchemaError("schema document must be a JSON object");
  }
  if (doc.schemaFormat !== "risu-bg-lock/1") {
    throw new LockSchemaError(`unsupported schemaFormat: ${JSON.stringify(doc.schemaFormat)}`);
  }
  if (!doc.root) throw new LockSchemaError("schema document missing 'root'");
  return doc.root;
}

// ---------------------------------------------------------------------------
// Lock loading
// ---------------------------------------------------------------------------

/**
 * Loads and validates a lock file against the schema, then applies the
 * per-target version gate. Throws on any problem; never returns a
 * partially-validated lock.
 *
 * deps: { fs (node:fs/promises compatible), yaml (module with loadYamlFile) }
 */
export async function loadLock(deps, lockPath, schemaPath) {
  const schemaDoc = JSON.parse(await deps.fs.readFile(schemaPath, "utf8"));
  const rootSchema = validateSchemaDocument(schemaDoc);

  const lock = await deps.yaml.loadYamlFile(deps.fs, lockPath);

  const failures = [];
  validateNode(lock, rootSchema, "lock", failures);
  if (failures.length > 0) {
    throw new LockSchemaError(
      `${failures.length} lock schema violation(s):\n` + failures.map((f) => `  - ${f}`).join("\n"),
      lockPath
    );
  }

  const gate = TARGET_VERSION_GATES[lock.target];
  if (gate && lock.upstream.version !== gate.exact) {
    throw new LockVersionGateError(
      `${lockPath}: target '${lock.target}' is locked to version '${lock.upstream.version}', ` +
        `but ${gate.reason} — only '${gate.exact}' is accepted. Refusing to guess at a different version.`
    );
  }

  // A lock that is not fully verified must carry at least one honest gap.
  if (lock.status !== "verified-local" && lock.gaps.length === 0) {
    throw new LockSchemaError(
      `status '${lock.status}' requires at least one entry in gaps explaining what remains unverified`,
      lockPath
    );
  }

  return lock;
}

// ---------------------------------------------------------------------------
// Cache snapshot verification
// ---------------------------------------------------------------------------

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Verifies a verified-local lock against the cache snapshot directory:
 *
 *   1. status must be 'verified-local' — anything else refuses (fail closed).
 *   2. The snapshot's package.json identity must match the lock's package.
 *   3. Every lock.files entry must exist in the snapshot with an exact hash.
 *   4. The snapshot INVENTORY.json must list exactly the same files with the
 *      same hashes — two independent records must agree.
 *
 * Returns a report (array of human-readable verified facts). Throws
 * UnverifiableLockError or LockVerificationError on any mismatch.
 */
export async function verifyLockAgainstCache(fs, lock, cacheDir) {
  if (lock.status !== "verified-local") {
    throw new UnverifiableLockError(
      `Lock for '${lock.target}' has status '${lock.status}' — refusing to verify or apply against it.\n` +
        `Declared gaps:\n` +
        lock.gaps.map((g) => `  - ${g}`).join("\n"),
      lock.gaps
    );
  }

  const failures = [];

  // 2. Package identity from the snapshot's own package.json.
  let pkg = null;
  try {
    pkg = JSON.parse(await fs.readFile(`${cacheDir}/package.json`, "utf8"));
  } catch {
    failures.push(`missing or unreadable ${cacheDir}/package.json — cannot confirm target identity`);
  }
  if (pkg) {
    if (pkg.name !== lock.package.name || pkg.version !== lock.package.version) {
      failures.push(
        `package identity mismatch: snapshot reports ${pkg.name}@${pkg.version}, ` +
          `lock requires ${lock.package.name}@${lock.package.version}`
      );
    }
  }

  // 3. Every locked file hash re-computed from the snapshot.
  const snapshotHashes = {};
  for (const relPath of Object.keys(lock.files)) {
    if (relPath.includes("..") || relPath.startsWith("/")) {
      failures.push(`lock.files key is not a safe relative path: ${relPath}`);
      continue;
    }
    let text;
    try {
      text = await fs.readFile(`${cacheDir}/${relPath}`, "utf8");
    } catch {
      failures.push(`locked file missing from snapshot: ${relPath}`);
      continue;
    }
    const hash = sha256Hex(text);
    snapshotHashes[relPath] = hash;
    if (hash !== lock.files[relPath]) {
      failures.push(
        `hash mismatch for ${relPath}: lock says ${lock.files[relPath]}, snapshot has ${hash}`
      );
    }
  }

  // 4. Cross-check against the extraction inventory.
  let inventory = null;
  try {
    inventory = JSON.parse(await fs.readFile(`${cacheDir}/INVENTORY.json`, "utf8"));
  } catch {
    failures.push(`missing or unreadable ${cacheDir}/INVENTORY.json — cannot cross-check extraction record`);
  }
  if (inventory) {
    if (inventory.target !== lock.target) {
      failures.push(`INVENTORY target '${inventory.target}' != lock target '${lock.target}'`);
    }
    const invFiles = inventory.files ?? {};
    const lockKeys = Object.keys(lock.files).sort().join(",");
    const invKeys = Object.keys(invFiles).sort().join(",");
    if (lockKeys !== invKeys) {
      failures.push(
        `INVENTORY and lock list different files.\n  inventory: ${invKeys}\n  lock:      ${lockKeys}`
      );
    }
    for (const [relPath, invHash] of Object.entries(invFiles)) {
      if (invHash !== lock.files[relPath]) {
        failures.push(
          `INVENTORY/lock hash disagreement for ${relPath}: inventory ${invHash}, lock ${lock.files[relPath]}`
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new LockVerificationError(
      `lock verification against '${cacheDir}' failed with ${failures.length} problem(s):\n` +
        failures.map((f) => `  - ${f}`).join("\n"),
      failures
    );
  }

  const report = [
    `target ${lock.target}: ${lock.upstream.product} ${lock.upstream.version} (${lock.status})`,
    `package identity verified from snapshot: ${lock.package.name}@${lock.package.version}`,
    `${Object.keys(lock.files).length} source files hash-verified against ${cacheDir}`,
    `INVENTORY.json cross-check passed`,
  ];
  if (lock.source.imageId) report.push(`pinned image (local config digest): ${lock.source.imageId}`);
  return report;
}