# Entry-cap UI toggles — worker report

## Checks

- `npx vitest run` — 122 files, 1799 passed, 11 skipped
- `npm run lint:types` — exit 0
- `node scripts/run-tests.mjs` — 84 passed, 0 failed, 1 skipped
- eslint on touched files — exit 0
- Mutation: removing `ctx.settings` from `teamRosterView` count made the "counts when true" test fail; restored and green

## Blocked on me

none

## Changed

- `packages/manager/src/components/RosterScoringSetupParts.tsx` — added `EntryCapPolicyFields` (two checkboxes; checked state via `entryCapPolicy` so absent settings show defaults)
- `packages/manager/src/components/RosterScoringSetup.tsx` — renders `EntryCapPolicyFields` next to entry-cap numerics
- `packages/matrix/src/components/ScoringCapsFields.tsx` — same two checkboxes after max total entries
- `packages/manager/src/components/AthleteEntriesSection.tsx` — passes `settings` as 6th arg to `countSwimmerEntries`
- `packages/manager/src/components/AthleteLineupEditorPanel.tsx` — same
- `packages/manager/src/components/teamRosterView.ts` — passes `ctx.settings`
- `tests/rosterViewEntryCapTimeTrial.test.ts` — roster view warns "Over limit" for a TT only when `entryCapCountsTimeTrials` is true
- Vault session note: `Sessions/cursor-2026-10-01-entry-cap-ui-toggles.md`

Exports: `EntryCapPolicyFields` from RosterScoringSetupParts (additive). Existing props unchanged.

## Found

- `packages/ui` has no shared Checkbox component; reused the existing native-checkbox + `accent-[var(--text-accent)]` pattern already used in `ScoringCapsFields` (half-rate / relay-eligibility). No new dependency.
- All three manager call sites already had merged `settings` in scope; only the sixth argument was missing.
