# Code health: complexity, duplication, efficiency

Date: 2026-09-25. Branch: `nvitthanala/production-readiness`.
Progress log: `docs/reference/CODE_HEALTH_2026-09-25_STATE.json`.
Executor model: **Sonnet (worker)** for every item, per the user, to save
usage. One agent at a time. The orchestrator verifies and commits.

## 1. What was measured (2026-09-25, at `9568db5b`)

Measured with the repo's own ESLint config plus `complexity: 25`,
`max-depth: 5` and `max-lines-per-function: 200`, and `jscpd` (min 12 lines).

- **33 functions over complexity 25; 33 functions over 200 lines.**
- **Duplication is low: 0.5%, 12 clones.** Duplication is not the main
  problem; very large functions and components are.
- **No coverage tool is installed.** Safety comes from the protocol in
  section 2, not from a coverage number.

Top complexity (cyclomatic): `parser.ts:3380` 65 · `simulateRoster` 63 ·
`classifySwimCloudUrl` 62 · `TeamRosterPanel` 53 · `parser.ts:5962` 48 ·
`calculatePoints` 45 · `parser.ts:5047` 45 · `swimcloudCaptureRoutes.ts:980`
40 · `validateRaceTags` 38 · `scoreIndividualsInEvent` 38 · `buildCutlineTag`
37 · `buildPrelimsDeltaTimeline` 37 · `buildScorerRosterLookup` 37 ·
`TeamCard` 37.

Longest functions: `startServer` 917 lines · `RosterImportWizard` 738 ·
`SwimCloudCaptureBrowser` 725 · `TeamCard` 631 · `TeamRosterPanel` 628 ·
`ScoringSettingsFields` 583 · `MeetOperationsView` 580 ·
`AthleteHistoryImportPanel` 564 · `IndRelayManagementView` 539.

Largest clones: `prelimsProjection.ts:433` ↔ `psychProjection.ts:245` (73
lines) · `psychProjection.ts:250` ↔ `scoringEngine.ts:132` (61) ·
`TempoProfile` ↔ `VelocityProfile` (43 + 37) · `RecruitForm` internal (32 +
26) · `RosterOptimizeStep` internal (24) · `dropAdd` ↔ `exactSwaps` (14) ·
`workspaceRepo` Sqlite ↔ Pg restore (14) · `swimEditor` internal (14).

## 2. Safety protocol — every item, no exceptions

A refactor here changes structure, never behaviour. The worker follows these
steps in order and reports each one.

1. **Prove coverage first.** For each function to change, break it on
   purpose (flip a comparison, drop a branch) and run its tests. If no test
   fails, write a characterization test that pins the current output on real
   data (fixtures in `tests/fixtures/`, `data/meets.json`), then re-check.
   Revert the break.
2. **Golden output for scoring and parsing.** Before touching a scoring or
   parser function, record its output over every real input (all
   workspaces in `data/meets.json`; every parser fixture) as a JSON
   snapshot. After the refactor the snapshot must be byte-identical.
3. **Small steps.** Use the `cyclomatic-complexity` skill's techniques only:
   guard clauses, extract function, lookup tables, named predicates. No new
   abstractions, no generic frameworks, no clever one-liners. Target: each
   touched function ≤ 20 complexity and ≤ 120 lines, unless splitting it
   would scatter one rule across files (then say so and stop).
4. **No behaviour or API change.** Exported names, signatures, types, error
   messages, UI text and DOM structure stay the same. Private helpers may be
   added in the same file or a sibling file in the same package.
5. **Keep provenance comments.** Comments that cite a source, a decision
   date or a real-data finding move with their code; they are never
   deleted.
6. **Efficiency changes need a measurement.** Only change code for speed
   when a benchmark or the Playwright `main-thread-budget` spec shows a
   cost. `docs/reference/PERFORMANCE_NOTES.md` lists what was already
   investigated; do not redo it.
7. **Gates** (plan `2026-09-24/01` section 1): lint 0, full vitest, script
   suite 84/0/1, build; `npm run build:extension` when `packages/swimcloud`
   or `extensions` changed.
8. **Scope.** One package group per item. Never `data/cutlines/**`.
   Never change a rule in `docs/INVARIANTS.md`; if a refactor seems to need
   one, stop and report.

## 3. Items, in order (one Sonnet agent at a time)

`packages/core` items wait until the running core work (B3, R1) has landed.

| # | Scope | Targets | Special check |
| --- | --- | --- | --- |
| H1 | `packages/swimcloud` | `parser.ts` six complex readers (lines ~3093, 3380, 3738, 4446, 5047, 5962); `urlClassifier.classifySwimCloudUrl` (62 → a table of path shapes) | Golden parse of every fixture; every URL test; robots exemptions unchanged; rebuild extension |
| H2 | `apps/shell`, `packages/db` | `startServer` (917 lines → route-registration modules, same routes and order); `swimcloudCaptureRoutes.ts:980`; `workspaceRepo` restore clone; `writeWorkspaceUnsafe` in both services | Route list identical (method + path + middleware order), dumped before and after; data-loss guard tests |
| H3 | `extensions/swimcloud-companion` | `runCrawl` (35) | Pacing, 403 stop, relay-failure streak, refresh flag unchanged; rebuild bundle |
| H4 | `packages/metrics`, `packages/manager` (forms) | `TempoProfile` ↔ `VelocityProfile` clone; `RecruitForm` clones; `RosterOptimizeStep` clone | Render tests before/after; same DOM |
| H5 | `packages/manager` (large components) | `TeamRosterPanel`, `RosterImportWizard`, `AthleteHistoryImportPanel`, `IndRelayManagementView` | Extract pure view-model helpers (unit-tested) and child components; same DOM and props; keep existing `useMemo` boundaries (see PERFORMANCE_NOTES #2) |
| H6 | `packages/matrix`, `packages/ui` | `TeamCard`, `MeetOperationsView`, `ScoringSettingsFields`, `SwimCloudCaptureBrowser` | As H5 |
| H7 | `packages/core` scoring (after B3, R1) | `simulateRoster`, `calculatePoints`, `scoreIndividualsInEvent`, `scoreTimedFinalIndividualsInEvent`, `computeNcaaEventScoring` | **Golden scoring snapshot over every real workspace, byte-identical**; never-loses guard tests |
| H8 | `packages/core` other (after H7) | projection clones (`prelimsProjection` ↔ `psychProjection` ↔ `scoringEngine` → one shared helper); `buildCutlineTag`; `buildScorerRosterLookup`; `buildPrelimsDeltaTimeline`; `buildFastSwapContext`; `rankAddOnly` + `dropAdd`/`exactSwaps` clone; `validateRaceTags`; `swimEditor` clone | Golden snapshots for projections, cut tags and arbitrage over real data |
| H9 | whole repo | Re-measure. Report before/after counts. Add `complexity` as a lint **warning** (not error) at the new ceiling, so it cannot creep back | Lint stays at exit 0 |

## 4. Docs and vault

- Each item: a line in `docs/reference/CODE_HEALTH_2026-09-25_STATE.json`
  with before/after complexity for every function touched.
- No CHANGELOG entries (no user-visible change) unless an item finds and
  fixes a real bug, which gets its own commit and a CHANGELOG `Fixed` line.
- A bug found during a refactor is **reported, not fixed inside the
  refactor**. Refactor and fix never share a commit.
- Vault: `02-Invariants-and-Gotchas.md` gets any new gotcha; the session
  note gets the before/after table at H9.
