# Haejeok retained UI validation — 2026-09-05

## Deployment identity

The production hostname's HTML matched the Haejeok b6732 app, not the legacy
PocketRisu instance. Verified PostgreSQL character scripts were snapshotted;
the old SQLite character was not copied into production.

The derived image retains the b6732-bgbridge5 server/provider files and overlays
only the built frontend. The actual public hostname served the new entrypoint
and ChatScreen chunk; the downloaded chunk SHA-256 matched the build artifact:
`e0655c7905ec25006e7844578b09a87c1ef10bc740377d7ab25cda92f9dd730a`.

## Passed checks

- `svelte-check`: zero errors, zero warnings.
- Component tests: two passed (retain DOM during pending parse; discard stale
  completion; do not replace effects when the rendered HTML is unchanged).
- Vite production build completed. Existing vm-browserify direct-eval warnings
  were retained, not introduced by the renderer changes.
- Production source maps: text source differences limited to Chat.svelte and
  ChatBody.svelte. Generated binary asset representations were excluded.
- PostgreSQL revision 1220 / audit 1227: two updated rows, both in the selected
  character's custom scripts. Only comment[1] and output_text[26] changed.
  All 59 script rows matched the expected candidate after commit.
- Actual deployed site, Chromium width 1280, no candidate-code/data injection:
  sidebar opening, tab navigation, and spell activation each kept scrollTop=400;
  the output card/scroll container remained attached. Sidebar remained present
  after opening and tab navigation; the clicked spell reached its open state.
  All five displayed spell images had natural dimensions 832x1216 at checks.
  No page errors were reported. Existing plugins were loaded; diagnostic writes
  and model calls were blocked rather than sent to production.
- Geometry fixture using the actual display script:

| Viewport | Before | After | Effect elements |
| --- | --- | --- | --- |
| 1280 | 345.59 x 697 | 345.59 x 463.09 | 177, unchanged |
| 390 | 288 x 501.69 | 288 x 385.91 | 177, unchanged |

The corrected ratio is 1:1.34 and the extra background offset is 0 instead of
-64px. Full animation definitions were checked for byte preservation when
building the candidate. No AUX trigger, keyframe, or particle element changed.

## Limits

No frame-rate benchmark or promise of zero image repaint is made. The retained
renderer removes pending-empty/remount phases; changed HTML still commits.
Not every unique spell's visual timeline was exercised. Geometry-fixture results
are not a substitute for every device/theme combination.
