# UI simplification plan (2026-10-02)

Author: Claude `architect`, from the running app (Playwright, Dark/Light/OLED, 1440 and 800 wide)
plus code reading. Items marked [run] were reproduced in the app; [code] were read from source.
Scope chosen by the user: ambitious, keep every feature and all data. Executed in phases by a
worker, one phase at a time, each reviewed and committed on branch `nvitthanala/ui-simplification`.

## Decisions on the open questions (orchestrator, defaults accepted)

1. Batch optimizer respects "Drop seniors" like the other optimizers; the dialog says so.
2. Keep both "copy meet from another workspace" paths. Relabel each to say what it copies.
3. Rename the Manager step "Source" to "Athletes".
4. Fold the Matrix "Score" step into the first step, giving three steps: Meet, Standings, Analyze.
5. An empty cap field is invalid and keeps the last value. Per-swimmer caps are at least 1.
   Diver weight and relay multiplier accept 0.
6. Metrics keeps the header "Open video" button plus the drop zone.

## Defects found [run unless noted]

- Scoring number fields: clear then type 4 gives 9994 (`parseInt(...) || 999` in
  `ScoringCapsFields.tsx:65-105` and `RosterScoringSetupParts.tsx` `NumericSettingField`). A diver
  weight of 0 becomes 1 (`:55`) and a relay multiplier of 0 becomes 1 (`:137`) [code].
- Lineup dead end: with PDF place points on, choosing Roster mode saves, then `mergeScoringSettings`
  forces `points_pool` (`scoringDefaults.ts:682-683`) and Lineup stays locked. The copy also names
  NSISC (`RosterScoringSetup.tsx:73`, `RosterScoringSetupParts.tsx:140`, `TeamRosterPanel.tsx:382`).
- Analyze score-differences table: right-aligned headers, left-aligned cells, signed totals
  (`MeetDiffTable.tsx:90-92`).
- Batch optimizer ignores Drop seniors (`batchOptimizerView.ts:39`) and is enabled while What-if is off.
- Recalc resets Manager to Source (`ManagerApp.tsx:282`); a gender switch resets Matrix to Load
  (`MatrixApp.tsx:25`); Matrix always opens on Load (`OpsModule.tsx:208`).
- Below 768px no gender control is visible (`SuiteHeaderControls.tsx:15`); buttons lack `aria-pressed`.
- The PDF parse-format select sits on Standings (`MeetOpsStandingsStep.tsx:100-108`), not on Load.
- The Settings preview has a focusable decoy button (`SettingsPage.tsx:79`).
- Three scoring editors, three all-teams optimizer entry points, five team pickers, 133 `uppercase` uses.

## Target information architecture

- Shell: header stays as settled. Gender toggle always visible and compact (M / W) with
  `aria-pressed`. Sidebar auto-collapses below lg (1024px) without overwriting the stored preference.
- Manager: one shared team bar under the step tabs. Steps: Athletes (method picker, one "Meet and
  rules" summary card with "Edit scoring rules", "More tools" disclosures), Lineup (roster table,
  grouped checklist, link "Optimize this lineup"), Relays (team bar, sentence-case headings),
  Optimize (owns all optimizers: This team primary; More options; All teams dialog; Point
  opportunities). Header: Import roster primary; one "Export entries" menu (CSV and HyTek).
- Matrix: Meet (files, PDF options in a disclosure, scoring summary and banner, official team
  scores, copy meet), Standings, Analyze. Opens on Standings when a meet is loaded; the step
  survives gender switches and recalculation.
- Scoring rules: ONE editor (`ScoringSettingsFields` in `ScoringSettingsModal`) with a scorer
  eligibility field that shows the PDF-place-points lock and its reason.
- Settings: the preview is non-interactive. Metrics: one upload CTA plus the drop zone.

## Phases (run one at a time; each ends with green gates and a commit)

Rules for every phase: render tests live in `tests/*.test.ts` using `createElement` and the
`// @vitest-environment happy-dom` header (template: `tests/modalFocus.test.ts`). Run Playwright
against a COPY of the data: `OMNI_DATA_DIR=<copy> PORT=<free> npx playwright test`. Phase 1 creates
`tests/e2e/ui-ia.spec.ts` (themes midnight, deck-light, oled; widths 1440 and 800; fail on any
`pageerror`; screenshots to `test-results/ui-ia/<phase>/`); later phases extend it. Gates: `npm run
lint`, `npx vitest run`, `node scripts/run-tests.mjs`. Specs that depend on labels:
`tests/e2e/main-thread-budget.spec.ts:40`, `tests/e2e/matrix-chart.spec.ts`. Log each phase in
`docs/reference/UI_REDESIGN_STATE.json`. Never put the step in the URL (it races WorkspaceRouteSync);
use `sessionStorage`. Keep Dark, Light, custom and OLED working; no hex colors; no new dependencies;
keep modal focus, labels and keyboard access; nothing hardcoded to a conference or division; do not
touch `packages/core` scoring logic.

1. **Fix reproduced defects (no layout change).** New `NumberField` in `packages/ui` (draft string,
   commits only a valid parse, min/step, `aria-invalid`, keeps last valid value) used in
   `ScoringCapsFields.tsx` and `RosterScoringSetupParts.tsx`. `MeetDiffTable` alignment and no sign on
   baseline/projected. Matrix step above the remount key, persisted per workspace in `sessionStorage`,
   default Standings when `workspace.loadedMeet` exists; lift `rosterStep` out of the keyed
   `TeamManagementView`. Move the PDF format select to `MeetOpsLoadStep.tsx`. Gender toggle compact
   below md with `aria-pressed`. Settings preview `inert` + `aria-hidden`. Disable Batch optimizer
   while What-if is off; rewrite the observe-only copy. Tests: NumberField clear-and-type-4 gives 4;
   MeetDiffTable alignment; e2e: recalc keeps Optimize, gender switch keeps Standings, reload lands on
   Standings, 700px gender buttons visible with `aria-pressed`, preview button not focusable.
2. **One scoring-rules editor; unlock Lineup.** `ScoringRulesOpenerProvider` + `useOpenScoringRules()`
   in `packages/ui`, provided in `App.tsx`. Scorer eligibility field in `ScoringSettingsFields.tsx`
   ("Team scorer list" / "Points pool"), disabled with reason when PDF place points force points-pool.
   Manager scoring body becomes a read-only summary + "Edit scoring rules". Remove NSISC-specific copy;
   the locked Lineup names the real blocker with an "Open scoring rules" button. Tests: field renders;
   lock + reason; a grep test that no `.tsx` under manager/matrix names NSISC outside a preset list;
   modal `settings` equal `useWorkspaceScoring` for the same workspace.
3. **Manager Athletes step and shared team bar.** Rename Source to Athletes (`RosterWizardShell.tsx:14`,
   update `main-thread-budget.spec.ts:40`). Restructure `RosterSourceStep.tsx`. New `Disclosure`
   primitive in `packages/ui` (`aria-expanded`/`aria-controls`) for four "More tools". One team bar in
   `TeamManagementView.tsx`; remove the per-step team selects (Relays, Optimize, Lineup, panel).
   Remove duplicate intros and the `ManagerApp.tsx:222` subtitle; fix "Choose a team above"; rename
   "Inject recruit" to "Add swim"; merge exports into one menu. Tests: Disclosure; exactly one team
   select on Lineup/Relays/Optimize; at most 8 buttons above the fold on Athletes at 1440; both exports
   download; main-thread-budget passes.
4. **Optimize owns all optimizers (behaviour gate).** Move Batch optimizer into Optimize as "All
   teams…"; it takes `removeSeniors` and adopts the `outcome === 'unchanged'` guard. Lineup "Best
   roster"/"All teams" become "Optimize this lineup". "Classic" becomes "Quick optimize (greedy)" under
   More options. Tests: unchanged result applies nothing; `removeSeniors` reaches
   `optimizeRosterAllTeams`; EQUIVALENCE proof that "Best roster" (`TeamRosterPanel.tsx:360`) and
   `applyLegacy` (`RosterOptimizeStep.tsx:311`) give identical overrides, plans and totals on a fixture;
   if they differ keep both and label the difference, do not merge. Undo still appears.
5. **Matrix Meet / Standings / Analyze.** Three steps in `OpsModule.tsx:52-57`; fold Score into Meet
   (banners, "Edit scoring rules" via the opener, official team scores); own icon for Analyze; keep
   `ScoringSettingsPanel.tsx` until a grep shows it unused. Standings: heading "Team standings",
   toggles "Chart: By event / By class" and "List: By event / By swimmer", "Base" becomes "vs prelims"
   (`ProjectedActualScore.tsx:122`). No-workspace empty state gets a "New workspace" action. Tests:
   three tabs; landing step Standings with a meet; every scoring field reachable from Meet.
6. **Wording, case and density sweep.** Sentence case on the screens touched; labels: "Scoring rules",
   "Cross-course", "Point opportunities", "Link psych sheet", "no scorer cap". Hide the "Swimmer" tag when
   every row has it; group checklist items with one "Jump" link per row. One Metrics "Open video" CTA.
   Sidebar auto-collapse below lg. A vitest ratchet fails if hex literals in `*.tsx` under manager,
   matrix, ui and shell exceed the baseline counted at phase start. Tests: Lineup roster-mode button
   count at most 45 (now 78); sidebar collapsed at 800; screenshots in three themes.

## Not changing, and why

`packages/core` scoring and `mergeScoringSettings` locking (UI only explains the lock); the logo and
settled header split; the SwimCloud capture browser; the two copy-meet implementations (they copy
different data); the terms What-if and Baseline (add a one-line explanation instead); the 238 per-swim
"Edit time" buttons (keyboard access); the drawer's one-click athlete switching; chart internals;
existing chart hex colors on the chart path; the Metrics flow beyond duplicate CTAs; the step in the URL.

## Phase 1 execution record (2026-10-02)

Implemented the Phase 1 defect fixes and added `tests/e2e/ui-ia.spec.ts` plus render tests for numeric editing and the score-difference table. The Playwright spec verifies Matrix step persistence across gender changes and reloads, Manager step retention after recalculation, responsive gender controls, and the inert Settings preview. It writes screenshots for Matrix Load, Score, Standings and Analyze; Manager Athletes and Optimize; the batch optimizer; and Settings into `docs/reference/ui-phase-1/after/` across midnight, deck-light and oled at 1440px and 800px. See `docs/reference/ui-phase-1/REPORT.md` for check results and the missing before-screenshot evidence.

## Phase 2 execution record (2026-10-02)

Implemented the shared scoring-rules opener, scorer-eligibility field and Manager/Matrix summaries in `docs/reference/ui-phase-2/REPORT.md`. The Phase 2 Playwright spec captures after screenshots for Matrix scoring, Manager scoring, the Lineup lock and both modal entry paths. Exact before screenshots for Lineup and the modal were absent from Phase 1's capture set; the Matrix scoring and Manager source before captures reuse Phase 1 screenshots. The script test gate retains the pre-existing port 3209 startup failure, and the existing Manager main-thread budget spec timed out twice (first during the all-spec run and again on direct rerun).

## Phase 3 execution record (2026-10-02)

Renamed Source to Athletes. Restructured the Athletes step into the add-athletes picker, one "Meet and rules" card and a collapsed "More tools" Disclosure that holds the four tools (copy meet and scoring rules, changes from the loaded meet, working copy changes, import a scoring plan). Added the `Disclosure` primitive. Added one `ManagerTeamBar` under the step tabs as the only writer of the selected team, and removed the Relays, Optimize and Lineup selects and the Lineup empty-state team buttons. Removed the duplicate intros and the header subtitle. Renamed "Inject recruit" to "Add swim". Merged the two export buttons into one "Export entries" menu. Relabeled the Manager and Matrix copy-meet paths to say what each copies; they stay separate. Defaults chosen where the plan was silent: "More tools" is itself one collapsed Disclosure, so the Athletes step shows 6 buttons above the fold at 1440 (with four sibling Disclosures it would show 9); the team bar also shows on the Athletes step. See `docs/reference/ui-phase-3/REPORT.md`.

## Phase 4 execution record (2026-10-02)

Optimize now owns every optimizer. The header "Batch optimizer" button is gone. The Optimize step has "Optimize team" (primary), "All teams..." (opens a dialog that previews, says whether Drop seniors is on, applies nothing for an `unchanged` result, and arms Undo after an apply) and, under a collapsed "More options" Disclosure, "Quick optimize (greedy)" (formerly Classic). Lineup's "Best roster" and "All teams" are replaced by one "Optimize this lineup" button that opens the Optimize step. Equivalence gate: Best roster and Classic gave identical overrides, plans, active ids and totals on four fixtures, for one team and for all teams, against a golden file captured from the removed buttons at `fdeaf50a`, so they were merged; only the wrapper differed (Best roster applied an unchanged result, had no Undo, and used a confirm box). The plan's claim that `batchOptimizerView.ts` ignored `removeSeniors` was already out of date at HEAD (Phase 1 had threaded it); Phase 4 added the tests. The one-click all-teams apply was replaced by the dialog's preview-then-apply flow. Defaults chosen where the plan was silent: "All teams..." is also offered before a team is chosen; the dialog keeps its scope choice (scorers, events, full). Gates: vitest 140 files / 1916 passed; lint 0 errors; run-tests.mjs keeps the pre-existing `test_scoring_preset_routes.mjs` failure; main-thread-budget needed stale workspaces deleted from the data copy. See `docs/reference/ui-phase-4/REPORT.md`.

## Phase 5 execution record (2026-10-02)

Matrix has three steps: Meet, Standings, Analyze. Load became Meet and absorbs Score: the suggested-preset banner, the scoring summary with "Edit scoring rules" (through `useOpenScoringRules()`, so every scoring field is one click away in the shared dialog), and the official team scores. Analyze has its own icon. `ScoringSettingsPanel.tsx` stays because the Meet step uses it. A stored step of `score` or `load` now opens Meet; Standings still opens first when a meet is loaded, and the step still survives gender switches and recalculation. Standings is titled "Team standings", the toggles read "Chart: By event / By class" and "List: By event / By swimmer", and "Base" reads "vs prelims". The no-workspace empty state offers "New workspace". Two things the plan did not list: the official scores card had shown for every meet with empty values (fixed, with tests), and `WizardShell` now lays three steps out in one row (this also changes the Metrics strip, which has three steps). Defaults chosen where the plan was silent: the files card comes first and the scoring section below it; "Proj" next to "vs prelims" keeps its wording. Gates: vitest 141 files / 1933 passed; lint 0 errors; run-tests.mjs keeps the pre-existing `test_scoring_preset_routes.mjs` failure; 14 of 14 deliberate breaks caught. See `docs/reference/ui-phase-5/REPORT.md`.

## Phase 6 execution record (2026-10-03)

Sentence case on the screens Phases 1 to 5 touched: the `uppercase` class went from 161 lines to 14 (badges, abbreviations, the app nav, chart tooltips remain), title-case strings were lowered, and the labels are Scoring rules, Cross-course, Point opportunities, Link psych sheet and "There is no scorer cap.". The Phase 5 leftover "Proj +x" now reads "projected vs prelims +x". Lineup roster mode went from 94 DOM buttons (67 visible) to 12 (11 visible) on a 36-athlete roster; the brief's figure of 78 was not reproduced. The per-row Remove buttons are gone: remove with the Delete key on the roster list or the Remove button in the athlete drawer. The "Swimmer" tag hides when every row has it. Checklist rows merge per athlete with one Jump, hold rows past five behind "Show N more", and the checklist body renders once (it rendered twice, for mobile and desktop). The sidebar collapses below 1024 px without writing `omni-sidebar-collapsed`. Metrics keeps the header Open video button (now a real button, since a label for a hidden input is not keyboard reachable) plus the drop zone; the empty-state button is removed. The Analyze score-differences tables lost their fixed minimum width. Ratchets: hex literals in `*.tsx` at 18, `uppercase` lines at 14. Defaults chosen where the plan was silent: the Swimmer tag hides only for Swimmer (Diver and Recruit always show); the checklist limit is 5 rows per group. Gates: vitest 143 files / 1962 passed; lint 0 errors; 19 of 19 deliberate breaks caught; run-tests.mjs keeps the pre-existing `test_scoring_preset_routes.mjs` failure and its playwright part failed on 3 of 4 runs (two on a polluted data copy, one unexplained). See `docs/reference/ui-phase-6/REPORT.md`.
