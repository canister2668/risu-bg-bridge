/**
 * Client-side job ledger (design §7 + §13).
 *
 * The server side owns PUT idempotency (IdempotentJobRegistry), but the
 * client needs its own durable half: when a PUT response is lost, a retry
 * must reuse the SAME clientJobId for the same request fingerprint instead
 * of minting a new one. This ledger maps fingerprint → clientJobId and
 * records the request's progress through the small client-side stage
 * vocabulary, so a retry (or a reopened tab) can pick the id back up.
 *
 * Storage is injectable: a localStorage-like object in the plugin host, or
 * null for memory-only operation (tests / hosts without storage).
 */

export type LedgerStage =
  | "reserved" // fingerprint mapped to a clientJobId, nothing submitted yet
  | "submitted" // server accepted the job (bridge path)
  | "foreground-completed" // stock fallback produced a result
  | "foreground-failed" // stock fallback errored
  | "cancelled"; // user or client cancelled before completion

export interface LedgerEntry {
  fingerprint: string;
  clientJobId: string;
  stage: LedgerStage;
  createdAt: string;
  updatedAt: string;
  /** Server-reported state, if a snapshot was ever observed. */
  serverState?: string;
  error?: string;
}

export interface LedgerStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const STORAGE_PREFIX = "risu-bg-ledger:";
const MAX_ENTRIES = 500;

export class ClientJobLedger {
  private memory = new Map<string, LedgerEntry>();

  constructor(private storage: LedgerStorage | null) {}

  private load(key: string): LedgerEntry | undefined {
    if (this.storage) {
      const raw = this.storage.get(STORAGE_PREFIX + key);
      if (raw === null) return undefined;
      try {
        const parsed = JSON.parse(raw) as LedgerEntry;
        if (parsed && typeof parsed.clientJobId === "string" && typeof parsed.fingerprint === "string") {
          return parsed;
        }
      } catch {
        // Corrupted rows are dropped — the ledger degrades to "not found",
        // which is safe: the worst case is a fresh clientJobId for a retry.
      }
    }
    return this.memory.get(key) ?? undefined;
  }

  private save(key: string, entry: LedgerEntry): void {
    const json = JSON.stringify(entry);
    this.memory.set(key, entry);
    if (this.storage) {
      this.storage.set(STORAGE_PREFIX + key, json);
      this.prune();
    }
  }

  /**
   * Drops the oldest third when the ledger grows past MAX_ENTRIES. Only the
   * in-storage copy is pruned here; memory entries live with the page.
   */
  private prune(): void {
    if (!this.storage || typeof (this.storage as unknown as Record<string, unknown>).keys !== "function") {
      // Storage backends without enumeration (localStorage-shaped mocks in
      // tests) are skipped; pruning is an optimization, not a guarantee.
      return;
    }
    const keys = (this.storage as unknown as { keys(): string[] }).keys().filter((k) =>
      k.startsWith(STORAGE_PREFIX)
    );
    if (keys.length <= MAX_ENTRIES) return;
    // Entries are keyed by fingerprint; prune by updatedAt ascending.
    const entries: Array<[string, LedgerEntry]> = [];
    for (const key of keys) {
      const entry = this.load(key.slice(STORAGE_PREFIX.length));
      if (entry) entries.push([key, entry]);
    }
    entries.sort((a, b) => (a[1].updatedAt < b[1].updatedAt ? -1 : 1));
    for (const [key] of entries.slice(0, entries.length - MAX_ENTRIES)) {
      this.memory.delete(key.slice(STORAGE_PREFIX.length));
    }
  }

  /** Looks up a reservation by request fingerprint. */
  findByFingerprint(fingerprint: string): LedgerEntry | undefined {
    return this.load(fingerprint);
  }

  /**
   * Reserves a fingerprint → clientJobId mapping. Fail-closed: a fingerprint
   * may never silently switch ids — that would break the server's PUT
   * idempotency contract. Returns the existing reservation when present.
   */
  reserve(fingerprint: string, clientJobId: string, now: () => Date = () => new Date()): LedgerEntry {
    const existing = this.load(fingerprint);
    if (existing) {
      if (existing.clientJobId !== clientJobId) {
        throw new Error(
          `LedgerConflict: fingerprint ${fingerprint} is already reserved to ` +
            `${existing.clientJobId}; refusing to remap it to ${clientJobId}`
        );
      }
      return existing;
    }
    const iso = now().toISOString();
    const entry: LedgerEntry = {
      fingerprint,
      clientJobId,
      stage: "reserved",
      createdAt: iso,
      updatedAt: iso
    };
    this.save(fingerprint, entry);
    return entry;
  }

  /** Advances the stage of an existing reservation. Fails on unknown ids. */
  record(
    fingerprint: string,
    update: Partial<Pick<LedgerEntry, "stage" | "serverState" | "error">>,
    now: () => Date = () => new Date()
  ): LedgerEntry {
    const existing = this.load(fingerprint);
    if (!existing) {
      throw new Error(`LedgerNotFound: no reservation for fingerprint ${fingerprint}`);
    }
    const next: LedgerEntry = {
      ...existing,
      ...update,
      fingerprint: existing.fingerprint,
      clientJobId: existing.clientJobId,
      createdAt: existing.createdAt,
      updatedAt: now().toISOString()
    };
    this.save(fingerprint, next);
    return next;
  }
}