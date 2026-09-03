// Shared helpers for the kit test files. NOT a test itself (no .test.ts
// suffix) -- node --test only picks up tests/**/*.test.ts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of build/risu-bg-extension (the kit this test tree lives in). */
export const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const targetsDir = path.join(kitRoot, "targets");

/**
 * Locates the unique local cache snapshot for a target by scanning each
 * targets/cache subdirectory's INVENTORY.json -- the same discovery rule
 * scripts/*.mjs use. Returns null when no snapshot (or an ambiguous set)
 * exists, so cache-backed tests can skip rather than fail on machines
 * without the extraction.
 */
export function findKitCache(target: string): string | null {
  const cacheRoot = path.join(targetsDir, "cache");
  if (!fs.existsSync(cacheRoot)) return null;
  let found: string | null = null;
  for (const entry of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inv = path.join(cacheRoot, entry.name, "INVENTORY.json");
    if (!fs.existsSync(inv)) continue;
    try {
      if (JSON.parse(fs.readFileSync(inv, "utf8")).target === target) {
        if (found !== null) return null; // ambiguous -- more than one snapshot
        found = path.join(cacheRoot, entry.name);
      }
    } catch {
      /* unreadable inventory -- not a candidate */
    }
  }
  return found;
}