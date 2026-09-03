import test from "node:test";
import assert from "node:assert/strict";

import { uuidv7, isAcceptableClientJobId, UUID_V7_REGEX, RandomSource } from "../plugin/src/uuidv7.js";
import { ClientJobLedger, LedgerStorage } from "../plugin/src/ledger.js";

/** Deterministic randomness: every byte 0x42 (except version/variant bits). */
const fixedRandom: RandomSource = {
  getRandomValues<T extends Uint8Array>(array: T): T {
    array.fill(0x42);
    return array;
  }
};

test("uuidv7: deterministic layout with version 7 and RFC variant", () => {
  const id = uuidv7(0, fixedRandom);
  // bytes 0..5 are the 48-bit ms prefix (zero here); byte 6 high nibble is
  // the version (7); byte 8 high bits are the variant (10); every other
  // byte is 0x42 from the injected source.
  assert.equal(id, "00000000-0000-7242-8242-424242424242");
  assert.ok(UUID_V7_REGEX.test(id));
  assert.ok(isAcceptableClientJobId(id));
});

test("uuidv7: the timestamp is the big-endian 48-bit unix-ms prefix", () => {
  const id = uuidv7(2 ** 48 - 1, fixedRandom);
  assert.ok(id.startsWith("ffffffff-ffff-"));
  const mid = uuidv7(0x010203040506, fixedRandom);
  assert.ok(mid.startsWith("01020304-0506-"));

  // Time-ordering: same random source, later timestamp sorts later.
  const early = uuidv7(1000, fixedRandom);
  const late = uuidv7(2000, fixedRandom);
  assert.ok(early < late);
});

test("uuidv7: rejects non-integer or negative timestamps", () => {
  assert.throws(() => uuidv7(1.5, fixedRandom), RangeError);
  assert.throws(() => uuidv7(-1, fixedRandom), RangeError);
});

test("uuidv7: isAcceptableClientJobId encodes the transports' acceptance shape", () => {
  // Garbage never passes.
  assert.ok(!isAcceptableClientJobId(""));
  assert.ok(!isAcceptableClientJobId("not-a-uuid"));
  assert.ok(!isAcceptableClientJobId(1234 as any));
  // Version nibble must be 1..8 (the Pocket 1.10.0 server's regex), so a
  // version-0 style id is rejected...
  assert.ok(!isAcceptableClientJobId("00000000-0000-0742-8242-424242424242"));
  // ...and a variant outside 8/9/a/b is rejected too.
  assert.ok(!isAcceptableClientJobId("00000000-0000-7742-c242-424242424242"));
  assert.ok(!isAcceptableClientJobId("00000000-0000-7742-0424-242424242424"));
  // The regex is case-insensitive like the server's.
  assert.ok(isAcceptableClientJobId("00000000-0000-7242-8242-424242424242".toUpperCase()));
});

/** localStorage-shaped in-memory storage for ledger tests. */
class MapStorage implements LedgerStorage {
  map = new Map<string, string>();
  get(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test("ledger: reserve maps a fingerprint to an id and refuses remapping", () => {
  const ledger = new ClientJobLedger(null);
  const entry = ledger.reserve("fp-1", "id-1");
  assert.equal(entry.stage, "reserved");
  assert.equal(ledger.findByFingerprint("fp-1")?.clientJobId, "id-1");

  // Same id again: idempotent, returns the reservation.
  assert.equal(ledger.reserve("fp-1", "id-1").clientJobId, "id-1");

  // A different id for the same fingerprint breaks PUT idempotency — hard no.
  assert.throws(
    () => ledger.reserve("fp-1", "id-2"),
    (err: unknown) => err instanceof Error && err.message.includes("LedgerConflict")
  );
});

test("ledger: record advances stages on existing reservations only", () => {
  const ledger = new ClientJobLedger(null);
  ledger.reserve("fp-2", "id-2");
  const submitted = ledger.record("fp-2", { stage: "submitted", serverState: "running" });
  assert.equal(submitted.stage, "submitted");
  assert.equal(submitted.serverState, "running");
  const done = ledger.record("fp-2", { stage: "foreground-completed" });
  assert.equal(done.stage, "foreground-completed");
  assert.equal(done.clientJobId, "id-2");

  // Unknown fingerprint: refuse rather than inventing a row.
  assert.throws(
    () => ledger.record("fp-unknown", { stage: "submitted" }),
    (err: unknown) => err instanceof Error && err.message.includes("LedgerNotFound")
  );
});

test("ledger: entries persist through storage and survive a new ledger instance", () => {
  const storage = new MapStorage();
  const first = new ClientJobLedger(storage);
  first.reserve("fp-3", "id-3");
  first.record("fp-3", { stage: "foreground-failed", error: "boom" });

  const second = new ClientJobLedger(storage);
  const entry = second.findByFingerprint("fp-3");
  assert.equal(entry?.clientJobId, "id-3");
  assert.equal(entry?.stage, "foreground-failed");
  assert.equal(entry?.error, "boom");
  // The stored key is namespaced.
  assert.ok([...storage.map.keys()].every((k) => k.startsWith("risu-bg-ledger:")));
});

test("ledger: corrupted storage rows degrade to not-found, never to a crash", () => {
  const storage = new MapStorage();
  storage.set("risu-bg-ledger:fp-4", "{not json");
  const ledger = new ClientJobLedger(storage);
  assert.equal(ledger.findByFingerprint("fp-4"), undefined);
  // Re-reserving on a corrupted row must still work (fresh mapping).
  const entry = ledger.reserve("fp-4", "id-4");
  assert.equal(entry.clientJobId, "id-4");
});

test("ledger: corrupted-but-typed storage rows with missing ids are ignored", () => {
  const storage = new MapStorage();
  storage.set("risu-bg-ledger:fp-5", JSON.stringify({ fingerprint: "fp-5" })); // no clientJobId
  const ledger = new ClientJobLedger(storage);
  assert.equal(ledger.findByFingerprint("fp-5"), undefined);
});