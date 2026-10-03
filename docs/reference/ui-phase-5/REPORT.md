# UI phase 5 report (2026-10-02)

Matrix has three steps: Meet, Standings, Analyze. Branch `nvitthanala/ui-simplification`. No git writes were made.

## Changed

- Steps: `OpsModule.tsx` has three steps. Load is now Meet (id `meet`). The Score step is gone. Analyze has its own icon
  (`Activity`; Standings keeps `Trophy`, Meet keeps `ClipboardPaste`).
- Meet step: new `MeetOpsMeetStep.tsx` renders the files card (`MeetOpsLoadStep`, unchanged apart from copy) and the new
  `MeetOpsScoringSection.tsx`. The section holds the suggested-preset banner and the "Scoring rules" summary with
  "Edit scoring rules" (via `ScoringSettingsPanel` and `useOpenScoringRules()`), then the official team scores card.
  `MeetOpsScoreStep.tsx` is deleted (it had one importer).
- `ScoringSettingsPanel.tsx` is kept. A grep shows it is used (by `MeetOpsScoringSection`). Its `collapsible`,
  `defaultOpen`, `scoringView`, `onScoringViewChange` and `conference` props are still accepted and still ignored, as
  before Phase 5. I did not change that file.
- Step state: new `matrixStepState.ts` (`resolveInitialMatrixStep`, `normalizeStoredMatrixStep`, `matrixStepStorageKey`).
  Phase 1 behaviour is kept (sessionStorage per workspace, Standings when a meet is loaded). A stored `score` or `load`
  now opens Meet, and the effect writes `meet` back.
- Removed dead plumbing: `handleScoringViewChange` (OpsModule) and `onScoringViewChange` (MeetOperationsView). Nothing read
  them after the Score step went. The Merged / PDF only toggle is still reachable in the scoring-rules dialog, which the
  shell mounts with `onScoringViewChange`.
- Standings: heading "Team standings" (was "Performance Matrix: Overall Standing"). Chart toggle reads
  "Chart: By event / By class" (new `TeamCardChartToggle` in `TeamCardParts.tsx`, used by `TeamCard.tsx`). List toggle reads
  "List: By event / By swimmer" (`TeamCardMatrixList.tsx`). Accessible names of the options are unchanged.
- `ProjectedActualScore.tsx`: the compact baseline delta prefix "Base " is now "vs prelims ".
- `MatrixApp.tsx`: the no-workspace empty state has a "New workspace" action (same call as Manager). A failed create is
  caught because the provider already shows the error toast.
- `packages/ui` (shared, outside the Matrix folder): `WizardShell` sets `data-step-count`, and `index.css` makes a
  3-step strip fill one row from 30rem. Before, three steps left an empty fourth column at 1440 and an orphan row at 800.
  Metrics also has three steps, so its step strip changed the same way. I looked at Metrics at 1440 and 800 and it fills
  one row. Manager (4 steps) is unchanged.
- Tests and specs: `tests/matrixMeetStandingsAnalyze.test.ts` (17 tests). `tests/motionStub.ts` gained
  `useReducedMotion` (additive; the shared SegmentedControl calls it). e2e: `ui-ia.spec.ts` (Phase 1 block now uses
  Meet and asserts three tabs; two new Phase 5 tests), `ui-phase-2.spec.ts` (Score tab to Meet), `matrix-chart.spec.ts`
  (asserts three tabs).

## A bug fixed on the way

The old Score step showed the "Official team scores" card whenever `officialLookup.size > 0`. `buildTeamScoreLookup` sets
a key for every team and leaves the value undefined when the meet published no total. So the card showed for any meet and
printed team names with empty values (visible in `before/*-score.png`). `officialScoreRows` now keeps only teams that
have a score, and the card is hidden when none does. Tests cover both cases.

## Checks

- `npx vitest run`: 141 files, 1933 passed (Phase 4: 140 files, 1916).
- `npm run lint`: 0 errors, 2 existing warnings (`swimCloudMeetImportBridge.ts` complexity). `npm run lint:types`: 0 errors.
- `node scripts/run-tests.mjs` (with `OMNI_DATA_DIR` set to the copy): 83 passed, 1 failed, 1 skipped. The failure is
  `test_scoring_preset_routes.mjs` (409 where 201 was expected), the same script reported in Phases 1 to 4. I did not
  diagnose it. The run includes "playwright e2e (all specs)".
- Playwright on a copy of the data (`OMNI_DATA_DIR`, port 3517): `ui-ia` (7 tests), `ui-phase-2`, `matrix-chart` and
  `production-server`: 11 passed. `main-thread-budget` timed out at 60 s on the polluted copy. After I deleted the 19 stale
  `ui-*` workspaces from the copy only, it passed, but only "Blank Workspace 1" remained, so that run is thin (all four
  Manager steps 0 ms blocked, 0 tasks). It does not touch Matrix.
- `data/omniswim.db`, `-wal`, `-shm` SHA-256 hashes and the `data/backups` listing are unchanged.
- Mutation checks (break, run `tests/matrixMeetStandingsAnalyze.test.ts`, restore). All 14 were caught:

| Break | Tests that failed |
| --- | --- |
| Meet step drops the scoring section | 2 |
| Landing ignores a loaded meet | 2 |
| Stored `score` not migrated | 3 |
| Stored `load` not migrated | 2 |
| Official rows keep teams without a score | 2 |
| Heading back to "Performance Matrix" | 1 |
| "vs prelims" back to "Base" | 1 |
| Chart toggle loses "Chart:" | 1 |
| Chart toggle back to "By Event" | 1 |
| List toggle loses "List:" | 1 |
| List toggle back to "By Swimmer" | 1 |
| Empty state loses "New workspace" | 1 |
| Analyze reuses the Standings icon | 1 |
| A fourth step comes back | 3 |

The e2e tests were not mutation-tested. The `data-step-count` CSS rule has no automated test; I checked it in the
screenshots only.

## Screenshots

`docs/reference/ui-phase-5/before` (24) and `after` (18, plus two Metrics tab-strip shots): Matrix Meet, Standings,
Analyze (before also has Score), midnight, deck-light and oled, at 1440 and 800. The "before" set was taken from HEAD
before any source edit. PNGs are git-excluded by `.git/info/exclude`.

## Found, not fixed

- "Proj" (the projected-vs-prelims badge next to "vs prelims") still reads "Proj +x". Next to "vs prelims +y" it is
  ambiguous. The brief named only "Base". Say if "Proj" should become "projected vs prelims".
- Analyze at 800 px: the score-differences table is cut off at the right edge in `after/*-800-analyze.png` (the Delta
  column). It was already so at HEAD; I did not touch the table.
- Uppercase styling and title case remain in places ("Points by Event", "Team Matrix", "Top Individual Contributors").
  The plan assigns that to Phase 6.
- The no-workspace empty state is covered by a vitest render only. The Playwright data copy always has a workspace.
- `/matrix?workspace=<id>` is still used by `matrix-chart.spec.ts`, `ui-phase-2.spec.ts` and the Phase 1 block. It worked
  in every run here. The new Phase 5 specs use `omni-active-workspace-id`.
- `WorkspaceRouteSync` swap loop and stale test workspaces in the real db: carried over, not touched.
- Vault not updated: this agent reports to the orchestrator, which owns that.
