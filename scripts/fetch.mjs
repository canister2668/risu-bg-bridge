#!/usr/bin/env node
// fetch.mjs — snapshot a target's server source from a pinned local Docker
// image into targets/cache/, with the per-target version gate enforced.
//
// Method is deliberately the most conservative possible: `docker create` a
// throwaway container (never started), `docker cp` the source out, then
// `docker rm` it. No container execution, no service start, no live state
// touched. Every file is hashed and recorded in INVENTORY.json; the snapshot
// directory is only written after the full extraction and hash pass succeed.
//
// Usage:
//   node scripts/fetch.mjs --target pocket \
//     --image risuai:nodeonly-client-aux-handoff-20260829 \
//     --server-path /app/server/node --package-path /app/package.json \
//     --out targets/cache/pocket-1.10.0-nodeonly-20260829
//
// Fails closed on: docker unavailable, image missing, package identity not
// matching the AGENTS.md version gate for the target, extraction errors, or
// a non-empty output directory that would be silently overwritten.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TARGET_VERSION_GATES } from "./lib/lock.mjs";

function die(message) {
  console.error(`fetch: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") out.target = argv[++i];
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--server-path") out.serverPath = argv[++i];
    else if (a === "--package-path") out.packagePath = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else die(`unknown argument: ${a}`);
  }
  for (const key of ["target", "image", "serverPath", "packagePath", "out"]) {
    if (!out[key]) die(`missing required --${key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())}`);
  }
  return out;
}

function docker(args, { capture = true, allowFailure = false } = {}) {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowFailure) return null;
    die(`docker ${args.join(" ")} failed: ${err.stderr || err.message}`);
  }
}

function sha256File(file) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function hashTree(rootDir) {
  const files = {};
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath);
      else if (entry.isFile()) files[relPath] = sha256File(path.join(dir, entry.name));
    }
  };
  walk(rootDir, "");
  return files;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("see header comment of this file");
  process.exit(0);
}

// 1. Resolve and pin the image identity BEFORE any extraction.
let imageId;
try {
  imageId = docker(["inspect", args.image, "--format", "{{.Id}}"], { allowFailure: true });
} catch {
  imageId = null;
}
if (!imageId || !imageId.startsWith("sha256:")) {
  die(`cannot resolve image ID for '${args.image}' — is docker running and the image present?`);
}
imageId = imageId.trim();
console.log(`fetch: image ${args.image} -> ${imageId}`);

// 2. Output directory must not already contain a snapshot we'd clobber.
const outDir = path.resolve(args.out);
if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
  die(`output directory '${outDir}' is not empty — refusing to overwrite; remove it first`);
}
fs.mkdirSync(outDir, { recursive: true });

// 3. Throwaway container: create, cp, rm. Never started.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "risu-bg-fetch-"));
let containerId = null;
try {
  containerId = docker(["create", args.image]).trim();
  console.log(`fetch: created throwaway container ${containerId.slice(0, 12)} (not started)`);

  const serverTmp = path.join(tmp, "server-node");
  const packageTmp = path.join(tmp, "package.json");
  docker(["cp", `${containerId}:${args.serverPath}`, serverTmp]);
  docker(["cp", `${containerId}:${args.packagePath}`, packageTmp]);
  console.log(`fetch: copied ${args.serverPath} and ${args.packagePath} out of the image`);

  // 4. Package identity gate (AGENTS.md): refuse anything but the pinned
  //    production version for gated targets.
  const pkg = JSON.parse(fs.readFileSync(packageTmp, "utf8"));
  const gate = TARGET_VERSION_GATES[args.target];
  console.log(`fetch: image reports package ${pkg.name}@${pkg.version}`);
  if (gate) {
    if (pkg.version !== gate.exact) {
      die(
        `package identity ${pkg.name}@${pkg.version} does not satisfy the ${args.target} gate: ` +
          `${gate.reason} (required: ${gate.exact}). Refusing to snapshot this image.`
      );
    }
    console.log(`fetch: version gate satisfied (${gate.reason})`);
  }

  // 5. Hash everything, then materialize the snapshot.
  const files = hashTree(serverTmp);
  files["package.json"] = sha256File(packageTmp);
  const fileCount = Object.keys(files).length;
  if (fileCount === 0) die("extracted tree is empty — refusing to write an empty snapshot");

  for (const rel of Object.keys(files)) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(rel === "package.json" ? packageTmp : path.join(serverTmp, rel), dest);
  }

  const inventory = {
    target: args.target,
    source: {
      kind: "docker-image-extract",
      imageRef: args.image,
      imageId,
      serverPath: args.serverPath,
      packagePath: args.packagePath,
      method: "docker create + docker cp + docker rm (container never started)",
      extractedAt: new Date().toISOString().slice(0, 10),
    },
    files,
  };
  fs.writeFileSync(path.join(outDir, "INVENTORY.json"), JSON.stringify(inventory, null, 2) + "\n");

  console.log(`fetch: snapshot written to ${outDir}`);
  console.log(`fetch: ${fileCount} files hashed and recorded in INVENTORY.json`);
  console.log(`fetch: package identity ${pkg.name}@${pkg.version} (gate: ${gate ? gate.exact : "none"})`);
} finally {
  if (containerId) {
    docker(["rm", containerId]);
    console.log(`fetch: removed throwaway container`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}