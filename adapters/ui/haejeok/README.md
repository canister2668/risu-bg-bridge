# Haejeok b6732 retained UI rendering

This adapter targets HaejeokRisuAI b6732, not PocketRisu. The earlier PocketRisu
bootstrap is not a deployment for a Haejeok server and must not be described as
one. Resolve the actual site's served assets and active storage before editing.

## Opt-in and scope

Apply `retained-ui-b6732.patch` to the matching source. Add
`[UI_CONTINUITY_V1]` to a character custom-script comment to opt that card in.
Other cards retain their existing renderer lifecycle. This is a host rendering
adapter: installing the old standalone scroll companion is neither required nor
sufficient. No new plugin permission, model call, or persistent UI state is added.

- Preserve ChatBody identity on UI reload; still reparse via an explicit refresh key.
- Retain existing HTML until the latest parse finishes; discard stale completions.
- Reuse an unchanged custom theme DOM after CBS evaluation.
- Restore existing theme scroll containers immediately after the HTML commit.
- Suppress the native summary toggle when its action belongs to a Risu trigger.

This removes pending-empty/remount phases. Changed HTML still updates, so this
is not a claim that every image or animation has frame-perfect continuity.
Raw streaming and non-opt-in cards retain their previous paths.

## Touhou card geometry correction

The affected unique-spell display script used container-relative width but
viewport-relative fixed height (`height:min(128.64vw,697px)!important`).
Replace its three occurrences with `height:auto!important`, retaining
`aspect-ratio:1/1.34`. Remove the additional background crop by replacing the
specific `top:-64px` / `height:calc(100% + 64px)` override with `top:0` /
`height:100%`. Do not change keyframes, particle elements, durations, or AUX Lua.

For PostgreSQL, update only the opt-in comment and that display-script field,
using a before-value comparison, backup, normal storage revision, and audit rows.
Never apply the full legacy SQLite character over the PostgreSQL card.

## Build and deployment

Build the matching frontend into a fresh `dist` directory. Verify the unchanged
source against the running image's source maps where available, and run the
included component tests plus real-site browser checks before deployment.

```sh
pnpm exec vitest run src/lib/ChatScreens/uiContinuity.test.ts
pnpm exec svelte-check --tsconfig ./tsconfig.json
HAEJEOK_BUILD_NUMBER=6732 VITE_NODE_SERVER=true VITE_RISU_LEGAL_CONFIGURED=TRUE \
  node tooling/vite-build.mjs --sourcemap --outDir /absolute/staging/dist
docker build -f /path/to/this/Dockerfile \
  --build-arg BASE_IMAGE=YOUR_VERIFIED_RUNNING_IMAGE \
  -t YOUR_UI_IMAGE /absolute/staging
```

The derived image overlays static assets only and retains old hashed assets for
already-open tabs. Do not replace database, server, provider, or job-journal files.
Check active jobs before recreating the app container. Keep the previous image
and the before-value snapshot for rollback.

AGPL-3.0-only; preserve the host's original notices. Matching modification source
and build instructions: https://github.com/canister2668/risu-bg-bridge
