# Optional UI continuity companion (v1)

This is a browser-side BG Bridge companion, **not** a change to the durable
server engine. It restores scroll position after a Touhou sidebar/spell trigger
replaces a message's custom-HTML card. No bot markup, particles, keyframes,
provider requests, AUX rerolls, database state, or existing trigger callbacks
are rewritten.

## Minimal host integration

The installer accepts only a verified `pocketrisu@1.10.0` host directory.
It adds one static asset and one script tag to `dist/index.html`; there is no
renderer rewrite, server endpoint, new DOM RPC surface, or dependency on the
backgroundModels API. Keep this as an explicit host adapter, not a claim that
an unmodified official web site has the feature.

```sh
node scripts/install-ui-continuity.mjs --host=/path/to/verified-host --check
node scripts/install-ui-continuity.mjs --host=/path/to/verified-host
```

Run against a staging/build directory, test, then deploy through your normal
image release workflow. The installer retains `index.html.before-risu-bg-ui`.
Existing different assets or an ambiguous HTML anchor fail closed.
Reapplication of the same version is idempotent. Do not use an obsolete host
tree or patch an unrelated running image to force installation.

For a derived image, from this repository root:

```sh
docker build -f adapters/ui/Dockerfile --build-arg BASE_IMAGE=YOUR_VERIFIED_1_10_IMAGE -t YOUR_UI_IMAGE .
```

The image keeps its existing entrypoint and server files. Replacing a running
container is a separate deployment step, not something this installer performs.

## Plugin and permissions

Import `plugin/risu-bg-ui-continuity.plugin.js` alongside the existing BG Bridge
plugin. The separate artifact avoids coupling UI permissions to provider
permissions or forcing an upgrade of in-progress server/provider code.
Open **BG Bridge · UI Continuity**, enable it, and approve Risu's normal
`mainDom` permission prompt. It defaults OFF. Disable/unload removes the opt-in;
the host performs no document-wide scans or animation polling while idle.
The core asset is inert without the explicit `thgy-v1` opt-in attribute.

The plugin uses only public API v3 DOM/storage/settings/unload methods.
An unmodified official RisuAI host shows a missing-bootstrap error and remains
unchanged. BG generation itself does not require this UI feature.

## Transaction contract

- Capture synchronously before a `risu-btn`/`risu-trigger` click inside Touhou's
  sidebar or spell wrapper. AUX reroll/generation action names are excluded.
- Save the message ID/index, scroll-owning ancestors, and numeric positions in
  memory. Never synchronize device-local scroll state through the server.
- Match the replacement message ID and structural container path; wait for
  sufficient layout height before restoring. Reverse/negative scrolling is
  supported. A replaced message root without a stable message ID fails closed.
- Cancel on another interaction, wheel/touch/scroll-key input, tab hiding,
  disable, unload, or timeout. A newer transaction supersedes the older one.
- Observe only during the transaction; dispose after a stable restoration or
  the hard ten-second bound. No permanently running MutationObserver or timer.

## Important limits

This v1 restores position; **it does not stop the host from rebuilding the
card and does not promise removal of the visible flash**. It never clones
effect layers or pre-renders all sidebar panels to conceal the rebuild.
Frame-perfect continuity would require a separately reviewed renderer change.
Layout changes occurring after the bounded transaction are not overwritten.
If a different theme changes the container's structural path/classes during
the operation, restoration fails closed rather than scrolling a wrong element.

## Verification

```sh
node --import tsx --test tests/ui-continuity.test.ts
node --check adapters/ui/ui-continuity.js
node --check plugin/risu-bg-ui-continuity.plugin.js
# Requires playwright-core and a compatible Chromium installation:
node tests/ui-continuity.browser.cjs adapters/ui/ui-continuity.js
```

The browser suite covers replacement, spell wrappers, delayed layout sizing, retained
roots, reverse scrolling, disabled mode, user cancellation, changed message
identity, and unrelated controls. Real-host verification must distinguish a
read-only diagnostic browser with the companion injected from a deployed,
user-enabled plugin. Neither test enables the feature in other people's tabs.
See [the validation record](VALIDATION.md) for tested results and remaining gaps.

## License and corresponding source

AGPL-3.0-only; see root `LICENSE` and `NOTICE`. Existing upstream notices are
preserved separately. Corresponding source, including this host integration:
https://github.com/canister2668/risu-bg-bridge
