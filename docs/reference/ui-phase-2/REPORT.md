# UI Phase 2 report

## Changes

- Added `ScoringRulesOpenerProvider` and `useOpenScoringRules()` in `packages/ui`; the shell provides the opener and remains the single owner of `ScoringSettingsModal`.
- Added the scorer eligibility field to the shared scoring fields. It offers “Team scorer list” and “Points pool”, and disables the selection with an explanation when PDF place points lock the setting.
- Replaced Matrix's inline scoring form and Manager's scoring setup form with summaries that open the modal. Kept the suggested preset action available on Matrix.
- Changed the Lineup lock copy to identify the scorer eligibility requirement and added an “Open scoring rules” action.

## Screenshots

`before/` has 12 baseline captures (Matrix scoring and Manager source) copied from Phase 1's `after/` directory. Phase 1 did not capture Lineup or the scoring modal before it changed the app, so those two before sets are missing. `after/` has 30 captures from the Phase 2 Playwright run: Matrix scoring summary, Manager scoring summary, Lineup lock, and the modal opened from each applet, in midnight, deck-light and oled at 1440 and 800 pixels.

## Verification

- Regression tests first failed: both scorer eligibility tests failed because the field did not exist.
- Deliberate mutation: removing the select's `disabled` prop made the PDF lock test fail; restored it.
- `npm run lint`: passed with two existing complexity warnings in `packages/matrix/src/lib/swimCloudMeetImportBridge.ts`.
- `npm run lint:types`: passed.
- `npx vitest run`: 1,839 passed, 11 skipped.
- Phase 2 Playwright spec with a copied data directory and port 4201: passed; 30 screenshots captured.
- `node scripts/run-tests.mjs`, run twice with copied data and separate ports: both runs failed `test_scoring_preset_routes.mjs` because its server did not answer on port 3209. First run's bundled Playwright passed. Second run's bundled Playwright had one timeout in the untouched `tests/e2e/main-thread-budget.spec.ts`; rerunning that spec reproduced the timeout. The Phase 2 spec passed independently.
- Modal focus, modal accessibility and team-card button accessibility tests passed within Vitest.

The temporary data copy was removed after browser verification.
