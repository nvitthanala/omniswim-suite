# UI phase 4 report (2026-10-02)

Optimize owns all optimizers. Branch `nvitthanala/ui-simplification`. No git writes were made.

## Equivalence verdict

"Best roster" (Lineup, `TeamRosterPanel.runOptimizer`) and "Classic" (Optimize, `applyLegacy`) give the
same result. They were merged. The Lineup step no longer has an optimizer.

Proof, in `tests/bestRosterEquivalence.test.ts`:

- `tests/fixtures/bestRosterGolden.json` holds what the old Lineup buttons produced at commit `fdeaf50a`.
  I captured it by rendering the real `TeamRosterPanel` and clicking "Best roster" and "All teams" on four
  fixtures (`tests/optimizerStepFixtures.ts`): a meet where nothing beats the lineup, a meet with a real gain,
  the same gain with Drop seniors on, and a recruit-only roster.
- The Optimize step's "Quick optimize (greedy)" (the old Classic) and its "All teams" dialog must reproduce
  those values: scorer overrides, planned entries, active ids, and the totals the old confirm box showed.
  All 8 comparisons pass. The optimizer mints a random UUID per added plan, so plan ids are compared by position.
- Both paths call `optimizeRosterForTeam(workspace, gender, team, removeSeniors, settings, 'all')`. The only
  input difference is that Best roster ran `mergeScoringSettings(settings)` first. A 26-case test shows that
  extra merge changes nothing for generic, NSISC, PDF place points, explicit points pool, explicit roster, and
  every built-in preset that carries settings, under three conference values.

Differences that remain are in the wrapper, not the result:

| | Best roster (removed) | Quick optimize (greedy) |
| --- | --- | --- |
| Unchanged result | Asked "Projected 248.0 pts (was 248.0). Apply?" and wrote the same state back | Applies nothing, says so, no Undo |
| Confirmation | `window.confirm` | Change summary panel |
| Undo | None | One-shot Undo |
| Needs What-if | Used `editable` | Disabled while What-if is off |

Limits of the proof: Men only, four fixtures, NSISC-shaped settings for the run comparison. The settings
comparison covers more, but the run comparison does not.

## Changed

- `RosterOptimizeStep.tsx`: owns every optimizer. "All teams..." opens the dialog; the old one-click
  `applyAll` is gone. `applyAllTeamsResult` records the run, applies, arms Undo. It is also reachable before a
  team is chosen (a small card under the team prompt).
- `RosterOptimizeStepParts.tsx`: "Optimize team" primary, "All teams..." second, "More options" Disclosure
  holding "Quick optimize (greedy)" with one sentence of help. "Classic" is gone.
- `BatchOptimizerPanel.tsx`: now "Optimize all teams". Says whether Drop seniors is on. Apply is disabled for
  an `unchanged` result and shows why. `onApply` now receives the whole result. Counts come from
  `diffOptimizerChanges`. Close button has an aria-label.
- `batchOptimizerView.ts`: result carries `outcome`, `optimizer` and `changes`. New `buildBatchApplyPatch`
  (null when unchanged, otherwise all three optimizer fields) and `BATCH_UNCHANGED_MESSAGE`.
- `ManagerApp.tsx`: header "Batch optimizer" button, state and mount removed.
- Lineup: `TeamRosterHeader` shows one "Optimize this lineup" button (opens the Optimize step).
  `TeamRosterPanel` lost `runOptimizer` and the `removeSeniors` prop; `RosterLineupStep` and
  `TeamManagementView` pass `onOpenOptimize`.
- Tests: `tests/bestRosterEquivalence.test.ts` (40), `tests/optimizeStepOwnership.test.ts` (14), helpers
  `tests/optimizerStepFixtures.ts`, `tests/optimizerNormalize.ts`, `tests/motionStub.ts`, golden JSON.
  `tests/e2e/ui-ia.spec.ts`: Phase 1 block moved to the new button and dialog name, two Phase 4 tests added.

## Checks

- `npx vitest run`: 140 files, 1916 passed (Phase 3: 138 files, 1862).
- `npm run lint`: 0 errors, 2 existing warnings (`swimCloudMeetImportBridge.ts` complexity). `npm run lint:types`: exit 0.
- `node scripts/run-tests.mjs` (with `OMNI_DATA_DIR` set to the copy): 83 passed, 1 failed, 1 skipped.
  The failure is `test_scoring_preset_routes.mjs`, the same script reported in Phases 1 to 3. I did not
  diagnose it. The skip is the PostgreSQL round trip.
- Playwright on a copy of the data (`OMNI_DATA_DIR`, port 3417): `ui-ia` (5 tests), `ui-phase-2`,
  `matrix-chart` and `production-server`: 9 passed. `main-thread-budget` timed out at 60 s on the polluted
  copy (19 workspaces). After I deleted the 18 stale `ui-*` workspaces from the copy it passed, but only
  "Blank Workspace 1" remained, so that run is thin (Athletes 54 ms blocked; Lineup, Relays, Optimize 0 tasks).
- `data/omniswim.db`, `-wal` and `-shm` hashes, and the `data/backups` listing, are unchanged.
- Mutation checks (break, run both new test files, restore). All 9 were caught:

| Break | Tests that failed |
| --- | --- |
| `buildBatchApplyPatch` loses the unchanged guard | 4 |
| Batch run ignores `removeSeniors` | 3 |
| Quick optimize ignores `removeSeniors` | 1 |
| Quick optimize runs the scorers stage only | 3 |
| `applyOptimizerResult` loses the unchanged guard | 3 |
| All-teams apply never arms Undo | 1 |
| "Optimize this lineup" has no click handler | 1 |
| Quick optimize relabelled back to "Classic" | 7 |
| Dialog Apply enabled for unchanged | 3 |

The settings idempotency check is a property of core `mergeScoringSettings`. I did not mutate core, so it has
no mutation proof.

## Screenshots

`docs/reference/ui-phase-4/before` (12) and `after` (24): Lineup and Optimize, midnight, deck-light and oled,
at 1440 and 800. After also has "More options" open and the dialog open. The "before" set was taken by
temporarily putting the nine HEAD source files back, running the spec, then restoring my versions
(type check clean afterwards). PNGs are git-excluded by `.git/info/exclude`.

## Found, not fixed

- The plan said `batchOptimizerView.ts:39` ignores `removeSeniors`. At HEAD it did not: Phase 1 had already
  threaded it. Phase 4 added the missing tests and made the dialog say what it does.
- Old dialog bugs, fixed by the rewrite: it wrote only non-empty arrays, so a run that emptied one could not
  clear it; it toasted "Optimization complete" for an unchanged result; its plan count was a length
  difference, wrong when plans were swapped.
- One-click all-teams apply is gone. The dialog adds a preview step. If you want one-click back, say so.
- The dialog applies the result it computed. It does not re-check that the workspace is unchanged since the
  run. The dialog is modal, so I judged this low risk.
- The Phase 1 spec used `/manager?workspace=<id>`, which hits the known swap loop and detached the new button
  mid-click. I moved that line to the `omni-active-workspace-id` start used since Phase 3.
- The fixture has no women's results, so switching to Women shows "Bring in swimmers first" and no
  all-teams action. The spec now switches back to Men before checking it.
- Running the Phase 1 spec rewrites `docs/reference/ui-phase-1/after/*.png`, including the batch-optimizer shot,
  which now shows the new dialog. Those files are git-excluded.
- `WorkspaceRouteSync` swap loop and the stale test workspaces in the real db: carried over from Phase 3, not touched.
- Vault not updated: this agent reports to the orchestrator, which owns that.