# Pocket adapter (exact target: PocketRisu 1.10.0)

This directory is the integration kit for **one exact target**: the local
image `risuai:nodeonly-client-aux-handoff-20260829`
(`sha256:f41477424f0764179d3cd4b6d0761bea5f34f89dee69c76bd362bb9e4561282a`),
whose own `/app/package.json` reports `pocketrisu@1.10.0`. That satisfies the
AGENTS.md gate pinning the PocketRisu production target to v1.10.0 — nothing
here was written against any other version, and the obsolete 2026.6.215 tree
was never touched.

## Contents

| File | Role |
|---|---|
| `series.yaml` | Six fail-closed patch steps (below): stock-guard + full bridge v1 surface. |
| `adapter.ts` | `BackgroundAdapter` implementation with the capability matrix + `bridge` extension block verified against the locked source **as patched by this series**. |
| `Dockerfile` | Build context recipe; `scripts/build.mjs` cross-checks its `FROM`/`COPY` against the lock and series. |

The locked pristine source lives in `targets/cache/pocket-1.10.0-nodeonly-20260829/`
(51 files, sha256-pinned by `targets/pocket.lock.yaml`). Nothing patches the
cache in place; apply/build always write to a separate output directory.

## Series steps

1. **pocket-001** (`bg-worker.cjs`, replace) — truncated-stream guard: when the
   upstream SSE stream closes without a completion signal, fail the job
   instead of persisting a truncated body as a valid response. Byte-identical
   to the transformation already proven in
   `build/pocketrisu-1.10-hypav3-budget/patch-bg-worker.mjs`.
2. **pocket-002** (`server.cjs`, insert after the verified model-jobs wiring) —
   bridge v1 wiring: the single authenticated host principal
   (`pocket-host:<instanceId>`, the non-secret identity the target already
   persists and uses for update-check/compute-offload), the
   `registerBridgeRoutes` call under `checkProxyAuth`, and
   `GET /api/risu-bg-bridge/v1/capabilities` reporting **only** capabilities
   the series itself installs (including the `adapter` block the strict
   validator requires).
3. **pocket-101** (`model-jobs.cjs`, insert) — bridge schema: `request_fingerprint`
   + `principal_id` columns on `model_jobs` (same try/catch ALTER idiom as the
   target's own migrations, before every prepared statement), plus the
   `bg_delivery_leases`, `bg_aux_acks`, and `bg_finalize_proofs` tables.
   **Only the sha256 digest is persisted — never URL/headers/body**, so the
   target's memory-only-auth invariant is preserved.
4. **pocket-102** (`model-jobs.cjs`, insert) — bridge store + typed wrapper:
   canonical-request fingerprint, PUT idempotency with 409 fingerprint
   conflicts, typed journal events with server-side `afterSeq`, journal
   result hashes, durable aux discovery/consumer ACK, and delivery leases
   with monotonically increasing fencing tokens.
5. **pocket-103** (`model-jobs.cjs`, replace) — stamp the fingerprint +
   principal inside `createJob`'s synchronous insert section, so a crash can
   never leave a bridge row without its fingerprint; the stock POST path never
   forwards these fields, so stock rows stay NULL and stock behavior is
   unchanged.
6. **pocket-104** (`model-jobs.cjs`, replace) — export `registerBridgeRoutes`.

All anchors are exact-substring, expected count 1, and every ambiguity
(from gone + to gone, double occurrence, drifted insert point) aborts with a
rebase instruction — the tooling never guesses. Steps are idempotent: a
re-run against already-patched output reports `already-applied`.

## Bridge v1 surface (installed by the series)

```
PUT    /api/risu-bg-bridge/v1/jobs/:id              create-or-replay (fingerprint keyed)
GET    /api/risu-bg-bridge/v1/jobs/:id              typed snapshot (fingerprint/delivery/lease)
GET    /api/risu-bg-bridge/v1/jobs/:id/events       typed journal replay, server-side afterSeq
GET    /api/risu-bg-bridge/v1/jobs/:id/result       journal sha256 receipt (no body copy)
POST   /api/risu-bg-bridge/v1/jobs/:id/lease                 acquire (fencing token)
POST   /api/risu-bg-bridge/v1/jobs/:id/lease/:leaseId/renew  renew (current lease only)
POST   /api/risu-bg-bridge/v1/jobs/:id/finalize     proof seam (see below)
POST   /api/risu-bg-bridge/v1/jobs/:id/ack          durable per-consumer ACK (hash-verified)
GET    /api/risu-bg-bridge/v1/aux/pending?consumer=  durable aux discovery
```

Semantics:

- **PUT idempotency** — same clientJobId + same canonical fingerprint → the
  existing row is replayed without re-issuing the provider request
  (200, `isNew:false`); same id + different fingerprint → 409; a
  fingerprint-less row (stock POST) → 409 fail-closed; a row under another
  principal → 404 invisibility. The fingerprint is sha256 over sorted-key
  JSON of exactly the fields that define the upstream request, headers
  normalized with the recorder's own `normalizeUpstreamHeaders` — only the
  digest is stored.
- **Principal scoping** — 1.10.0 has no per-user subject (HS256 JWT payload is
  `{iat, exp}`, one instance password), so the honest scope is the
  authenticated instance itself. Every bridge row carries
  `principal_id = pocket-host:<instanceId>` and every query filters by it.
- **Typed events** — an honest wrapper over the journal bytes: 64KiB
  `provider_chunk` events whose `seq` is the end byte offset, `afterSeq`
  honored server-side, a byte budget with `truncated`, and exactly one typed
  terminal marker (`result_ready` with the journal hash, or `error`) on the
  final page. Historical state transitions are not reconstructed — the
  server never recorded them.
- **Lease/fencing** — acquire bumps a per-job monotonic token (expired or
  absent lease → previous + 1); renew extends only the current unexpired
  lease; finalize requires the current unexpired lease AND its exact token.
- **Finalization proof seam** — the server verifies what it can prove (the
  journal sha256 resultHash, the lease, the fencing) and durably records the
  client-asserted materialization fields (messageId, chatRevision,
  persistedAt, plus the row's generationId). Chat storage is unreachable
  from the job relay, so materialization stays client-side and
  `durableFinalization` stays **false**.

## Verified capability matrix (1.10.0 + this series)

```
tabCloseDurable       true   jobs/journals live server-side (model-jobs.cjs sqlite + journal files)
restartRecovery      false   boot keeps markRunningJobsFailed('server restart'); re-PUT replays the failed row
eventReplay           true   journals are raw byte streams; the bridge adds typed replay with server-side afterSeq
mainJobs              true   kind 'main', per-chat single-generation guard (409 on conflict)
auxJobs               true   kind 'aux' + bridge /aux/pending discovery and durable per-consumer ACK
toolWorkflows        false   no tool checkpoint/replay (the series adds none)
deliveryLease         true   bridge lease + renew with monotonic fencing tokens (patch-backed)
durableFinalization  false   finalize records a verified proof seam; materialization stays client-side
serverProviders      false   provider requests are relayed with client headers; auth material memory-only
browserProviderPersistence false
```

`adapter.ts` (matrix + `bridge` block) and the patched capabilities endpoint
serve the same facts; `tests/kit-pocket-adapter.test.ts` asserts they cannot
drift apart, and `tests/kit-pocket-bridge.test.ts` pins the installed schemas,
statements, and fail-closed invariants at the byte level.

## Known target gaps (documented honestly)

- **Restart recovery stays fail-closed** (`restartRecovery: false`):
  reconstructing an approved upstream request after a restart would require
  persisting the URL/headers/body, and the headers carry provider
  credentials this target deliberately keeps memory-only. The journal holds
  response bytes only, so no secret-free reconstruction exists. Boot keeps
  failing running jobs; a re-PUT of the same fingerprint replays the failed
  row instead of resuming.
- **durableFinalization stays false**: the finalize endpoint is a proof seam
  (hash-verified result + client-asserted materialization fields), not a
  server-side stage ledger; chat materialization remains client-side.
- **Single-principal scoping**: with no per-user identity in 1.10.0, bridge
  rows are attributable only to the instance, not to individual users.
- **The target itself still lacks native fingerprint idempotency** — the
  feature exists only on top of the pinned artifact via this series;
  `targets/pocket.lock.yaml` records the gap rather than papering over it.
- There is no tool-workflow transport; the adapter throws
  `PocketModelJobsUnsupportedError` instead of emulating one.
- Verification is textual: the patched files are proven by series application,
  `node --check`, and pinned-content tests. The patched server is not
  executed here (better-sqlite3/express are not kit dependencies), and no
  live DB is touched.

## Commands

```sh
node scripts/verify.mjs --target pocket          # lock vs snapshot, all gates
node scripts/apply.mjs --series adapters/pocket/series.yaml --out <dir> --check
node scripts/rebase-check.mjs --series adapters/pocket/series.yaml
node scripts/build.mjs --target pocket --out <ctx>   # verified docker context
```

`build.mjs` never runs docker; it prints the exact `docker build` command.
Image creation stays an explicit human/CI action — this kit does not deploy
or restart anything.