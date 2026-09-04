# UI continuity v1 validation — 2026-09-05

## Verified

- Clean staged-source checkout: `npm test` — 125 passed, zero failed/skipped.
  This excludes unrelated, uncommitted provider work.
- Chromium synthetic browser suite: nine cases passed — replacement, spell
  wrapper, delayed layout, retained root, reverse scrolling, disabled mode,
  user cancellation, different message identity, unrelated control.
- Actual served `pocketrisu@1.10.0`, diagnostic Chromium at desktop width 1280
  and mobile width 390: sidebar opening and tab switching both restored the
  replacement card's scroll position to 500. Without the companion, the
  replacement card reset to zero. The original detached node is not the
  measurement target.
- A derived image built successfully from the existing verified 1.10.0 image.
  Inspection confirmed the index differs from its retained backup only by the
  bootstrap script tag, and the browser asset exists.

## Scope of evidence

The actual-host browser injected the companion in an isolated diagnostic tab.
Persistence/model requests were intercepted; it did not install or enable the
plugin in production. Public API permission/enable/unload behavior was tested
with the unit harness, not by installing the plugin in the operator's browser.

The live unique-spell effects were not exhaustively exercised. The synthetic
spell-wrapper case verifies scroll handling, not every effect's appearance.
No effect code, bot state, AUX reroll path, or provider code was changed.

The image was built, not deployed. Production was not restarted or replaced.
This verifies bounded scroll restoration, not elimination of card remounting
or visible flicker. No performance benchmark or frame-perfect claim is made.
