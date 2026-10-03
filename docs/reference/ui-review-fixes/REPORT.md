# UI review fixes (2026-10-03)

An Opus architect reviewed `8bdd0f94..0e9f1e67`. A Sonnet executor fixed the findings. UI layer only; no `packages/core` change.

## Fixed (each with a test that fails on the old code)
1. `NumberField`: typing ".05" gave 25. The draft now syncs from `value` only on an external change.
2. Scoring dialog lost unsaved edits on any shell re-render. Settings are memoized; resets key on content.
3. PDF place-points lock: Auto with PDF points now locks eligibility, Off unlocks it at once, and the Lineup message names the real blocker.
4. An All-teams run with no team picked now shows Undo, and a team change keeps it.
5. The All-teams dialog drops a stale result when stage, gender, settings, Drop seniors or workspace change. Apply refuses if the lineup arrays moved.
6. Smaller: guarded `sessionStorage`; scorer caps `min=0`; Backspace removes; `aria-activedescendant` on the roster list; visible error when the preset fetch fails; theme token for the warning colour.
7. Weak tests strengthened (published 0 score, PDF hint path, emptied arrays).

## Checks
vitest 146 files, 1992 passed. Types 0. Lint 0 errors, 2 existing warnings. `run-tests`: 83 passed, 1 failed (`test_scoring_preset_routes.mjs`, pre-existing), 1 skipped. 27 mutations, all caught. Real db hash unchanged.

## Found, not fixed
- Diver weight stays editable under Auto with PDF points (the engine ignores it).
- Reverse of fix 3: choosing Auto in the dialog does not lock until save.
- One-shot Undo overwrites lineup edits made after the run.
- `SuggestedPresetBanner` "Load & save" has no `.catch`.
- Drawer Remove hint names no key; the drawer has no key handler.
- Fixed `text-amber-400` remains in five other files.
- A dismissed All-teams summary leaves Undo armed but hidden.
