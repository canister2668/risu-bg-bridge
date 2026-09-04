# Risu BG Bridge

> **v0.9.0-beta.2** — public beta. Back up your database and server
> configuration before applying a host adapter. End-to-end testing with real
> provider accounts remains the operator's responsibility.

Reference contract and durable background execution engine that separates LLM request execution and chat materialization from the browser tab lifecycle.

This package implements:
1. **Production-grade Common Core Engine**: Persistent SQLite storage engine (`node:sqlite` DatabaseSync), crash/restart recovery worker with ambiguous semantics, credential reference resolution without plaintext secrets, resumable finalization pipeline with persistent stage ledger, tool workflow checkpointing with four replay policies, and multi-device lease fencing.
2. **Host Bridge & Portability Kits**: A directly importable API v3 plugin,
   a reproducible PocketRisu 1.10.0 patch kit, and a scoped Haejeok b6704
   patch. Stock RisuAI remains an explicit foreground-only fallback.

## Related projects

- [RisuAI](https://github.com/kwaroran/Risuai) — upstream project
- [HaejeokRisuAI](https://github.com/nevaeh5379/HaejeokRisuai) — tested host patch baseline
- [PocketRisu](https://github.com/PocketRisu/PocketRisu) — locked adapter target

---

## 1. Architectural Strategy (Plan B)

```text
API v3 Plugin
  ├─ Stock RisuAI: runLLMModel foreground fallback
  └─ Host backgroundModels bridge
        │  (plugin never sees risu-auth / provider secrets)
        ▼
   Durable Storage & Execution Engine (node:sqlite WAL + Worker + Lease Fencing)
```

* **Client-Decoupled Execution**: The browser is a submitter, observer, and result consumer. Jobs continue to run if tabs close or client reboots.
* **Security boundary**: Secrets are referenced by `credentialRef` / `credentialEpoch`, resolved on-demand by `CredentialResolver`, and never stored as plaintext in job metadata or event journals.
* **Uncertainty & Idempotency**: External LLM calls are not exactly-once. Non-idempotent send-uncertain failures during crashes become `ambiguous` rather than silent retries. Idempotent providers safely re-queue with execution epoch increments.
* **Resumable Finalization**: Post-generation stages (markdown normalization, emotion tagging, triggers) are tracked in a persistent stage ledger. In crash recovery, pure idempotent stages are safely resumed and previously completed stages are never duplicated.

---

## 2. Capabilities Matrix

`getCapabilities()` reports **what the specific runtime adapter actually implements**. Legacy targets report their verified reality, while `DurableEngineAdapter` reports the implemented common-core features.

| Feature | Vanilla stock | Haejeok b6704 + patch | Pocket 1.10.0 + patch | Durable Common Engine |
|---|---|---|---|---|
| tabCloseDurable | false | true (model-jobs PUT) | true | true |
| mainJobs | false | true | true | true |
| auxJobs | false | true | true | true |
| eventReplay | false | true | true (SSE/events) | true (monotonic typed journal) |
| restartRecovery | false | true | fail-closed without persisted server credentials | true (active job discovery + ambiguous) |
| toolWorkflows | false | false | false | true (safe / idempotent / confirm / never) |
| deliveryLease | false | true | true | true (fencing token + CAS) |
| durableFinalization | false | true | true | true (stage ledger + materialization proof) |
| serverProviders | false | opt-in registry | false | true (credentialRef resolution) |

---

## 3. Core Components

### 3.1 Contracts (`src/contract/`)
Versioned job metadata, capabilities, request/result types, tool workflow checkpoints, and stage ledger entries. Jobs carry a monotonic `recordVersion` for compare-and-set updates.

### 3.2 Persistent Storage (`src/storage/`)
`SqliteBgStorageEngine` provides ACID persistence over `node:sqlite` with WAL journal mode, busy timeout, and foreign key enforcement:
* `bg_jobs`: client-idempotent job metadata with CAS updates.
* `bg_request_envelopes`: request payloads isolated from secrets.
* `bg_event_journal`: monotonic append-only typed events (`seq`, `type`, `payload`).
* `bg_results`: persistent result blobs and token usage.
* `bg_tool_checkpoints`: tool call checkpoints with execution state and args hash.
* `bg_stage_ledger`: resumable finalization stage execution ledger.
* `bg_aux_acks`: consumer group ACKs for aux jobs.

### 3.3 State Machine (`src/engine/stateMachine.ts`)
`reserved → queued → running → succeeded → finalizing → completed`, plus `awaiting_tool` and `ambiguous`.
`ambiguous → queued` is rejected fail-closed to protect against duplicate un-idempotent provider execution.

### 3.4 Worker & Restart Recovery (`src/engine/worker.ts`)
* Resolves `credentialRef` via `CredentialResolver`. Revoked or mismatched epochs immediately halt execution.
* Evaluates crash recovery: uncertain non-idempotent jobs transition to `ambiguous`; idempotent jobs safely re-queue; stale finalizing leases are reverted to `succeeded` for re-claim.

### 3.5 Tool Execution Engine (`src/engine/tools.ts`)
Tracks tool execution with checkpointing and enforces 4 replay policies:
* `safe`: auto-reexecution on crash.
* `idempotent`: re-execution only if an `idempotencyKey` is present; blocked otherwise.
* `confirm`: blocked until explicit operator approval is recorded.
* `never`: strictly forbidden from re-execution.

### 3.6 Resumable Finalizer (`src/engine/finalization.ts`)
Coordinates multi-stage post-processing with persistent ledger entries. Checks `MaterializationProof` (message ID, result hash, chat revision) before allowing transition to `completed`.

### 3.7 Delivery Lease & Fencing (`src/engine/lease.ts`)
Multi-device lease fencing: lease acquisition increments fencing tokens. Finalization requires matching `leaseId`, current fencing token, unexpired lease, and `finalizing` state. Stale tokens are rejected.

### 3.8 Host Bridges (`src/client/hostBridge.ts`)
* `HostBackgroundModelsBridge`: In-memory reference contract bridge.
* `PersistentHostBackgroundModelsBridge`: Durable SQLite-backed bridge implementing full lifecycle (create, get, list, streamEvents, readResult, cancel, lease acquire/renew, finalize, aux ack).

---

## 4. Verification

```bash
pnpm install
pnpm test    # portable tests; locked-fixture tests skip when targets/cache is absent
pnpm build   # runs tsc and outputs ESM declarations and source maps
```

All 121 unit, persistence, fault-injection, packaging, and compatibility tests
passed in the release build environment with the locally verified PocketRisu
snapshot present. Public clones omit that third-party snapshot; the tests that
require it report `SKIP`, while portable tests still run. Browser E2E and
live-provider generation are deliberately not claimed by this repository.

The directly importable API v3 artifact is
`plugin/risu-bg-bridge.plugin.js`. It registers the `Risu BG Server` provider
and a job-status dashboard. Compatible hosts use `backgroundModels`; stock
hosts may use an explicitly configured non-plugin `fallback_model` through
`runLLMModel` with plugin recursion disabled.

The plugin also publishes a canonical `//@update-url`. RisuAI's native plugin
settings page checks the remote `//@version`, asks for confirmation, then
re-imports the script while preserving the fixed internal name. Version
`0.9.0-beta.1` requires one manual upgrade because it predates this metadata;
automatic update discovery begins with `0.9.0-beta.2`. The script advertises
numeric updater version `0.9.0.2` because the host comparator is numeric-dot
based; the package and Git tag retain the SemVer prerelease form.

The plugin dashboard makes the same state visible without relying on the small
native update icon. It reports update available/current/unknown separately
from host-core state: ready, provider-registry setup required, or matching core
adapter required. Patch guidance is shown only when the negotiated host
capabilities prove that durable support is absent.

---

## 5. Portability & Adapter Kit (fail-closed patch tooling)

Everything below exists so that adapter work can never be produced against a
source that was not *proven* to be the pinned target. The kit treats any
unprovable fact as a hard error instead of a warning.

### 5.1 Target locks (`targets/`)

* `pocket.lock.yaml` — **verified-local** lock for the exact PocketRisu
  1.10.0 image (`risuai:nodeonly-client-aux-handoff-20260829`,
  imageId `sha256:f4147742…`), pinning 51 extracted server files by sha256.
  Loading the lock enforces the AGENTS.md gate in code: a pocket lock at any
  version other than `1.10.0` is refused outright.
* `vanilla.declared.yaml` / `haejeok.declared.yaml` — provenance records for
  targets that do not use the Pocket image-lock workflow. Haejeok's separately
  verified source patch is published under `adapters/haejeok/`.
* `lock-schema.json` — the strict mini-schema every lock must satisfy.
* `targets/cache/` — the local extraction snapshot the hashes are computed
  from. It is third-party source and local verification material only
  (`.gitignore`d; never shipped — build contexts contain only patched files,
  the Dockerfile, and a manifest).

`pnpm kit:verify` intentionally fails when that local snapshot is absent. To
reconstruct it, obtain a PocketRisu 1.10.0 image, run `scripts/fetch.mjs`, and
compare the resulting identity with `targets/pocket.lock.yaml` before applying
the series.

### 5.2 Toolchain (`scripts/`)

| Command | What it does (all fail-closed) |
|---|---|
| `node scripts/fetch.mjs --target pocket --image <ref> --out <dir>` | Extracts a snapshot via `docker create` + `docker cp` (container never started), refuses wrong versions, writes the file inventory. |
| `node scripts/gen-lock.mjs --meta targets/pocket.lock-meta.json --inventory <INVENTORY.json>` | Merges human notes with computed hashes into the lock. |
| `node scripts/verify.mjs --target pocket` | Lock + snapshot + INVENTORY cross-verification (AGENTS.md gate included). |
| `node scripts/apply.mjs --series adapters/pocket/series.yaml --out <dir> [--check]` | Two-phase apply: plan everything in memory, write only on full success; steps may only touch lock-pinned files; `--out` can never be inside the cache. |
| `node scripts/rebase-check.mjs --series adapters/pocket/series.yaml` | Classifies each step as applied / already-applied / needs-rebase after an upstream refresh. Exit 1 names the first failing step. |
| `node scripts/build.mjs --target pocket --out <ctx>` | Produces a Docker build context + `BUILD-MANIFEST.json`; verifies the Dockerfile FROM equals the locked image and the COPY set equals the series's touched files exactly. Never runs docker itself. |
| `pnpm kit:typecheck` | Typechecks `src/` + `plugin/` + `adapters/` together (the plain `pnpm build` compiles only `src/`). |

Patch steps support exact-count and token-boundary anchors (no regexes), and
replace/insert steps are idempotent: a step that finds `from` gone and `to`
present exactly once reports `already-applied` instead of double-patching.
Anything ambiguous is a rebase error, never a guess.

### 5.3 Adapter kits (`adapters/`)

* `adapters/pocket/` — the 1.10.0 bg-bridge kit: `series.yaml` (six steps:
  truncated-SSE-stream protection plus an authenticated bridge providing
  fingerprinted PUT, principal scoping, typed event/result reads, durable aux
  ACKs, delivery leases, and a hash-verified finalization proof seam),
  `adapter.ts` (verified capability matrix + strict request mapping; refuses
  unsupported tool workflows), `Dockerfile`, README. The capabilities served
  by the patched server and the adapter's matrix are asserted identical by
  `tests/kit-pocket-adapter.test.ts`; `tests/kit-pocket-bridge.test.ts` pins
  the installed bridge schema, routes, and fail-closed invariants.
* `adapters/haejeok/` — a scoped patch against the exact Haejeok b6704 source
  baseline recorded in its README. It excludes unrelated local performance and
  UI customizations.
* `adapters/vanilla/` — the stock foreground fallback (`runLLMModel`) with
  the all-absent capability matrix; no series/Dockerfile can exist until a
  real vanilla source is verifiable.

### 5.4 Plugin client (`plugin/src/`)

The Plan B client surface: `client.ts` (negotiate → durable/foreground
decision, refuses silent tool-workflow degradation), `negotiation.ts` (strict
capability validation over the host bridge or the v1 HTTP endpoint),
`uuidv7.ts` (client-minted job ids accepted by every verified transport),
`ledger.ts` (client-side half of PUT idempotency: fingerprint → id reuse),
`pocketTransport.ts` (HTTP dialect verified from the locked 1.10.0 source,
including raw-journal streaming with client-side resume; operations 1.10.0
never had throw instead of lying).

### 5.5 Known source-dependent gaps

Reported honestly in the lock itself; none are silently papered over:

1. Pocket 1.10.0 upstream git commit is unknown (image extract, not a
   checkout) — the lock pins the local image by config digest instead.
2. Docker daemon image identity is re-checked by `fetch`/`verify` at run
   time, not continuously.
3. Pristine Pocket 1.10.0 has no server-side request-fingerprint idempotency;
   this pinned patch series adds it without persisting request secrets.
4. No vanilla source is verifiable on this host, so no vanilla lock, series,
   or build can exist here (see `targets/vanilla.declared.yaml`).
5. Haejeok is distributed as a source patch instead of a Pocket-style image
   lock. Apply it only to the exact commit named in
   `adapters/haejeok/README.md`; a failed `git apply --check` is a hard stop.

## License

AGPL-3.0-only for this distribution. See `LICENSE` and `NOTICE` for the project
terms, corresponding-source link, and retained upstream notices. The original
GPL-3.0 notice is preserved in `LICENSES/GPL-3.0-upstream.txt`; this does not
claim that every historical host snapshot was already AGPL-licensed.

## Optional UI continuity companion

The independently installable `plugin/risu-bg-ui-continuity.plugin.js` enables
Touhou UI scroll restoration through a minimal, opt-in browser bootstrap.
It defaults OFF and does not alter server jobs, AUX rerolls, bot effects, or
the in-progress BG provider plugin. See [the UI adapter guide](adapters/ui/README.md)
for the version-locked installer, permissions, limitations, and tests.
