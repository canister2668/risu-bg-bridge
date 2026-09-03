# Vanilla adapter (stock foreground fallback)

**There is no vanilla server patch kit in this beta.** The build environment
did not contain a source checkout or image whose exact vanilla source identity
could be proven. `targets/vanilla.declared.yaml` records that boundary instead
of presenting an unverified patch as portable.

So the vanilla target is served entirely client-side:

- `foregroundAdapter.ts` implements the `BackgroundAdapter` contract with
  **every durable feature false** and a stock foreground fallback that runs
  generations through `Risuai.runLLMModel` (verified plugin-host surface:
  guarded `typeof === "function"` call, result normalized from
  `string | {result} | {content} | {text}`).
- `scripts/apply.mjs` refuses a vanilla series with `UnverifiableLockError`
  even if someone writes one — no `vanilla.lock.yaml` exists by design.

## What the fallback gives up (honestly)

No tab-close durability, no restart recovery, no event journal, no
server-side job store, no lease/finalizer protocol: if the tab closes or the
client restarts, the generation is gone. The plugin's client layer treats
"capabilities endpoint answered" as the upgrade condition — on vanilla it
never answers, so every request stays foreground.

## If vanilla source ever becomes verifiable

1. Check out the exact upstream release (full commit SHA, not a short hash)
   or pull an image whose provenance is verifiable.
2. `node scripts/fetch.mjs --target vanilla --image <ref> ...` (the AGENTS.md
   version gate for vanilla is unset, so the gate is the image's own
   package identity).
3. Author `targets/vanilla.lock-meta.json` with verified notes and honest
   gaps; `node scripts/gen-lock.mjs ...`.
4. Then — and only then — a `series.yaml` under this directory becomes
   legal. Until then this README is the whole adapter.
