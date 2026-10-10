# UI phase 6 report (2026-10-03)

Wording, case and density sweep. Branch `nvitthanala/ui-simplification`. No git writes were made. `packages/core` was not touched.

## Baselines counted at phase start (HEAD `b16c78e5`, before any edit)

- Hex literals in `*.tsx` under `packages/manager`, `packages/matrix`, `packages/ui`, `apps/shell/src`: **18**
  (regex `#[0-9a-fA-F]{3,8}\b`). They are chart-path colours (`TeamCard.tsx` 5, `MomentumChartCard.tsx` 3),
  `AnalyticsPage.tsx` 2 and the Settings accent swatches 8. After Phase 6 the count is still 18.
  The ratchet test `tests/uiCaseAndColorRatchet.test.ts` holds `HEX_LITERAL_BASELINE = 18`.
- `uppercase` class on non-comment lines in `*.tsx` under `packages/**` and `apps/shell/src/**`: **161**
  (the plan said 133; it counted another way). After the sweep: **14**. The same test holds `UPPERCASE_BASELINE = 14`.
- Lineup buttons (Lineup tab panel, roster mode, 36-athlete team, 1440 wide): **94 in the DOM, 67 visible** before;
  **12 in the DOM, 11 visible** after. The brief said 78; I could not reproduce that figure and report my own measure.
  The roster was a clone of the largest workspace in the data copy (585 men's results, "Henderson State"), switched to
  roster mode in the clone only.

## Changed

Case and wording
- Removed `uppercase` and its `tracking-*` classes from headings, labels, table heads and buttons in more than 50 files on the
  screens Phases 1 to 5 touched (Manager, Matrix, Metrics, Settings preview, sidebar headings, shared `SegmentedControl`
  and `ConfirmDeleteModal`). 10 px and 9 px label sizes moved to `text-ui-caption` / `text-ui-micro`. `font-black` became `font-bold` on those lines.
- Title-case strings became sentence case: "Swim metrics", "Open video", "Link psych sheet", "Auto format", "Regular list",
  "Points by event", "Team matrix", "Projected points", "Top individual contributors", "Saved sessions",
  "Import roster / history", "Workspace deleted", "Single stroke", "Start tagging", "Apply lineup change", and in the
  All teams dialog "Optimization scope / summary", "Projected total", "Baseline total", "Changes proposed",
  "Run optimizer", "Apply to workspace".
- Labels: Scoring rules (the shared dialog was "Scoring Matrix Configuration", now "Scoring rules", also its accessible name),
  Cross-course (Lineup side tab and panel heading; was "Arbitrage" / "Cross-course arbitrage"), Point opportunities (Optimize
  heading; was "Point arbitrage"), Link psych sheet (was "Link Psych"), "There is no scorer cap." (the roster help text printed
  "999-scorer cap").
- `ProjectedActualScore` (Matrix, compact): the badge beside "vs prelims" reads "projected vs prelims +x" instead of "Proj +x".

Density
- `TeamRosterRow` / `TeamRosterTable`: the 36 per-row "Remove" buttons are gone. Removing an athlete is now: **Delete** key on
  the roster list with a selected row (same confirm dialog), or a **Remove** button in the athlete drawer
  (new optional prop `onRequestRemove` on `AthleteLineupDrawer` and `AthleteLineupEditorPanel`). The help line and the list's
  accessible name say "Delete to remove". The drawer is fixed on the right and covers the old remove column at lg, so a
  per-row button for the selected row would have been hidden.
- "Swimmer" tag hidden when every row would show it: new `isUniformSwimmerRoster()` in `teamRosterView.ts`,
  `AthleteRoleTag` prop `hideSwimmer`, `TeamRosterRow` prop `hideSwimmerTag`. Diver and Recruit tags always show. The drawer always shows its tag.
- Lineup checklist: new `lineupChecklistView.ts` (`buildChecklistRows`, `visibleChecklistRows`, `CHECKLIST_GROUP_ROW_LIMIT = 5`).
  One row per athlete with one Jump link; relay-leg and suspected-duplicate items keep their own rows. Each group shows 5
  rows and a "Show N more" button (`aria-expanded`, `aria-controls`). `LineupComplianceChecklist` now renders its body once
  (it rendered a mobile copy and a desktop copy, which doubled every button in the DOM).
- Sidebar: new `apps/shell/src/lib/sidebarCollapse.ts` (`useSidebarCollapse`, `resolveSidebarCollapsed`,
  `readSidebarPreference`). Below 1024 px the sidebar collapses by itself. `omni-sidebar-collapsed` is never written for the
  automatic collapse. The toggle on a narrow screen opens it for that visit only. At lg and up the toggle still saves the choice.
- Metrics: one "Open video" control in the header plus the drop zone. The empty-state button is removed. The header control
  was a `<label for>` on a hidden input, which the keyboard cannot reach; it is now a `<button>` that clicks the input.
- Analyze: `MeetDiffTable` and `PrelimsDiffTable` lost their `min-w-[620px]` / `min-w-[720px]`, and use tighter cell padding
  below xl. The table fits its container at 800 px with the sidebar collapsed (691 px wide) and with it opened by hand (551 px).
  `overflow-x-auto` stays as a fallback.

Tests (new)
- `tests/phase6WordingDensity.test.ts` (24 tests): Lineup at most 45 buttons on a 40-athlete roster, no per-row Remove,
  Delete key, drawer Remove, Swimmer tag uniform/mixed, checklist merge/limit/Show more/once-only render/Jump key,
  Cross-course, Point opportunities, "projected vs prelims", one Open video control and its click, sidebar helper and hook
  (800 px collapsed, stored value untouched, temporary open, widening, lg still saves), scorer-cap phrase.
- `tests/uiCaseAndColorRatchet.test.ts` (5 tests): hex ratchet at 18 and uppercase ratchet at 14.
- `tests/e2e/ui-phase-6.spec.ts` (5 tests): screenshots in 3 themes at 1440 and 800 (`PHASE6_SHOT_DIR=before` for the
  before set); Lineup button count at most 45 plus keyboard Delete and drawer Remove; sidebar at 800 / 1280 with storage
  asserted; Analyze table fit at 800 in both sidebar states; labels and keyboard-reachable Open video (file chooser opens on Enter).
- Existing tests updated for renamed labels: `bestRosterEquivalence`, `optimizeStepOwnership` ("Run optimizer",
  "Apply to workspace"), `scoringSettingsModalA11y`, `ui-ia.spec.ts`, `ui-phase-2.spec.ts` ("Scoring rules").

## Checks (real numbers)

- `npx vitest run`: 143 files, 1962 passed (Phase 5: 141 files, 1933).
- `npm run lint`: 0 errors, 2 existing warnings (`swimCloudMeetImportBridge.ts` complexity). `npm run lint:types`: exit 0.
- `node scripts/run-tests.mjs` with `OMNI_DATA_DIR` set to the copy: 83 passed, 1 failed, 1 skipped on the last run. The failure is
  `test_scoring_preset_routes.mjs` (assertion, same script as Phases 1 to 5; not diagnosed). **The playwright part of that
  runner failed on 3 of 4 runs**: the first two started on a copy polluted by my own earlier spec runs; the third started with one
  workspace and failed for a reason I did not capture (the runner prints only the last 40 lines, which were server log noise);
  the fourth, run through a temporary copy of the runner that dumps the full output (deleted afterwards), passed. I did not find
  the cause of the third failure. Treat it as unexplained flakiness until seen again.
- Playwright against the copy (`OMNI_DATA_DIR`, ports 3641 and 3000): all 17 specs passed on three full runs with the copy reduced to
  "Blank Workspace 1" first (main-thread-budget, matrix-chart, production-server, ui-ia, ui-phase-2, ui-phase-6). With stale `ui-*`
  workspaces in the copy, `main-thread-budget` times out at 60 s (as in Phases 4 and 5); I deleted them from the copy only, through the copy's API.
  The main-thread run is thin (one workspace; Athletes 50 ms blocked, other steps 0 ms).
- Mutation checks (apply a break, run the tests, restore; the `git diff` hash was identical before and after the whole batch).
  All 19 were caught:

| Break | Failures |
| --- | --- |
| Per-row Remove button returns | vitest 1, e2e 1 |
| Checklist row limit removed | vitest 2 |
| Checklist rows stop merging per athlete | vitest 2 |
| Swimmer tag always shown | vitest 1 |
| Checklist body rendered twice | vitest 1 |
| Delete key handler broken | vitest 1 |
| Drawer Remove button gone | vitest 1 |
| Sidebar ignores the narrow window | vitest 4, e2e 1 |
| Sidebar writes the stored choice when narrow | vitest 3, e2e 1 |
| Analyze table min width restored | e2e 1 (see note) |
| Metrics gets a second Open video control | vitest 1, e2e 1 |
| Lineup tab back to "Arbitrage" | vitest 1, e2e 1 |
| Optimize heading back to "Point arbitrage" | vitest 1, e2e 1 |
| Compact badge back to "Proj " | vitest 1 |
| 999 scorer cap prints a number | vitest 1 |
| "Link psych sheet" back to "Link Psych" | e2e 1 |
| Scoring dialog title back to "Scoring Matrix Configuration" | vitest 1 |
| Hex literal added | vitest 1 |
| `uppercase` class added | vitest 1 |

  Note: my first Analyze test passed with the old min width, because the new sidebar collapse alone widens the table's container to
  691 px. I changed the test to also open the sidebar by hand at 800 px (551 px container); the break then failed it.
  The e2e Delete-key and drawer-Remove steps are covered by the vitest breaks above; the e2e spec was not separately mutation-tested for them.
- `data/omniswim.db`, `-wal`, `-shm` SHA-256 hashes unchanged from before the phase; `data/backups` still 25 files.

## Screenshots

`docs/reference/ui-phase-6/before` (36) and `after` (36): Athletes, Lineup, Optimize, Matrix Standings, Matrix Analyze, Metrics;
midnight, deck-light, oled; 1440 and 800. The before set was taken from HEAD before any source edit. PNGs are git-excluded.
Running the other e2e specs also rewrote the `after` PNGs of Phases 1, 3, 4 and 5 with current renders.

## Found, not fixed

- `uppercase` is still on 14 lines: `Badge` (shared status pill), `LoadingSpinner`, app nav and M / W buttons, `CommandPalette`
  group heads, `SuiteHome` eyebrow, workspace-list date, chart tooltips, `ChartStaleBundleGuard`, `SwimCloudCaptureBrowser`,
  `SwimCloudImportDiagnosticsPanel`. `.label-caps` in `index.css` (14 uses, mostly `EmptyState` eyebrows) is also upper case.
  Not in the class count.
- "Chronological Team Score Timeline" keeps its capitals: `ChartStaleBundleGuard` finds the stale chart bundle by that exact text.
- The checklist rows for one problem type repeat the same sentence per athlete ("... division is not mapped ..."). A summary row
  ("6 athletes: division not mapped") would be shorter but needs a change to what the audit emits, which is core.
- Removing an athlete took one click on a row button; it now takes two clicks with a mouse (select, then Remove in the drawer) or Delete on the keyboard.
- The Lineup side tabs (Checklist / Cross-course / Scenarios) wrap to two rows at 1440 in the narrow column (unchanged).
- The brief's "78 buttons" does not match my measure (94 DOM / 67 visible) on the same step; I did not find where 78 came from.
- The Lineup button-count e2e needs a large roster; it uses the biggest non-`ui-` workspace in the data, else the 12-row chart fixture
  (then the count is small and the test proves less). The vitest test uses a synthetic 40-athlete roster and does not depend on the data.
- `/matrix?workspace=<id>` and `/manager?workspace=<id>` cold loads still loop in the shell's route sync (older specs use them). Not touched.
- Vault not updated: this agent reports to the orchestrator, which owns that.