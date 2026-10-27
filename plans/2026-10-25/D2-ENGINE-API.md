# D2: `packages/engine` public API and extraction plan

Status: spec, 2026-10-25. Author: Claude architect (Opus, read-only), written
into the repo by the lead. Builds with D3 (`D3-STORAGE-AND-BUILD.md`); D3's
records wrap these payload types.

Evidence: [ran] = a command was run on tree 2f7c501d. [read] = code read there.
**Base the extraction on the reorg commit** (`03-REPO-REORG.md` rule 4) and
rerun the import scan there before Step A. Graph numbers below come from
`packages/core/src` as of 2f7c501d. Test and script paths were updated after
the reorg commits (d9f5c894 and its review fix-up); line numbers come from 2f7c501d and may have
shifted, so find each line by its content.

Section 6 lists the open questions this spec raised. Section 7 lists findings
about the existing code.

## 0. Decisions

| # | Decision |
| --- | --- |
| 0.1 | **Mirror move.** Each moved file keeps its relative path under `packages/engine/src` (`lib/`, `data/`, `types.ts`, `constants.ts`, `cutlines.ts`) with content unchanged. `git diff -M` must show R100. Reorganizing into `rules/`, `sourcing/`, `planner/` happens later, never in a move commit. |
| 0.2 | Every moved `.ts` path in core becomes a two-line shim. Core files that stay are not edited; they import the shims. |
| 0.3 | Two move steps: A (leaves), then B (everything else). A dependency cycle forces this (section 1). |
| 0.4 | The new public API lives in new folders (`model/`, `rules/`, `sourcing/`, `planner/`), exported from `src/index.ts`. Moved legacy modules are reachable only through subpaths (`@omniswim/engine/lib/*`), used only by core shims and the engine itself. `apps/extension` imports only the `@omniswim/engine` root. |
| 0.5 | The legacy scorer keeps its `999` sentinel, its `?? 999` fallbacks and its NSISC lock unchanged. The new API reaches it only through `toLegacyScoringSettings`. A fixed-point test proves `mergeScoringSettings` changes nothing in the bridge output. |
| 0.6 | New API code is deterministic: no `Date.now`, `Math.random`, `uuid` or `new Date()`. IDs and instants are inputs. Moved legacy code keeps the uses it has. |
| 0.7 | A time is integer hundredths plus the verbatim text. A missing time is `null`, never `0`. |
| 0.8 | Preset payloads hold rule values only. Id, name, rev and `derivedFrom` belong to D3 records. Built-ins are code, addressed by `PresetRef {kind:'builtin', id, version}`, never seeded into storage. |

## 1. Module classification

Method [ran]: scan every static import (value and `import type` edges) and
every global use, then spread impurity along value edges. Confirmed by
type-checking the 77 move-set `.ts` files with `lib: ["ES2022"]` and
`types: []`: no DOM or Node errors (only stale zod typings, F10).

**Impure (stay in core).** No other file is impure.

| File | Reason |
| --- | --- |
| `api/auth.ts`, `api/snapshots.ts`, `api/workspaces.ts` | `fetch` |
| `lib/scoringPresets.ts` | `fetch` (:86, :111, :128, :141, :151). The name suggests pure; it is not. |
| `lib/athleteJumpSignal.ts` | `window`, `sessionStorage` |
| `lib/crossCourseArbitrageClient.ts`, `lib/optimizeClient.ts`, `lib/scenarioDiffClient.ts` | `new Worker`, `window`, `postMessage` |
| `lib/useThemeColors.ts` | `react`, `document` |
| `lib/useWorkspaceScoring.ts` | `react`, `Worker`, `setTimeout` |
| `preferences/SuitePreferencesProvider.tsx` | `react`, `localStorage` |
| `store/SuiteWorkspaceProvider.tsx` | `react`, `@tanstack/react-query`, `fetch`, `localStorage` |
| `workers/scoringWorker.ts` | worker `self`, `postMessage` (:130) |
| `index.ts` | only through `index.ts → preferences/SuitePreferencesProvider.tsx` (React) |

No pure-looking `lib` module reaches an impure file through a value import.

**Pure but legacy-only (stay in core, unedited)**, outside every engine root's
closure: `api/saveSequence.ts`, `lib/csvImport.ts`, `lib/historyImportRoster.ts`,
`lib/meetReconciliation.ts`, `lib/psychParseQuality.ts`, `lib/scoringTheory.ts`,
`lib/swimCloudReplace.ts`, `lib/swimmerSoftRemove.ts`, `lib/workingCopyChanges.ts`,
`lib/workspaceNaming.ts`, `preferences/types.ts`, `schemas/workspace.ts`.

**Pure, moving to the engine (79 files: 77 `.ts`, 2 `.json`)**: the closure of
the roots `scoringEngine`, `calculatePoints`, `swimmerEntryLimits`,
`scorerRoster`, `scoringDefaults`, `scyConversion`, `altitude`, `cutlineTags`,
`cutlineUtils`, `relayBuilder`, `relayLegCredits`, `rosterOptimizer`,
`crossCourseArbitrage`, `eventStrength`, `scenarioDiff`, `reportBuilder`,
`entryExport`, `scoringPlaceTables`, `optimizeJob`, `scoredProgramBoundary`,
`eventCatalog`.

- Root: `types.ts`, `constants.ts`, `cutlines.ts`, `team_colors.json`.
  `cutlines.ts` imports `../../../data/cutlines/*.json`, which stays at the same
  depth after the move.
- `data/`: `relayPrograms.ts`, `teamAliases.ts`, `teamAbbreviations.json`, `teamDivisions.ts`.
- `lib/` (59): `altitude`, `athleteAliases`, `athleteHistory`, `bestTimeEligibility`,
  `calculatePoints`, `catalogScoringInputs`, `courseEvents`, `crossCourseArbitrage`,
  `cutlineEventNames`, `cutlineTags`, `cutlineUtils`, `entryExport`, `eventCatalog`,
  `eventIdentity`, `eventLabels`, `eventStrength`, `indexedAccess`,
  `individualScoring`, `meetPool`, `meetSource`, `ncaaScoringRules`, `optimizeJob`,
  `ownTeam`, `prelimsProjection`, `programSwim`, `psychProjection`, `relayBuilder`,
  `relayLegCredits`, `relayLegHistoryCandidates`, `relayLegMatching`,
  `relayScoring`, `relaySimulation`, `relaySplits`, `reportBuilder`,
  `rosterArbitrage`, `rosterCatalog`, `rosterLineupAudit`, `rosterOptimizer`,
  `scenarioDiff`, `scoredProgramBoundary`, `scorerRoster`,
  `scoringBundleAggregation`, `scoringDefaults`, `scoringEngine`,
  `scoringPlaceTables`, `scoringRules`, `scyConversion`, `seasonAnalytics`,
  `swimCloudMultiProfile`, `swimEditor`, `swimmerEntryLimits`, `swimmerNames`,
  `teamColorLookup`, `teamColorStyles`, `teamScoreMatching`,
  `theoreticalMeetLabel`, `timeFormat`, `utils`, `whatIfProjection`.
- `lib/arbitrage/`: `crossCourseTable`, `dropAdd`, `exactSwaps`, `relayLegSwaps`, `shared`.
- `lib/raceAnalysis/`: `course`, `index`, `metrics`, `reference`, `segment`,
  `tagStateMachine`, `types`.

Three out-of-scope groups move anyway because of import edges. Do not cut
these edges during the move: `raceAnalysis/**` (`types.ts` type-imports
`lib/raceAnalysis/index.ts`); the team-color files (`utils.ts` re-exports
them); `swimEditor` (`athleteAliases` type-imports it).

**Cycles [ran].** One 14-file cycle over value edges: `athleteAliases`,
`calculatePoints`, `catalogScoringInputs`, `cutlineTags`, `cutlineUtils`,
`individualScoring`, `meetPool`, `relayLegMatching`, `relayScoring`,
`relaySimulation`, `relaySplits`, `rosterCatalog`, `scorerRoster`, `utils`.
With type edges, `types.ts` joins it (`types → utils` type, `utils → types`
value). A second cycle: `{athleteHistory, swimCloudMultiProfile}`. Every root
reaches the big cycle, so it moves in one step.

**Pure but not deterministic** (allowed in moved code, banned in new code):
`rosterCatalog.ts:123,174,310`, `athleteAliases.ts:242,247,302,306,2007,2226`,
`athleteHistory.ts:1505`, `entryExport.ts:145`, `reportBuilder.ts:10`,
`whatIfProjection.ts:664`, `swimEditor.ts:268`.

## 2. Extraction

### 2.1 Package and gates

**`packages/engine/package.json`**: `name` `@omniswim/engine`, `private`,
`type: module`. `exports`: `"."` → `./src/index.ts`, `"./types"`,
`"./constants"`, `"./cutlines"`, `"./lib/*"` → `./src/lib/*`, `"./data/*"` →
`./src/data/*`, `"./rules/legacyBridge"`. `dependencies`: `zod ^4.6.7` and
`uuid` (the range `apps/shell` declares). No `react`, no peers, no
`@omniswim/*`. `scripts.lint`: `tsc --noEmit -p tsconfig.json`.

**`packages/engine/tsconfig.json`**: extend the base with `lib: ["ES2022"]`,
`types: []`, `include: ["src/**/*"]`. Leaving DOM out of `lib` is the
compile-time purity gate.

**`tsconfig.base.json` paths**: `"@omniswim/engine": ["./packages/engine/src/index.ts"]`,
`"@omniswim/engine/*": ["./packages/engine/src/*"]`. Vitest reads these
through `scripts/lib/tsconfigAliases.ts`.

**`packages/core/package.json`**: add `"@omniswim/engine": "*"`, then
`npm install`. tsx resolves extensionless subpaths through `exports` [ran].

**`eslint.config.mjs`**
- `packages/engine/**`: `no-restricted-imports` for `react`, `react-dom`,
  `@tanstack/*`, `node:*`, `fs`, `path`, `playwright-core`, `@omniswim/*`;
  `no-restricted-globals` for `window`, `document`, `fetch`, `XMLHttpRequest`,
  `localStorage`, `sessionStorage`, `indexedDB`, `navigator`, `self`,
  `postMessage`, `Worker`, `chrome`, `setTimeout`, `setInterval`.
- `apps/extension/**`: ban `@omniswim/engine/*` subpaths and `@omniswim/core`.

### 2.2 Shim

Each moved `packages/core/src/<p>.ts` becomes exactly:

```ts
// Moved to packages/engine (D2). Edit packages/engine/src/<p>.ts.
export * from '@omniswim/engine/<p>';
```

Safe [read]: no moved module has a default export, `export =` or a
`const enum`. `Gender` and `ClassYear` are regular enums. `export *`
re-exports types, enums and classes as the same binding. JSON files cannot be
shims; both move with their importers, and the two path readers are
repointed in Step A.

### 2.3 Steps

**Step 0: baseline** (orchestrator, at the reorg commits, in a checkout with
the full local data). The main clone has no `data/meets.json` and only part of
the captures. On 2026-10-25 the full set lived in the oyster worktree. Seed a
fresh worktree from it: `data/meets.json`, `data/swimcloud-captures/`,
`data/local-rosters/`, `data/relay-programs/sources/*.pdf` and `*.txt`, and
`data/training/` into `legacy/data/training/`. Run with `SKIP_BUDGET_ENV=local`.
Expected: vitest 4932 passed / 25 skipped (active + legacy), scripts 89 / 1,
both skip budgets green.
1. `npm ci` (F10).
2. `npm run lint`, `npm test`, `npx vitest run`. Record pass and skip counts per
   file in the state file.
3. Run the real-data scripts: `test_arbitrage_never_loses`,
   `test_athlete_history`, `test_chart_data`, `test_cross_course_arbitrage`,
   `test_cutline_tags`, `test_cutlines`, `test_data_dir_guard`,
   `test_dq_scoring`, `test_entry_limits`, `test_entry_limits_time_trials`,
   `test_nsisc_team_totals`, `test_optimizer_never_loses`,
   `test_projection_roster_gates`, `test_recruit_placement_grid`,
   `test_relay_overrides`, `test_relay_scoring`, `test_relay_splits`,
   `test_relay_swaps`, `test_roster_identity_match`, `test_roster_optimizer`.
   Refresh the list with `grep -l "meets\.json\|omniswim\.db"` at the reorg
   commit. Record PASS or SKIP per script. **A skip is "not run", never a pass.**
4. `npx tsx tests/coreReviewGoldenHarness.ts` rewrites
   `docs/reference/golden-after-F1.json`; `git diff --exit-code` it. If it
   differs at baseline, stop: local data has drifted.
5. Add `tests/engineExtractionFingerprint.test.ts` (E1) and commit its hashes.

**Step A: leaves (17 files).** `lib/indexedAccess.ts`, `lib/cutlineEventNames.ts`,
`lib/eventCatalog.ts`, `lib/teamColorLookup.ts`, `lib/timeFormat.ts`,
`lib/eventLabels.ts`, `lib/ncaaScoringRules.ts`,
`lib/raceAnalysis/{course,index,metrics,reference,segment,tagStateMachine,types}.ts`,
`data/relayPrograms.ts`, `data/teamAliases.ts`, `data/teamAbbreviations.json`.
None imports `types.ts` or anything outside the set [ran]. In the same step:
the package (2.1), the shims, the purity test (E3), and these repoints:
- `tests/raceAnalysisPurity.test.ts:30` → `packages/engine/src/lib/raceAnalysis`.
- `stryker.config.mjs` mutate path for `ncaaScoringRules.ts` → engine path.
- `legacy/scripts/test_team_abbreviation_parity.mjs:25` → engine JSON path.
- `legacy/backend/pdf_parser.py:42` → engine JSON path. It
  fails loudly on a missing file (:47).

Step A proves shims, aliases, tsx, Stryker and the purity gate before the
large move.

**Step B: everything else (62 files: 61 `.ts` + `team_colors.json`)**, including
the cycle and `types.ts`, in one diff. Repoints in the same step:
- `legacy/tests/altitudeAdjustment.test.ts:516`: allowlist →
  `packages/engine/src/constants.ts` and `packages/engine/src/lib/altitude.ts`
  (fails loudly without it).
- `scripts/test_cutlines.mjs:687` → engine `cutlines.ts`; `:694` walks both
  `packages/engine/src` and `packages/core/src`.
- `scripts/test_cutline_tags.mjs:1193` → engine `lib/cutlineTags.ts` and
  `data/teamDivisions.ts`.
- `legacy/tests/theoreticalMeetShellNits.test.ts:111` → engine `lib/theoreticalMeetLabel.ts`.
- `legacy/tests/relayLegCredits.test.ts:93` → engine `types.ts` (works through the
  shim already; repoint for clarity).
- The other 8 `stryker.config.mjs` mutate paths → engine paths.
- `legacy/tests/optimizeStepOwnership.test.ts:16,32` (legacy after the reorg): mock
  `@omniswim/engine/lib/rosterOptimizer`. After the move the worker path
  (`scoringWorker → optimizeJob → rosterOptimizer`) runs inside the engine,
  so a spy on the core path sees no call.

**Every repointed source scan asserts that the file it reads is over 1 KB and
contains a named export** (for example `export function buildCutlineTag`), so
a shim can never satisfy the scan.

**Step C: new API.** New files under `packages/engine/src/{model,rules,sourcing,planner}`
and `index.ts`. No moved file is edited.

Order: reorg commit → A → B → C. Each step is its own diff and passes 2.5
before the next. The executor runs no git commands.

### 2.4 Scope

**May touch:** `packages/engine/**` (new); shim files at moved paths in
`packages/core/src`; `packages/core/package.json`, `tsconfig.base.json`,
`eslint.config.mjs`, `stryker.config.mjs`; root `package.json` only if
workspace globs need it; the repoint lines in 2.3 and `pdf_parser.py:42`; the
new tests named here.

**Must not touch:** moved-file contents, core files that stay, legacy package
source, `data/**`, golden fixtures, E1 hashes after Step 0, `tests/mutation/**`.

### 2.5 Acceptance

**E1. Fingerprint.** `tests/engineExtractionFingerprint.test.ts`, written in
Step 0 and never edited after. It imports through core paths (so after the
move it runs through the shims) and uses committed fixtures only (no
`data/meets.json`). Each case: JSON-stringify with sorted keys, drop `id`,
`createdAt`, `updatedAt`, `importedAt`, `generated`, sha256, compare with the
committed hash; run each case twice and assert equal hashes (catches clock and
random leaks). Cases:
- `buildScoringBundle` and `buildScoringSnapshot` on every workspace in
  `tests/fixtures/theoretical-meet/` and `tests/fixtures/optimize-undo-workspace.json`,
  both genders, `applyWhatIf` on and off.
- `calculatePoints` on `tests/fixtures/nsisc-2026-*.json` and
  `tests/test_nsisc_output.json`, under `NSISC_PRESET_SETTINGS` and
  `GENERIC_TOP16_SETTINGS`.
- `optimizeRosterForTeam`, `optimizeEventLineupForTeam` on `optimize-undo-workspace.json`.
- `mergeScoringSettings` for each `BUILT_IN_SCORING_PRESETS` entry × conference
  ∈ {undefined, `'NSISC'`}.
- `buildCutlineTag` for each published row × {standard − 0.01, standard, standard + 0.01}.
- `scyConversionOutcome` for each `CONVERSION_FACTORS` event × {SCY, SCM, LCM}
  × division ∈ {D1, D2, D3, NAIA, null}.
- `ncaaAltitudeAdjustment` over the whole table grid.

**E2. Rename proof.** `git diff -M --stat` shows R100 for every moved file;
each shim's diff is its two lines only.

**E3. Purity.** `npm run lint -w @omniswim/engine` passes with
`lib: ["ES2022"]`, `types: []`. `tests/enginePurity.test.ts` walks
`packages/engine/src`, fails on any import or global banned in 2.1, and
asserts it scanned at least 79 files.

**E4. One module instance.** `tests/engineSingleInstance.test.ts`:
`mergeScoringSettings` and `calculatePoints` are `===` through core and engine
paths; `instanceof` holds across both paths for
`HostPublishedTableRequiredError` (`scoringDefaults.ts:167`),
`RelayDistanceUnreadableError` (`relaySplits.ts:59`) and
`EventNotSwumInCourseError`; a value set with `setUserConferencePresetBindings`
through core reads back through the engine's `conferencePresetBindings`
(reset after).

**E5. Canaries** (orchestrator, after Step B; revert each).

| Plant | Guard that must fail |
| --- | --- |
| `'1:23.45'` in engine `cutlines.ts` | `test_cutlines.mjs` |
| `'1:23.45'` in engine `cutlineTags.ts` and `teamDivisions.ts` | `test_cutline_tags.mjs` |
| a read of `NCAA_ALTITUDE_ADJUSTMENT_TABLE` in engine `lib/utils.ts` | the altitude test |
| `import 'react'` in engine `lib/raceAnalysis/course.ts` | `enginePurity`, `raceAnalysisPurity`, engine lint |

A guard that does not fail is vacuous; fix it before accepting the step.

**E6. Mutation.** `npm run test:mutation -- --mutate packages/engine/src/lib/relayScoring.ts`
gives exactly 161 mutants: 145 killed, 0 timeout, 10 survived, 6 no coverage
(`MUTATION_RESULTS_2026-10-14.md`). Near zero mutants means it is mutating a shim.

**E7. Counts.** Lint, `npm test`, vitest give the Step 0 per-file pass and skip
counts plus the new tests. The real-data scripts show the same PASS or SKIP
per script. `golden-after-F1.json` is byte-identical after rerunning the
harness. `theoreticalMeetGolden.test.ts` skips 5 tests in the main clone (real
captures absent, :411): record it, it is not a regression.

## 3. Public API

Phase tags: **P1** ships in Step C; later phases implement functions against
these types.

### 3.1 Primitives (`model/primitives.ts`), P1

```ts
export type Gender = 'Men' | 'Women';                 // same strings as the core enum, types.ts:10
export type Course = 'SCY' | 'SCM' | 'LCM';           // HistoricalSwim.timeType, types.ts:705
export type { NcaaDivision } from '../types';          // types.ts:628
export type IsoDate = string;                          // YYYY-MM-DD
export type IsoTime = string;                          // Date#toISOString()
export type Hundredths = number;                       // integer >= 0
export type TimeValue = { readonly text: string; readonly hundredths: Hundredths };
export type EventKey = string;      // canonical name via normalizeEventForCutline (invariants 3, 13, 18)
export type SwimmerId = string;     // SwimCloud id as a string; D3 brands it at storage
export type TeamId = string;
export function parseTimeText(text: string): TimeValue | null;   // null for NT, DQ, blank; never 0
export function formatHundredths(h: Hundredths): string;
```

Test: `parseTimeText(formatHundredths(h))!.hundredths === h` for every `h` from 0 to 360000.

### 3.2 Provenance (`model/provenance.ts`), P1

```ts
export type SourceRef = {
  readonly sourceId: string;   // id inside a data/**/sources/manifest.json
  readonly manifest: string;   // e.g. 'data/scoring_rules/sources/manifest.json'
  readonly sha256: string; readonly url: string;
  readonly publisher: string;  // 'NCAA', 'NAIA', 'SwimCloud meet simulator'
  readonly locator?: string;   // 'Rule 7-6-4', 'p. 2'
};
export type Provenance =
  | { readonly kind: 'published'; readonly source: SourceRef }
  | { readonly kind: 'user-stated'; readonly statedOn: IsoDate; readonly wording: string;
      readonly where: string;        // path:line of the record
      readonly verbatim: boolean }   // false: a paraphrase (README decision rows)
  | { readonly kind: 'user-edited'; readonly editedAt: IsoTime; readonly previous: Provenance | null }
  | { readonly kind: 'engine-neutral'; readonly reason: string }   // P2: a neutral value no source states (8.16)
  | { readonly kind: 'tool-derived';             // R58, 2026-10-26: inferred from a tool's outputs, never published
      readonly tool: { readonly name: string; readonly url: string };
      readonly archive: { readonly path: string; readonly sha256: string };   // sha256 of the file at path
      readonly capturedOn: IsoDate;
      readonly basis: 'inferred-from-tool-outputs' };
export type Setting<T> =
  | { readonly state: 'set'; readonly value: T; readonly provenance: Provenance }
  | { readonly state: 'pending'; readonly question: string; readonly blocks: readonly string[] };
```

Invariants (each has a test): a parser accepts these five kinds and rejects any
other `kind`, including `'legacy'`; `tool-derived` is never `published` (it has
no `source`, and nothing may count or render it as published); editing gives `user-edited` with `previous`, and provenance is never
upgraded; a `pending` setting has no value field, so no code can read a guess;
a SwimCloud observation (for example the NSISC table from recon) becomes
`published` only after the capture is archived under `data/` with a manifest
entry.

### 3.3 Cap (`rules/cap.ts`), P1

```ts
export type Cap = number | 'unlimited';
export class RulePresetError extends Error {
  readonly path: string;   // 'entries.maxTotalPerSwimmer'
  readonly code: 'missing' | 'invalid' | 'legacy_sentinel' | 'pending' | 'legacy_provenance';
}
export function parseCap(raw: unknown, path: string): Cap;
export function capAllows(cap: Cap, count: number): boolean;   // count <= cap
```

`parseCap`: `'unlimited'` → `'unlimited'`; an integer 0 to 998 → that number;
`undefined` → `missing`; `null`, `NaN`, non-integer, negative or any other
string → `invalid`; an integer ≥ 999 → `legacy_sentinel` (the legacy code reads
any cap ≥ 999 as unlimited, F4, so a user cap of 1000 would silently mean
unlimited). `0` is a valid cap (`scoringDefaults.ts:267`). **Named bug:**
`if (!cap)` treats `0` as missing.

### 3.4 RulePreset (`rules/rulePreset.ts`), P1

Payload only; id, name, rev and `derivedFrom` live in D3's `RulePresetRecord`.

```ts
export type DiverWeight = { readonly numerator: number; readonly denominator: number };  // integers, 0 < n <= d
export type RelayPointRule =
  | { readonly kind: 'table'; readonly points: readonly number[] }              // relayPoints types.ts:368
  | { readonly kind: 'multiple-of-individual'; readonly multiplier: number };   // relayMultiplier types.ts:264
export type DivingPointRule =
  | { readonly kind: 'same-as-individual' }
  | { readonly kind: 'table'; readonly points: readonly number[] };             // types.ts:386
export type PerEventScorerCap =
  | { readonly cap: 'unlimited' }
  | { readonly cap: number; readonly overCap: 'holds-place' | 'removed-from-consideration' }; // types.ts:404, 448
export type DivingPerEventScorerCap =
  | { readonly kind: 'same-as-swimming' }
  | ({ readonly kind: 'own' } & PerEventScorerCap);                              // types.ts:421
export type { ScorerAutoRules } from '../types';                                 // types.ts:473
// R40: a swim in any heat of a split timed final marks a scorer. Legacy has no
// such field (rowSuggestsScorer marks no scorer for an individual FIN swim), so
// the bridge maps legacy to false.
export type EngineScorerAutoRules = ScorerAutoRules & { readonly splitTimedFinalMarksScorer: boolean };
export type PlaceTreatment = 'holds-place' | 'removed-from-consideration';      // same terms as overCap
export type CFinalRule = { readonly kind: 'none' } | { readonly kind: 'non-scorers'; readonly size: number };

export type TieRule = 'split' | 'ordered';   // P2, 8.16: split = tied entries share a rank and the points; ordered = own place, tie by entry order
export type RelayOverCapRule = 'holds-place' | 'exhibition';   // P3, README R67; section 9.6
// RulePresetV1 is this interface with payloadVersion 1, no `ties` and no `relayOverCap`. RulePresetV2 adds
// `ties` (payload version 2). RulePreset below is payload version 3: it adds `scorers.relayOverCap`.
export interface RulePreset {
  readonly payloadVersion: 3;
  readonly scoring: {
    readonly ties: Setting<TieRule>;                          // P2
    readonly individualPoints: Setting<readonly number[]>;    // scoringPoints :263; places = length
    readonly relayPoints: Setting<RelayPointRule>;
    readonly divingPoints: Setting<DivingPointRule>;
    readonly halfRateRelaySwimmer: Setting<boolean>;          // :265
    readonly aFinalBracketSize: Setting<number>;              // :270
    readonly nonScorerPlacement: Setting<PlaceTreatment>;     // R41; individuals and relays
    readonly abFinalsScorersOnly: Setting<boolean>;           // R43
    readonly cFinal: Setting<CFinalRule>;                     // R44
  };
  readonly scorers: {
    readonly eligibility: Setting<'roster' | 'points_pool'>;  // scorerEligibilityMode :302
    readonly autoRules: Setting<EngineScorerAutoRules | null>; // :309
    readonly scoringTeamSize: Setting<Cap>;                   // maxIndividualScorersPerTeam :266
    readonly scoringTeamScope: Setting<'meet' | 'event'>;     // scorerCapScope :291
    readonly diverWeight: Setting<DiverWeight>;               // diverScorerWeight :293
    readonly perEventScorerCap: Setting<PerEventScorerCap>;
    readonly divingPerEventScorerCap: Setting<DivingPerEventScorerCap>;
    readonly scoringRelaysPerTeamPerEvent: Setting<Cap>;      // maxRelaysScoringPerTeam :268
    readonly relayEligibleFromScorerPool: Setting<boolean>;   // :297; 'points_pool' only
    readonly relayLegsMustBeScorers: Setting<boolean>;        // R37; 'roster' only
    readonly relayOverCap: Setting<RelayOverCapRule>;         // P3, R67: a relay over scoringRelaysPerTeamPerEvent
  };
  readonly entries: {
    readonly maxIndividualPerSwimmer: Setting<Cap>;           // :311
    readonly maxRelayPerSwimmer: Setting<Cap>;                // :313
    readonly maxTotalPerSwimmer: Setting<Cap>;                // :315
    readonly timeTrialsCount: Setting<boolean>;               // entryCapCountsTimeTrials :322
    readonly exhibitionCounts: Setting<boolean>;              // entryCapCountsExhibition :329
    readonly relayLegsAllowTimeTrials: Setting<boolean>;      // :338
  };
}
export type CompleteRulePreset = RulePreset & { readonly __complete: true };
export function parseRulePreset(json: unknown): RulePreset;          // storage and import boundary
export function pendingPaths(p: RulePreset): string[];               // dotted paths, sorted
export function requireComplete(p: RulePreset): CompleteRulePreset;  // throws 'pending', naming every path
export function editSetting<T>(s: Setting<T>, value: T, at: IsoTime): Setting<T>;   // gives user-edited
```

`relayEligibleFromScorerPool` applies only under `eligibility: 'points_pool'`;
the legacy code ignores it under `'roster'` (`calculatePoints.ts:410`,
`relayScoring.ts:190`). `relayLegsMustBeScorers` is its roster-mode
counterpart. `pendingPaths` and `requireComplete` skip the field that does not
apply to the preset's `eligibility`.

Left out on purpose: `diverEventPattern` (the model's event `kind` says which
events are diving); `unscoredRounds` and `scoredEventNumberMax` (meet-scoped;
time trials come from swim flags); `usePdfPlacePoints`, `meetFormat`, `ownTeam`
(not rules).

`parseRulePreset` rejects: a missing key, an unknown key or `null`; any
provenance `kind` outside the three (including `'legacy'`); a numeric cap ≥ 999;
`eligibility: 'roster'` with `autoRules: null` (the legacy merge would silently
fill `DEFAULT_SCORER_AUTO_RULES`, `scoringDefaults.ts:775`); a `DiverWeight`
with non-integers or a zero denominator; a negative or non-finite point.

Migrations: a later `payloadVersion` that adds a field sets it to `pending`,
never to a default. Legacy `ScoringSettings` are not imported in v1 (the
extension starts with an empty store, D3 0.8).

### 3.5 Legacy bridge (`rules/legacyBridge.ts`), P1, at `@omniswim/engine/rules/legacyBridge`

```ts
export const LEGACY_UNLIMITED = 999;
export function toLegacyScoringSettings(p: CompleteRulePreset): ScoringSettings;
```

| RulePreset | ScoringSettings |
| --- | --- |
| `'unlimited'` in `scoringTeamSize`, `scoringRelaysPerTeamPerEvent` or any `entries.max*` | `999` |
| `perEventScorerCap {cap:'unlimited'}` | `maxIndividualScorersPerTeamPerEvent` and `overCapPlaceBehavior` both absent |
| `perEventScorerCap {cap:n, overCap}` | `maxIndividualScorersPerTeamPerEvent: n`, `overCapPlaceBehavior: overCap` |
| `divingPerEventScorerCap` `same-as-swimming` | `divingMaxScorersPerTeamPerEvent` absent |
| `divingPerEventScorerCap` `own` with `'unlimited'` | `999` |
| `relayPoints` table | `relayPoints` = the table and `relayMultiplier: 2` (inert while `relayPoints` is set, types.ts:352; matches `NCAA_PRESET_BASE`, `scoringDefaults.ts:215`) |
| `relayPoints` multiple | `relayMultiplier: m`, no `relayPoints` |
| `divingPoints` `same-as-individual` | absent |
| `diverWeight n/d` | `n / d` (1/3 gives the same double as `scoringDefaults.ts:45`) |
| always | `usePdfPlacePoints: false`; explicit `scorerEligibilityMode`; `diverEventPattern: ['DIVING','DIVE']`; no `meetFormat`, no `ownTeam` |

**Fixed-point invariant** (`tests/engineLegacyBridge.test.ts`): over both
built-ins (with test-only completions) plus 200 generated presets covering
every union branch and the caps 0, 1, 998, `'unlimited'`,
`mergeScoringSettings(toLegacyScoringSettings(P))` deep-equals
`toLegacyScoringSettings(P)`. This catches the NSISC lock
(`scoringDefaults.ts:780-789`), the roster flip (`:634-641`, `:769-772`), the
PDF `'auto'` sniff (`:761`) and any default fill (`:760`).

**The façade never passes `conference`**; `workspace.conference` stays
undefined. Test: a complete NSISC-shaped preset with `maxTotalPerSwimmer: 8`
lets a swimmer hold 8 entries (the legacy lock would make it 7).

### 3.6 MeetModel (`model/meet.ts`): types P1, adapter P2

```ts
export type DivisionRef =
  | { readonly state: 'known'; readonly division: NcaaDivision; readonly season: string }
  | { readonly state: 'unknown';
      readonly reason: 'unmapped_team' | 'program_discontinued' | 'gender_not_sponsored' | 'sponsorship_unaudited' };
export interface MeetTeam { readonly teamId: TeamId; readonly division: DivisionRef }
export type RosterMembership = 'member' | 'not_member' | 'unknown';            // F1.1a
export interface MeetSwimmer { readonly swimmerId: SwimmerId; readonly teamId: TeamId; readonly gender: Gender;
  readonly classYear: 'FR' | 'SO' | 'JR' | 'SR' | 'GR' | null; readonly roster: RosterMembership }
export interface MeetEvent { readonly eventKey: EventKey; readonly gender: Gender;
  readonly kind: 'individual' | 'relay' | 'diving';
  readonly distanceYards: number | null;          // null for diving; relays read from the token (invariant 18)
  readonly relayKind: 'medley' | 'freestyle' | null }
export type SwimFlags = {                         // HistoricalSwim, types.ts:737-815; absent = not stated
  readonly extractedSplit?: true; readonly userInputted?: true; readonly altitudeAdjustedBySource?: true;
  readonly exhibition?: true; readonly timeTrial?: true; readonly programUnconfirmed?: true };
export type ConversionBasis =
  | { readonly method: 'swimcloud'; readonly displayedText: string }                     // R10 first choice
  | { readonly method: 'ncaa_scm_table'; readonly tableId: NcaaScmConversionTableId; readonly factor: number;
      readonly division: NcaaDivision | null; readonly reason: ScmConversionTableReason } // scyConversion.ts:313
  | LcmToScyBasis                                                                        // R58, "est.", 3.13
  | { readonly method: 'table_d'; readonly multiplierPermille: number;
      readonly turnAdjustmentHundredths: number; readonly provenance: Provenance };     // RETIRED (R58): nothing produces it; kept so saved data parses
export type ScyStatement =
  | { readonly kind: 'recorded-scy' }
  | { readonly kind: 'converted'; readonly hundredths: Hundredths; readonly basis: ConversionBasis;
      readonly estimated: true }                 // every converted time is an estimate (R58, R60)
  | { readonly kind: 'not-convertible';
      readonly reason: 'event_not_swum_in_course' | 'no_conversion_available' | 'conversions_excluded' };
export type SwimOrigin =
  | { readonly kind: 'simulator'; readonly snapshotId: string }
  | { readonly kind: 'history-fetch'; readonly fetchedAt: IsoTime; readonly url: string };
export interface MeetSwim { readonly swimId: string; readonly swimmerId: SwimmerId; readonly eventKey: EventKey;
  readonly recordedCourse: Course; readonly recordedTime: TimeValue | null;   // null = NT; a dive holds its SCORE here (hundredths of a point), 8.11
  readonly date: IsoDate | null; readonly seasonId: string | null;
  readonly flags: SwimFlags; readonly scy: ScyStatement; readonly origin: SwimOrigin }
export interface RelaySplit {                     // RelayLegCredit, types.ts:659
  readonly splitId: string; readonly swimmerId: SwimmerId; readonly relayEventKey: EventKey | null;  // null: the source names the leg only, 8.11
  readonly legPosition: 1 | 2 | 3 | 4 | null;    // null = not stated: stored, never used (types.ts:657)
  readonly start: 'flat' | 'flying' | 'unknown';  // leg 1 flat, legs 2-4 flying (relayLegCredits.ts:160-197)
  readonly legEventKey: EventKey | null; readonly split: TimeValue; readonly course: Course | null;
  readonly date: IsoDate | null; readonly origin: SwimOrigin }
export type DateWindow =
  | { readonly kind: 'seasons'; readonly seasonIds: readonly string[] }
  | { readonly kind: 'dates'; readonly from: IsoDate; readonly to: IsoDate };
export interface MeetDisplay { readonly swimmers: Readonly<Record<SwimmerId, { readonly name: string }>>;
  readonly teams: Readonly<Record<TeamId, { readonly name: string }>> }
export interface MeetModel {
  readonly payloadVersion: 1; readonly meetKey: string;
  readonly teams: readonly MeetTeam[]; readonly swimmers: readonly MeetSwimmer[];
  readonly events: readonly MeetEvent[]; readonly swims: readonly MeetSwim[];
  readonly relaySplits: readonly RelaySplit[];
  readonly recordRange: DateWindow; readonly extendedWindow: boolean;   // F1.1 badge
  readonly observedScores: readonly { readonly teamId: TeamId; readonly points: number }[] | null;  // null = not read
  readonly display?: MeetDisplay;
}
export type MeetModelErrorCode = 'missing' | 'invalid' | 'duplicate' | 'unresolved' | 'gender_mismatch' | 'inconsistent';
export class MeetModelError extends Error { readonly path: string; readonly code: MeetModelErrorCode }
export function validateMeetModel(m: unknown): MeetModel;   // P2: returns the model, or throws MeetModelError
```

`validateMeetModel` checks: unique IDs; every reference resolves; an
individual swim's swimmer gender equals the event gender; a `converted`
statement never sits on a recorded SCY swim or a null time; a swim with
`altitudeAdjustedBySource` is never adjusted again (invariant 9).

P2 notes (built, `packages/engine/src/model/validate.ts`):
- It reads untrusted JSON and never repairs: a missing key, an unknown key,
  a `null` where a value belongs, or text that does not read back to its
  hundredths all throw, with the path in `MeetModelError.path`.
- A swim's event is never a relay (a relay is a lineup entry).
  `recorded-scy` sits on an SCY swim only.
- Invariant 9 is vacuous in this shape: `MeetSwim` has no altitude field, so
  nothing can be adjusted twice. The flag is checked as the literal `true`.
  A later field that carries an adjustment needs the check added.
- The text of a dive score is not read back as a time (8.11).

**The simulator adapter (P2) lives in `packages/swimcloud/src/browser`**, not in
the engine: it reads the page's shapes (`@omniswim/swimcloud/browser`).
`adaptSimulatorSnapshot(snapshot, {meetKey, snapshotId})` returns
`{kind: 'not_loaded', missing}` or `{kind: 'ready', adapted: {model, lineup,
preset, observedEntries, ignored}}`. The model passes `validateMeetModel`.
Teams get division `unknown/unmapped_team`, swimmers `classYear: null` and
`roster: 'member'`. The preset comes from the snapshot's own settings
(`simulatorRulePreset`): what the page states is tool-derived, and the settings it never reads are `engine-neutral` (8.16).

### 3.7 Lineup (`model/lineup.ts`), P1

```ts
export type IndividualEntry = { readonly kind: 'individual'; readonly teamId: TeamId; readonly swimmerId: SwimmerId;
  readonly eventKey: EventKey; readonly gender: Gender;
  readonly seedSwimId: string | null };   // null: engine picks the best rankable swim (invariant 8)
export type LegBasis =
  | { readonly kind: 'split'; readonly splitId: string }
  | { readonly kind: 'flat-start-swim'; readonly swimId: string }     // leg 1 only
  | { readonly kind: 'flyover-estimate'; readonly swimId: string }    // legs 2-4; flyover read at scoring time
  | { readonly kind: 'no-time' };
export type RelayLeg = { readonly swimmerId: SwimmerId; readonly basis: LegBasis };
export type RelayEntry = { readonly kind: 'relay'; readonly teamId: TeamId; readonly eventKey: EventKey;
  readonly gender: Gender; readonly letter: string;
  readonly legs: readonly [RelayLeg, RelayLeg, RelayLeg, RelayLeg] };
export type LineupEntry = IndividualEntry | RelayEntry;
export type ScorerRole = 'scorer' | 'non-scorer' | 'exhibition';   // D3 TagRecord.role; no tag = automatic
export type ScorerTag = { readonly teamId: TeamId; readonly swimmerId: SwimmerId;
  readonly role: ScorerRole };                                       // ScorerRosterOverride, types.ts:484
export interface LineupDisplay {
  readonly swimmers: Readonly<Record<SwimmerId, { readonly name: string }>>;
  readonly teams: Readonly<Record<TeamId, { readonly name: string }>>;
  readonly entryTimes: Readonly<Record<string, TimeValue>>;   // key: entryKey(entry)
}
export interface Lineup {
  readonly payloadVersion: 1; readonly meetKey: string;
  readonly entries: readonly LineupEntry[];
  readonly display?: LineupDisplay;   // all SwimCloud data in a lineup lives here
}
export function entryKey(e: LineupEntry): string;  // 'i|team|swimmer|event|gender' or 'r|team|event|gender|letter'
export function stripSwimCloudData(l: Lineup): Lineup;
```

Scorer tags are not inside `Lineup`; D3 stores them per meet and scoring takes
them as a separate argument. Preset refs and revs live in
`LineupRecord.builtUnder` (D3).

Invariants (each has a test):
- `'display' in stripSwimCloudData(l)` is `false`: the key is removed, never set
  to `undefined` (D3 5.3 rule 5).
- The engine never reads `display`: `scoreMeet` gives deep-equal `Results` for
  `l`, `stripSwimCloudData(l)`, and `l` with garbage in `display`.
- IDs, events and roles rebuild a lineup:
  `JSON.parse(JSON.stringify(stripSwimCloudData(l)))`, scored, equals `l`'s `Results`.
- Relay legality (invariant 19): four distinct swimmers of the relay's gender;
  `flat-start-swim` on leg 1 only; `flyover-estimate` on legs 2-4 only.

### 3.8 Results and scoring (`model/results.ts`), P2

```ts
export type NotScoredReason = 'non_scorer' | 'scoring_team_full' | 'event_scorer_cap' | 'relay_scorer_cap' | 'removed_over_event_cap'
  | 'exhibition' | 'outside_point_table' | 'no_time' | 'time_trial';
export interface ResultRow { readonly entryKey: string; readonly teamId: TeamId; readonly swimmerId: SwimmerId | null;
  readonly place: number | null; readonly points: number; readonly scored: boolean;
  readonly notScoredReason?: NotScoredReason }   // absent = not derived; never guessed
export type Violation =
  | { readonly kind: 'entry_cap'; readonly swimmerId: SwimmerId; readonly which: 'individual' | 'relay' | 'total';
      readonly count: number; readonly limit: number }
  | { readonly kind: 'session_load'; readonly swimmerId: SwimmerId; readonly session: SessionRef;
      readonly races: number; readonly limit: number }
  | { readonly kind: 'relay_leg'; readonly entryKey: string; readonly leg: 1 | 2 | 3 | 4;
      readonly reason: 'wrong_gender' | 'duplicate_swimmer' | 'event_mismatch' | 'basis_position' }   // basis_position: 8.12
  | { readonly kind: 'unscheduled_event'; readonly eventKey: EventKey; readonly gender: Gender }
  | { readonly kind: 'pending_setting'; readonly eventKey: EventKey; readonly gender: Gender;
      readonly setting: 'fastHeatSize' | 'smallFieldSession' | 'cFinal' };   // R35, R44
export interface Results {
  readonly payloadVersion: 1;
  readonly teams: readonly { readonly teamId: TeamId; readonly points: number; readonly rank: number }[]; // TeamScore types.ts:231
  readonly events: readonly { readonly eventKey: EventKey; readonly gender: Gender; readonly rows: readonly ResultRow[] }[];
  readonly violations: readonly Violation[];
  readonly rosterUnknown: readonly SwimmerId[];
  readonly display?: LineupDisplay;   // names and times, removable
}
export function scoreMeet(model: MeetModel, lineup: Lineup, tags: readonly ScorerTag[],
  rules: CompleteRulePreset, sourcing: ConversionSettings): Results;   // P2 reads nothing from `sourcing`; 8.12
export function stripResultsDisplay(r: Results): Results;
export type ScoreMeetErrorCode = 'meet_key_mismatch' | 'roster_mode_unsupported' | 'tags_need_roster_mode'
  | 'placement_unsupported' | 'name_collision' | 'unresolved_team' | 'unresolved_swimmer' | 'unresolved_event'
  | 'unresolved_swim' | 'unresolved_split' | 'team_mismatch' | 'gender_mismatch' | 'event_kind_mismatch'
  | 'roster_not_member' | 'duplicate_entry' | 'seed_mismatch' | 'leg_basis_unsupported' | 'leg_missing' | 'split_not_scy';
export class ScoreMeetError extends Error { readonly code: ScoreMeetErrorCode; readonly subject: string | null }
```

Rules:
- Points can be fractional (split ties, half-rate relay credit).
- `scoreMeet` calls the legacy scorer through `toLegacyScoringSettings`, with
  synthetic legacy names `sw:<swimmerId>` and `tm:<teamId>`. **Named bug:**
  display names as legacy keys. The legacy code keys scorers by name
  (`scorerRosterKey`, `scorerRoster.ts:66`), so two same-name swimmers on one
  team would merge.
- An entered swimmer whose membership is `not_member` is a validation error.
  One whose membership is `unknown` scores and is listed in `rosterUnknown`;
  the AutoBuilder (P6) never adds an `unknown` swimmer on its own.
- P2 parity: with a preset built from SwimCloud's settings, `teams[].points`
  equals `model.observedScores` exactly. **Result (2026-10-26): config A
  matches; B, C and D differ by 0.5 on two tied events. Cause and options:
  8.12.** The exit needed 3 of 4.
- P2 built (`packages/engine/src/model/results.ts`): ranking is standard
  competition ranking (equal hundredths share a rank; a dive ranks by score,
  highest first). Each row goes to the legacy `calculatePoints` as a
  one-gender call, round `'A Final'`, name `sw:<id>`, team `tm:<id>`.
  `scoreMeet` throws `name_collision` when two ids normalize to one key.
- `scoreMeet` throws (never scores around) for: `scorers.eligibility:
  'roster'`; any tag under `'points_pool'`; an over-cap rule of
  `'removed-from-consideration'`; a `flyover-estimate` leg; a split that is
  not SCY; a swimmer who is `not_member`. P3 and P5 lift the first three.
- `notScoredReason` is derived only for `no_time`, `outside_point_table`,
  `event_scorer_cap` and `relay_scorer_cap`. Other zero rows carry none.
- `entry_cap` violations count distinct events per swimmer. The row still scores.
- `teams` lists every model team, including one with no entry.
- Overlay data: `parityReport(adapted, results)` and `rescoreSimulator(snapshot,
  opts)` in `@omniswim/swimcloud/browser`.

### 3.9 Cut tags (`sourcing/cutTag.ts`), P4

```ts
export type { CutlineTier as CutTier } from '../cutlines';   // cutlines.ts:152, the source's own name
export type CutGap = { readonly tier: CutlineTier; readonly standard: TimeValue;
  readonly gapHundredths: number;      // > 0
  readonly gapBasisPoints: number;     // floor(gap * 10000 / standard)
  readonly source: CutlineSourceRef };
export type CutUnknownReason = 'division_unknown' | 'program_discontinued' | 'gender_not_sponsored'
  | 'sponsorship_unaudited' | 'no_table_for_division' | 'event_not_in_table' | 'no_time' | 'conversion_unavailable'
  | 'user_inputted' | 'extracted_split' | 'program_unconfirmed' | 'event_not_swum_in_course';
export type CutTag =
  | { readonly kind: 'achieved'; readonly tier: CutlineTier;
      readonly slot: 'A' | 'B' | null;          // legacySlotForTier, cutlines.ts:560
      readonly marginHundredths: number; readonly source: CutlineSourceRef;
      readonly nextTier: CutGap | null }         // a B swimmer's gap to A (R11); null at the strictest tier
  | { readonly kind: 'estimated-achieved'; /* AchievedFields, plus: */ readonly basis: ConversionBasis;
      readonly convertedHundredths: Hundredths }  // R61: a converted time cleared a standard; not a cut
  | { readonly kind: 'close'; readonly nearest: CutGap; readonly thresholdBasisPoints: number }
  | { readonly kind: 'none'; readonly nearest: CutGap | null }
  | { readonly kind: 'converted'; readonly indicative: CutlineIndicativeComparison | null }  // clears nothing, or a legacy-factor comparison; never a cut, never estimated-achieved
  | { readonly kind: 'not-applicable'; readonly reason: 'diving' }
  | { readonly kind: 'unknown'; readonly reason: CutUnknownReason; readonly detail: string };
export type CloseThreshold = { readonly basisPoints: number };   // 100 = 1.0%
export function closeThresholdFromPercent(pct: number): CloseThreshold;   // D3 cutCloseThresholdPct
export function cutTagForSwim(swim: MeetSwim, swimmer: MeetSwimmer, team: MeetTeam, t: CloseThreshold): CutTag;
export function cutTagFromLegacy(r: CutlineTagResult, t: CloseThreshold): CutTag;
```

- `closeThresholdFromPercent` throws unless `pct >= 0` and `pct * 100` is an
  integer to within 1e-9.
- A swim with `scy.kind === 'converted'` is judged as an SCY swim on its SCY event
  (the LCM 400 Freestyle against the 500 Freestyle): `estimated-achieved` when
  its converted time clears a standard, `converted` (`indicative: null`) when it
  clears none. It is never `achieved` (README R61, which replaces the earlier
  rule that an estimate never tags; F1.2, invariants 10 and 11). A converted
  time never goes through the legacy LCM factors (`constants.ts:11-29`, no
  source). A swim whose division publishes the swim's own course (an NAIA SCM
  swim) is judged there, as a real swim: `achieved`, never estimated.
- `cutTagFromLegacy` is an exhaustive `switch` over `CutlineTagState`
  (`cutlineTags.ts:149`) with a `never` default: `tagged` → `achieved`;
  `converted_estimate` → `converted` (the legacy comparison used the unsourced
  LCM factors, so it never earns an estimated tag); `not_applicable` →
  `not-applicable`;
  `no_cut` → `close` or `none`; every other state → `unknown` with the same
  reason name. A test lists every member of `CutlineTagState`.
- `close` is judged against `nextTier` on a `no_cut` result
  (`cutlineTags.ts:391`), the nearest unreached published tier. Close if and
  only if `gapHundredths * 10000 <= basisPoints * standardHundredths`, in
  integers; the boundary counts as close.
- Tier names are never renamed: D1 `Standard` stays `Standard` (slot A); D2
  `Provisional` keeps its name (slot B); D3 `Invited` has slot `null`.
- **Named bug:** a float ratio `gap / standard <= 0.01` [ran]. At 57.57 against
  57.00 the float gap is 0.5700000000000003 and the ratio 0.010000000000000005,
  so a swim exactly 1.0% off reads "not close". Same at 64.64 against 64.00.

### 3.10 Conversion and flyover (`sourcing/*.ts`), P4

```ts
export interface TableDRow { readonly lcmEventKey: EventKey; readonly scyEventKey: EventKey;
  readonly multiplierPermille: Setting<number>; readonly turnAdjustmentHundredths: Setting<number> }
export interface TableDPreset { readonly payloadVersion: 1; readonly rows: readonly TableDRow[];
  readonly rounding: Setting<'truncate' | 'round-half-up'> }
export type FlyoverSetting = { readonly state: 'unset' } | { readonly state: 'set'; readonly hundredths: number };
// Table D is retired (R58): TableDRow and TableDPreset stay as types for saved data, and nothing reads them.
export interface ConversionSettings {        // landed 2026-10-26; SourcingSettings extends it (P4)
  readonly includeConvertedSwims: boolean;   // per meet (F1.2)
  readonly lcmToScy: LcmToScyPreset | null;  // null = no LCM conversion. There is no tableD field.
}
export interface SourcingSettings extends ConversionSettings {
  readonly splitWindow: DateWindow;          // the caller computes "current + previous season"
  readonly flyover: FlyoverSetting;
}
export function flyoverFromSeconds(sec: number | undefined): FlyoverSetting;
export function scyStatementFor(swim: Pick<MeetSwim, 'eventKey' | 'recordedCourse' | 'recordedTime'>,
  swimcloudScy: TimeValue | null, division: DivisionRef, gender: Gender, s: ConversionSettings): ScyStatement;
export function estimateFlyingLeg(flat: MeetSwim, legEventKey: EventKey, flyover: FlyoverSetting):
  { readonly hundredths: number; readonly usedConverted: boolean } | null;
```

`flyoverFromSeconds` maps D3's `flyoverAllowanceSec`: `undefined` → `unset`; a
negative value, `NaN` or more than 2 decimals throws.

**Conversion order (R10):**
1. An event the course does not swim → `event_not_swum_in_course` (invariant 16). First.
2. A recorded SCY swim → `recorded-scy`.
3. `includeConvertedSwims` false → `conversions_excluded`.
4. SwimCloud shows a converted time → `swimcloud`.
5. An SCM swim → the NCAA table chosen by division (`convertSwimToSCYDetailed`,
   truncating; invariant 10).
6. An LCM swim with a row in `s.lcmToScy` → `lcm_scy_tool_derived` (3.13).
7. Otherwise → `no_conversion_available`. A relay, an NT swim, an LCM event with
   no row and a missing preset all land here: absent, never factor 1.0.

Every `converted` statement carries `estimated: true`, including SwimCloud's own
and the NCAA SCM ones. The Table A factor is published; the converted time is
still an estimate.

The new API does not use the gendered LCM factors (`constants.ts:11-29`, no source).

**Table D math (retired, R58).** No code runs it. The LCM math is in 3.13.

**Flyover:** `unset` → `null` (no estimate; the leg shows "no split"). `set`
with 0 → the estimate equals the flat time and still carries "est.".
**Named bug:** `flyover ?? 0`, which turns "never set" into a real estimate.
The estimate is also `null` when the flat time is `null`, the swim is not
rankable (invariant 8), `flat.eventKey !== legEventKey` (invariant 13), or the
result would be ≤ 0. When a converted swim is faster, the estimate uses it and
sets `usedConverted: true` (F1.3).

### 3.11 Planner (`planner/*.ts`): types P1, functions P5

```ts
export type SessionSlot = 'morning' | 'afternoon' | 'evening';
export interface SessionRef { readonly day: number; readonly slot: SessionSlot }   // day: integer >= 1
export type EventFormat =
  | { readonly kind: 'timed-final'; readonly session: SessionRef }
  | { readonly kind: 'prelims-finals'; readonly prelims: SessionRef; readonly finals: SessionRef }
  | { readonly kind: 'timed-final-split'; readonly slowHeats: SessionRef; readonly fastHeat: SessionRef;
      readonly fastHeatSize: Setting<number>;             // R35: NSISC 8, editable per meet
      readonly smallFieldSession: Setting<SessionRef> };  // R35: entries <= fastHeatSize; per meet, no default
export interface ScheduledEvent { readonly eventKey: EventKey; readonly gender: Gender | 'both';
  readonly format: EventFormat }
export interface SessionPreset { readonly payloadVersion: 1; readonly provenance: Provenance;
  readonly events: readonly ScheduledEvent[] }   // array order = order within a session (R16)
export type LoadPreference =
  | { readonly mode: 'respect'; readonly maxRacesPerSession: Setting<number>;
      readonly diving: Setting<'counts' | 'excluded'> }
  | { readonly mode: 'prefer'; readonly maxRacesPerSession: Setting<number>;
      readonly diving: Setting<'counts' | 'excluded'>;
      readonly penaltyPointsPerExtraRace: Setting<number> }   // no default
  | { readonly mode: 'off' };
export function parseSessionPreset(json: unknown): SessionPreset;
export function sessionLoad(model: MeetModel, lineup: Lineup, results: Results, schedule: SessionPreset,
  pref: LoadPreference): { readonly violations: readonly Violation[];
  readonly perSwimmer: readonly { readonly swimmerId: SwimmerId;
    readonly sessions: readonly { readonly session: SessionRef; readonly races: number;
      readonly eventKeys: readonly EventKey[] }[] }[] };
```

Rules:
- The schedule key is (event, gender); `'both'` expands to Men and Women. A
  `'both'` row plus a gendered row for the same event is a duplicate; parsing
  rejects it.
- A final comes strictly after its prelims, comparing (day, slot) with
  morning < afternoon < evening.
- Race counting (R17): a timed final counts 1 race in its session. A
  prelims-finals event counts 1 race in the prelims session. It counts 1 more
  in the finals session when the swimmer makes a final:
  - with `abFinalsScorersOnly` (R43), a scorer ranked within the point table
    (length of `individualPoints`) among scorers only swims the A or B final;
  - without it, any swimmer ranked within the point table does;
  - with `cFinal` `non-scorers` (R44), a non-scorer ranked within `size` among
    non-scorers only swims the C final.
- A split timed final (R20, R35) counts 1 race: in `fastHeat` when the
  swimmer's seed rank among all entries, scorers and non-scorers alike, is
  within `fastHeatSize`, else in `slowHeats`. Do not filter the fast heat by
  scorer status (R40: the 2026 meet had both in it). When the entries number
  `fastHeatSize` or fewer, the one heat swims in `smallFieldSession`. While a
  needed setting is pending, `sessionLoad` emits a `pending_setting` violation
  for that event and never guesses a session. It scores as one timed final
  either way. Relay legs
  count. Diving counts per the `diving` setting; the NSISC preference is
  `'excluded'`, user-stated (paraphrase), R22.
- An event in the lineup missing from the schedule gives an
  `unscheduled_event` violation, never zero races.

### 3.12 Built-ins (`rules/builtins.ts`, `planner/builtins.ts`, `sourcing/builtins.ts`), P1

```ts
export interface Builtin<P> { readonly id: string; readonly version: number; readonly label: string; readonly preset: P }
export const BUILTIN_RULE_PRESETS: readonly Builtin<RulePreset>[];        // 'nsisc' v1, 'generic' v1
export const BUILTIN_SESSION_PRESETS: readonly Builtin<SessionPreset>[];  // 'nsisc-table-c' v1
export const BUILTIN_TABLE_D: readonly Builtin<TableDPreset>[];           // 'table-d-user' v1, RETIRED (`retired` set)
export const BUILTIN_LCM_TO_SCY: readonly Builtin<LcmToScyPreset>[];     // 'lcm-scy-swimswam' v1, 3.13
export function builtinRulePreset(id: string, version: number): RulePreset | undefined;  // never a fallback
```

`tests/engineBuiltinVersions.test.ts` pins the sha256 of each built-in's JSON
per (id, version); changing content without raising `version` fails. D3 uses
the version to show "v2 available".

**`generic` v1:** individual and relay tables from `NCAA_FORMAT_RULESETS`
`'championship-16'` (`ncaaScoringRules.ts:611`, Rule 7-6-4), provenance
`published` (`sourceId` `ncaa-rule7-scoring`, `manifest`
`data/scoring_rules/sources/manifest.json`, `sha256` `5b98f8f6…bb92e`,
`publisher` NCAA, `locator` `Rule 7-6-4`). `aFinalBracketSize` from the same
ruleset through `bracketForFinals` (`scoringDefaults.ts:196`), also published.
Every other field `pending`: Rule 7 states no pool, diver weight or entry
limits (`scoringDefaults.ts:208-212`), and a missing limit is not "unlimited".

### 3.13 LCM to SCY and estimated cut tags (2026-10-26; README R58 to R61)

Source of the values: `data/conversions/swimswam/lcm-to-scy-2026-10-26.json`
(53 captures of the SwimSwam conversion tool, sha256 `2b9114cb…999f5`) and its
README. The tool publishes no factors. The values are **inferred from its outputs**.

```ts
export const LCM_SCY_DIVISOR_SCALE = 100000;               // 1.11 is 111000
export interface LcmToScyRow { readonly lcmEventKey: EventKey; readonly scyEventKey: EventKey;
  readonly divisorScaled: Setting<number>; readonly turnHundredths: Setting<number> }
export interface LcmToScyPreset { readonly payloadVersion: 1; readonly rows: readonly LcmToScyRow[];
  readonly rounding: Setting<'truncate'> }
export type LcmToScyAppliedTo = 'individual-swim' | 'relay-split';
export type LcmToScyBasis = { readonly method: 'lcm_scy_tool_derived'; readonly lcmEventKey: EventKey;
  readonly scyEventKey: EventKey; readonly divisorScaled: number; readonly turnHundredths: number;
  readonly provenance: Provenance; readonly appliedTo: LcmToScyAppliedTo };
export type LcmToScyResult =
  | { readonly kind: 'converted'; readonly hundredths: Hundredths; readonly basis: LcmToScyBasis }
  | { readonly kind: 'absent'; readonly reason: 'no_row_for_event' | 'setting_pending' | 'result_not_positive' };
export function convertLcmToScy(p: LcmToScyPreset, lcmEventKey: EventKey, lcmHundredths: Hundredths,
  appliedTo?: LcmToScyAppliedTo): LcmToScyResult;          // throws RangeError unless a positive integer
export function builtinLcmToScy(id: string, version: number): LcmToScyPreset | undefined;
export function scyStatementForSplit(split: Pick<RelaySplit, 'legEventKey' | 'course' | 'split'>,
  division: DivisionRef, gender: Gender, s: ConversionSettings): ScyStatement;
export function scyEventKeyFor(eventKey: EventKey, course: Course): EventKey;   // 400 → 500, 800 → 1000, 1500 → 1650
export function foldEventCutTags(tags: readonly CutTag[]): readonly CutTag[];   // R61
```

`cutTagForSwim`, `cutTagFromLegacy` and `closeThresholdFromPercent` are as in 3.9.

**Gender is a required argument** of `scyStatementFor` (the swimmer's `MeetSwimmer.gender`) and
`scyStatementForSplit` (the relay's `MeetEvent.gender`). It reaches the legacy SCM converter as is. No
code supplies a default (Codex review, 2026-10-26: a hardcoded men's value). Table A is keyed by
division and row only, so men and women convert alike today; a test passes the gender through a spy
so a default or a future gender-split table cannot go unseen. The LCM preset has no gender input: the
archived requests name none. The cut-tag path reads `swimmer.gender` and has no gender default.

**Math.** `SCY = truncate((LCM − turn) / divisor)` to the hundredth, in integers:
`floor((lcmH − turnH) * 100000 / divisorScaled)`. Truncation replays all 51
captures exactly (R59 permits rounding; it is not built). A result of 0 or less
is absent. The 17 rows, with divisor and turn, are the table in the archive
README. `'lcm-scy-swimswam'` v1 pins them, each with `tool-derived` provenance
that names the converter URL, the archive path and its sha256, and says the
values are inferred. The backstroke divisor is the least certain: any value from
1.0936095 to 1.0936130 reproduces the nine captures.

**No row, no conversion.** The 800 Freestyle Relay (the tool returns its input
unchanged), an LCM 500, 1000 or 1650, an LCM 100 IM and every relay are absent:
`not-convertible`, `no_conversion_available`. Never factor 1.0.

**Why a new built-in id, not `table-d-user` v2.** Table D is wrong for every
event (R58). A v2 of the same id would present a different table as a revision
of one the user rejected, and "v2 available" would nudge users toward it. The
model also differs: Table D multiplies by a permille, and this divides by a
scaled divisor, so it cannot fit a `TableDRow`. So `lcm-scy-swimswam` v1 is a
new id. `table-d-user` v1 keeps its bytes and gets `retired` on its wrapper.
`ConversionSettings` has no Table D field, so a stale setting cannot be ignored
in silence.

**Relay splits (R60, confirmed in R62).** The converter has no split data.
A split converts with the individual divisor and turn for its leg's stroke and
distance (`appliedTo: 'relay-split'`; the SCM Table A basis carries the same
marker). A split with no `legEventKey`, no `course`, or no row is absent. The
course is never assumed SCY. The marker is in the basis, so a consumer that
stores only the basis still knows. The full 800 free relay stays absent while
its 200 free leg converts.

**Flyover rule for P4 (R14, R62; not built here).** The flyover is a user-set
number of seconds with no default: "to subtract a little bit of time due to the
momentum gained and reaction on the exchange of the entering swimmer". A
converted time that is itself a flying-start relay split (`start: 'flying'`)
already includes the exchange, so the flyover must never be subtracted from it
again. The flyover applies only when a flat-start time projects into legs 2 to
4. `scyStatementForSplit` applies no flyover, and P4's `estimateFlyingLeg` needs
a test for no double subtraction.

**Estimated cut tag (R61).** A converted swim is judged as an SCY swim on its SCY
event and can earn `estimated-achieved`. It is never `achieved`. `cutTagFromLegacy`
still maps `converted_estimate` to `converted`, because the legacy comparison
uses the unsourced LCM factors. `foldEventCutTags` is the replacement rule:
a real `achieved` replaces an estimated tag at the same or a weaker standard.
A real swim that missed does not remove the estimate. Strictness is the
standard's time, not the tier name. **Not decided by R61:** a real tag at a
weaker standard than an estimated one (real B against estimated A). The fold
keeps both, real first, and chooses neither. This waits for the user's answer.

**Not changed.** The legacy `buildCutlineTag`, `converted_estimate`, the legacy
LCM factors and their tests stay as they were: they back the golden file and the
NAIA tests. Nothing in `apps/extension` calls the new functions yet, so the
live panel needs P4 wiring before users see any of this.

## 4. NSISC as data

Sources: **U** = `plans/2026-10-25/00-USER-PLAN.md` (verbatim, stated
2026-10-25). **R** = `plans/2026-10-25/README.md` decision rows (paraphrases,
`verbatim: false`). The last column is today's legacy value
(`scoringDefaults.ts`) for comparison only; nothing reads it.

| Path | NSISC v1 | Provenance | Legacy today |
| --- | --- | --- | --- |
| `scoring.individualPoints` | pending: "SwimCloud's NSISC per-place values (recon Q17). R15 states 16 places." | — | `[20,17,16,15,14,13,12,11,9,7,6,5,4,3,2,1]`, constants.ts:317 |
| `scoring.relayPoints` | pending (recon Q17) | — | multiplier 2, :39 |
| `scoring.divingPoints` | pending (recon Q17) | — | same as individual |
| `scoring.halfRateRelaySwimmer` | true | user-stated (paraphrase), R34 "1/4 each" | true, :40 |
| `scoring.aFinalBracketSize` | 8 | user-stated (paraphrase), R26 | 8, :43 |
| `scoring.nonScorerPlacement` | `'removed-from-consideration'` | user-stated (paraphrase), R41 | holds place, `individualScoring.ts:597-602`; F18 |
| `scoring.abFinalsScorersOnly` | true | user-stated (paraphrase), R43 | absent |
| `scoring.cFinal` | `{kind:'non-scorers', size:8}` | user-stated (paraphrase), R44 | absent |
| `scorers.eligibility` | `'roster'` | user-stated, R15 "Only scoring-team swimmers score"; U:23 | roster, :47 |
| `scorers.autoRules` | `{abFinalTiers:['A','B'], includeRelayLegsInFinals:true, distanceFinalRequired:true, distanceEventPattern:['1000','1650','1500'], splitTimedFinalMarksScorer:true}` | user-stated (paraphrase), R21, R38, R39, R40. The roster wins over placement (R40: "the scoring roster has precedent over placement"), so coach tags override every auto mark. `distanceFinalRequired` blocks only a prelims swim, and a split timed final has none | :48-53; no `splitTimedFinalMarksScorer` |
| `scorers.scoringTeamSize` | 18 | user-stated (paraphrase), R24; a relay swimmer takes a full spot, R28 | 18, :41 |
| `scorers.scoringTeamScope` | `'meet'` | user-stated verbatim U:21 "Total roster scoring headcount limitation (total number of team members allowed on scoring team)" | meet, :44 |
| `scorers.diverWeight` | `{1, 3}` | user-stated verbatim U:22 "divers are ⅓ of rull roster limit"; R9 | 1/3, :45 |
| `scorers.perEventScorerCap` | `{cap:'unlimited'}` | user-stated, R15 "No limit on how many swimmers from one team score in an event" | absent |
| `scorers.divingPerEventScorerCap` | `{cap:'unlimited'}` | user-stated (paraphrase), R27 | absent |
| `scorers.scoringRelaysPerTeamPerEvent` | 2 | user-stated (paraphrase), R25 "2 (A and B)"; R42: a setting, never hardcoded. For NSISC a 3rd relay is an entry violation (no non-scoring relays) | 2, :42; `?? 2` fallback, F17 |
| `scorers.relayEligibleFromScorerPool` | not applicable (roster mode) | — | false, :46 |
| `scorers.relayLegsMustBeScorers` | true | user-stated (paraphrase), R37 | not checked for A/B/FIN relays, `scorerRoster.ts:322`; F19 |
| `entries.maxIndividualPerSwimmer` | `'unlimited'` | user-stated verbatim U:24 "you can cut it any way you would like, usually 4I/4R, 3I/5R" | 999, :56 |
| `entries.maxRelayPerSwimmer` | `'unlimited'` | same, U:24 | 999, :57 |
| `entries.maxTotalPerSwimmer` | **8** | user-stated verbatim U:24 "nsisc caps at 8 total"; R4 | **7**, :58 |
| `entries.timeTrialsCount` | false | user-stated (paraphrase), ruling 2026-09-21, scoringDefaults.ts:85-86 | false |
| `entries.exhibitionCounts` | true | user-stated (paraphrase), ruling 2026-10-01, :85-86 | true |
| `entries.relayLegsAllowTimeTrials` | false | user-stated (paraphrase), decision D9, :118-131 | false |

The simulator's "max of 5" individual limit (U:24) is the range of a SwimCloud
control, not an NSISC rule.

**`nsisc-table-c` v1.** Provenance user-stated verbatim, U:55-76, 2026-10-25.
Swimming events use `'both'`; dives use the gender the table names. Rows
listed only under "(Finals)" are evening timed finals (R36). The 1000
and 1650 are split timed finals (R20): slower heats in the morning, the fastest
heat (the top 8 seeds, R35) in the evening, one swim each.

| Day | Prelims-finals: prelims morning, finals evening, in this order | Timed final, evening | Dive: prelims afternoon, finals evening |
| --- | --- | --- | --- |
| 1 | — | 800 Free Relay | — |
| 2 | 200 IM, 50 Free, 1000 Free (split timed final) | 200 Medley Relay | 1 m (Men) |
| 3 | 100 Fly, 400 IM, 200 Free | 400 Medley Relay | 3 m (Women) |
| 4 | 500 Free, 100 Back, 100 Breast, 200 Fly | 200 Free Relay | 3 m (Men) |
| 5 | 100 Free, 200 Back, 200 Breast, 1650 Free (split timed final) | 400 Free Relay | 1 m (Women) |

Evening order follows U:64, U:68, U:72, U:76: finals, then the relay, then the dive.

**`table-d-user` v1 (retired 2026-10-26, R58: "completely disregard table d, its incorrect").**
The content below is unchanged, so its pinned hash and any saved reference to
`{table-d-user, 1}` still hold. Retirement is a flag on the `Builtin` wrapper
(`retired`), outside the pinned preset. No function reads Table D (a test scans
the engine sources). See 3.13 for the replacement. Rows at U:82-84 and U:88-103 are user-stated verbatim
(`multiplierPermille: 892`, turn adjustments in hundredths). Rows at U:85-87
(400→500, 800→1000, 1500→1650) are **not used** (R29): those events take
SwimCloud's own conversion, else SwimSwam factors archived with a manifest
entry. Until that archive exists they are pending. `rounding` is `'truncate'`,
user-stated (paraphrase), R23.

**Drift test** (`tests/engineNsiscDrift.test.ts`): every `set` NSISC field,
mapped through the bridge, equals `NSISC_PRESET_SETTINGS`, except
`maxTotalPerSwimmer` (8 against 7), `nonScorerPlacement`
(`'removed-from-consideration'` against holds place), `relayLegsMustBeScorers`
(true against not checked) and `autoRules.splitTimedFinalMarksScorer` (true
against false), until P3 changes each legacy behavior on purpose, with a
failing test first, and updates the goldens. `abFinalsScorersOnly` and `cFinal`
have no legacy field and stay outside the test. When a pending field becomes `set`, the test covers it
automatically.

## 5. Risks: cases a plausible build gets wrong

| # | Wrong move | How it fails | Guard |
| --- | --- | --- | --- |
| 1 | A source scan reads a shim | Passes, checks nothing | Non-vacuity asserts, E5 canaries |
| 2 | Real-data scripts run in a worktree without `data/meets.json` | "Unchanged" proven by skipping | Orchestrator runs them in a checkout seeded with the full local data (Step 0); a skip is not run (E7) |
| 3 | Stryker mutates shims | About 0 mutants | E6 exact numbers |
| 4 | Moving through the cycle file by file | Does not compile | Step B moves everything at once |
| 5 | Editing moved code during the move | Breaks R100 and E1's meaning | E2 |
| 6 | Two module instances load | `instanceof` fails; preset bindings lost | E4 |
| 7 | `vi.mock` on a moved path | Spy sees no call | Step B repoint |
| 8 | `uuid` lost when `apps/shell` moves | Runtime import error | Engine declares `uuid` |
| 9 | `parseCap(undefined)` returns `'unlimited'` | A missing limit becomes no limit | 3.3 |
| 10 | Bridge passes `conference` or omits the eligibility mode | Cap 7 instead of 8, or a silent roster flip | 3.5 fixed point |
| 11 | `flyover ?? 0`, or a float close threshold | Fake estimates, or wrong tags at exactly 1.0% | 3.10, 3.9 |
| 12 | Renaming `Standard`/`Provisional` to A/B, or `converted_estimate` as `none` | Wrong badge | Exhaustive switch, 3.9 |
| 13 | Counting a finals race for a swimmer projected outside finals | False load warning | 3.11 |
| 14 | `stripSwimCloudData` sets `display: undefined` | D3 JSON-safety broken; key survives | 3.7 test |
| 15 | Display names used as legacy keys | Same-name swimmers merge | 3.8 synthetic names |
| 16 | A missing time read as 0 | An NT swim ranks fastest | `TimeValue \| null` |

## 6. Open questions this spec raised (none blocks Steps A to C)

Answered 2026-10-25 (README rows R20 to R44): Q-D2 (R29), Q-D3 (R20),
Q-D4 (R23), Q-D5 (R22), Q-D6 (R34), Q-D7 (R35), Q-D8 (R36), and in Q-D1
everything but the points: team size (R24), relays (R25, R42), A final (R26),
diving cap (R27), auto scorers (R21, R38-R40), relay legs (R37).

- **Q-D1 (rest).** Individual, relay and diving points per place (recon Q17).
- **Q-D2 (rest). Answered 2026-10-26 (R58): Table D is disregarded for every event, and the SwimSwam
  archive replaces it (3.13).** The 400→500, 800→1000 and 1500→1650 rows (U:85-87) gave
  impossible times [ran]: (240.00 − 6.40) × 0.892 = 208.37 s for a 500 yd
  from a 4:00.00 400 m. R29 drops them. Archive SwimSwam's factors with a
  manifest entry if recon shows an LCM swim with no SwimCloud conversion.
  The user's check value: 240.00 × 1.143 = 274.32 s (4:34.32). 1.143 is
  Table A's SCM factor, so this is a sanity range, not a conversion value.
- **Not asked, not specified:** how a conference that allows non-scoring
  relays places a relay over its cap. NSISC has none (R42). Add a setting
  when a conference needs one; do not invent a default.

## 7. Findings about the existing code

- **F1.** NSISC total is 7, against R4's 8: `scoringDefaults.ts:58`; the lock
  message at `:724` says "7 entries per swimmer".
- **F2.** The NSISC lock overrides every cap: `scoringDefaults.ts:780-789`
  overwrites all NSISC entry and scorer caps whenever the conference is NSISC,
  so in the legacy app a coach cannot set any NSISC limit. The new API avoids
  it (3.5).
- **F3.** A missing cap means unlimited throughout the legacy scorer
  (`?? 999` at `calculatePoints.ts:406-407`; `individualScoring.ts:194,266,693`;
  `swimmerEntryLimits.ts:194-196` and its helpers; `arbitrage/relayLegSwaps.ts:795-796`;
  `arbitrage/shared.ts:933`; `historyImportRoster.ts:823`; `scoringTheory.ts:823`),
  and `mergeScoringSettings` fills absent fields from the generic preset
  (`scoringDefaults.ts:760`). The extraction keeps this; the new API is the
  boundary that stops it.
- **F4.** Any cap ≥ 999 is unlimited (`meetPool.ts:47`;
  `individualScoring.ts:160,622`; `calculatePoints.ts:409-415`;
  `arbitrage/shared.ts:725,825`; `arbitrage/relayLegSwaps.ts:591`;
  `swimmerEntryLimits.ts`).
- **F5.** A generic preset can silently switch to roster mode:
  `scoringDefaults.ts:634-641` and `:769-772` flip any preset whose numbers look
  like NSISC (18, 2, meet scope, about 1/3).
- **F8.** The NSISC relay scorer cap (`maxRelaysScoringPerTeam: 2`,
  `scoringDefaults.ts:42`) has no source; added to recon Q17.
- **F9.** `uuid` is imported by four engine-bound modules (`athleteAliases.ts:33`,
  `swimEditor.ts:46`, `whatIfProjection.ts:18`, `historyImportRoster.ts:8`) but
  declared only by `apps/shell/package.json`, which moves to legacy.
- **F10.** The main clone's `node_modules` was stale (zod 3.25.76 installed vs
  4.6.7 locked); `npm ci` fixed it on 2026-10-25.
- **F11.** `legacy/backend/pdf_parser.py:42` reads core's JSON by path; Step A repoints it.
- **F12.** `docs/INVARIANTS.md` #5 says `calculatePoints` lives in `utils.ts`; it
  now lives in `lib/calculatePoints.ts` and `utils.ts:132-133` re-exports it.
- **F13.** The plan presented "scoring-team size: 18" as decided; no user
  statement or source gives 18. Now pending (Q-D1).
- **F14.** D3 5.6 rule 4 accepted a `published` source only from the cutlines
  manifest; the generic preset cites `data/scoring_rules/sources/manifest.json`.
  D3 now accepts any `data/**/sources/manifest.json`.
- **F15.** `tests/eventStrengthRanking.test.ts:633-652` and
  `legacy/tests/altitudeAdjustment.test.ts:516-527` walk `apps/` and `extensions/`;
  after the reorg they must also walk `legacy/` or they lose coverage.
  **Fixed** in the reorg review fix-up after d9f5c894.
- **F16.** `legacy/tests/theoreticalMeetGolden.test.ts` skips 5 tests in the main clone
  (`:411-413`) because the real captures are absent.
- **F17.** `relayScoring.ts:177` falls back to `maxRelaysScoringPerTeam ?? 2`:
  a hardcoded relay limit, which R42 rules out. The engine API has no
  fallback; the value is a `Setting<Cap>`.
- **F18.** A non-scorer keeps its place and earns 0 in the legacy scorer, for
  individuals (`individualScoring.ts:597-602`) and relays (the roster and cap
  branches in `relayScoring.ts:171-195`). R41 says non-scorers leave the places
  and scorers move up. P3 changes it with a failing test first. Official
  results that already mark non-scorers as exhibition are re-ranked by
  `rankAsIfExhibitionAbsent` today; check how SwimCloud marks them in recon.
- **F19.** `relayEntryRosterEligible` (`scorerRoster.ts:322`) lets every A, B
  or timed-final relay score without checking its legs. With R39 (relay legs
  are auto-marked) that matches R37 until a coach tag removes a leg; then the
  relay still scores. P3 fixes it with a failing test.

What the architect ran: an import-graph and impurity scan of
`packages/core/src`; a no-DOM type-check of the move set; a tsx subpath
resolution check; `npx vitest run` on `tests/mutation`, `theoreticalMeetGolden`,
`altitudeAdjustment`, `raceAnalysisPurity`, `eventStrengthRanking` (486 passed,
5 skipped); the float and Table D arithmetic.

## 8. Deviations taken during P1.engine (2026-10-26)

The orchestrator accepted each of these. The state file holds the evidence
(`REDESIGN_2026-10-25_STATE.json`, `P1.engine.steps`).

1. **E2 without commits.** The user has not asked for commits, so no R100
   exists. Instead, each engine file's sha256 equals that of
   `git show HEAD:packages/core/src/<p>`, and each core shim is exactly the
   two lines of 2.2. The check reported 79 moved, 0 problems after A, B and C.
2. **E1 theoretical case.** `tests/fixtures/theoretical-meet/` holds
   captures, not workspaces. `legacy/scripts/gen_engine_fingerprint_workspace.ts`
   builds one with the parameters of `theoreticalMeetGolden.test.ts:99-100`.
   `tests/engineExtractionFingerprintTheoretical.test.ts` hashes it.
3. **E1 optimizer ids.** `activeEntryIds` are uuids. The fingerprint projects
   them to plan positions.
4. **E5 row 4.** tsc does not fail on `import 'react'`, because react
   resolves and `types: []` only stops automatic globals. The engine `lint`
   script now runs tsc, then eslint.
5. **E6.** `relayScoring.ts` gives 161 mutants: 144 killed, 0 timeout,
   11 survived, 6 no coverage. The extra survivor (L185 `&&` → `||`) also
   survives at HEAD before the move, so it is test-suite drift since
   2026-10-14, not a move defect.
6. **3.12 `BUILTIN_TABLE_D`** is `readonly Builtin<TableDPreset>[]`, so v1
   stays addressable once v2 exists.
7. **Section 4 `scorers.divingPerEventScorerCap`** is
   `{kind: 'same-as-swimming'}` (R27, "same rule as swimming").
   `{cap: 'unlimited'}` is not a value of the union. Its bridged form
   (`own`, unlimited → 999) makes the legacy scorer throw on every dive
   under a meet-wide pool.
8. **Section 3 additions** (additive): `parseProvenance`, `parseSetting`,
   `RulePresetErrorCode`, `RulePresetError.paths`.
9. **NSISC v1 points stay pending.** Recon Q17 found SwimCloud has no NSISC
   preset. The user is asked (state file `Q-NSISC-points`), and a yes ships
   as `nsisc` v2.
10. **nsisc v2 (2026-10-26): points set from the user's answer; v1 unchanged.**
    The source is README R45. `RulePreset` has no tie setting. "Ties split"
    holds because `legacyBridge.ts` hands the points to the legacy scorer,
    which splits the place ladder across a tie group
    (`lib/individualScoring.ts:683`, `scoreIndividualsInEvent`).

Items 11 and later are P2.engine deviations and gaps (2026-10-26). The orchestrator
and `architect` have not accepted them yet. Item 12 decides nothing.

11. **P2 type changes to `model/meet.ts`. `RelaySplit.relayEventKey` widens an
    existing field, so it is not purely additive.**
    - `RelaySplit.relayEventKey` is `EventKey | null`. A SwimCloud split row
      names its leg ("50 Freestyle") and not its relay, so a 50 free split is
      ambiguous between a free relay and a medley relay. The adapter sets
      `null` instead of guessing one.
    - A dive's `recordedTime` holds the dive SCORE in hundredths of a point
      (451.28 is `45128`; higher is better). The type is reused, not
      widened. Nothing may format or parse a dive score as a time. A dive's
      `recordedCourse` is `'SCY'`.
    - A SwimCloud `leadoff` row becomes a `MeetSwim` flagged
      `extractedSplit`, because 42 entries across the recorded configs are
      seeded only by a leadoff. The engine never picks an extracted split on
      its own, but `scoreMeet` honors a pinned `seedSwimId` on one (the
      lineup, not the engine, chose it).
12. **P2 gaps for `architect`. None is decided here.**
    - **Tie policy: decided, see 8.16.** Measured before the decision: B, C
      and D differed from SwimCloud by 0.5 points between teams 48 and 412 on
      100 Breaststroke and 100 Freestyle, and a stable no-split rank matched
      all four configs.
    - **Inert-field provenance: decided, see 8.16.** The eight settings with
      no SwimCloud meaning (plus `scorers.autoRules`) now carry `engine-neutral`.
    - **`basis_position` violation.** SwimCloud's aggregate free relay
      reorders the legs after it picks them ("traditional" order), so a
      flat-start time can sit on leg 2 to 4. The points stay SwimCloud's. The
      violation flags it, because a real relay has a flat start on leg 1 only.
    - **`sourcing` is unread in P2.** The parameter is there so P4 adds none.
    - **Per-team entry limits have no preset field.** `maxIndrecordsPerTeam`
      and `maxRelaysPerTeam` are reported in `SimulatorPresetBuild.unmapped`,
      never dropped.
13. **Unsupported in P2, and loud.** SCM and LCM simulators, actual
    (non-aggregate) relays, an exhibition entry, a coach-edited entry time
    (it matches no swim: `time_not_in_swims`), an entry with no time, an
    unknown `pointSystem` (`scoring32` is named by one SwimCloud preset and
    defined nowhere in the bundle: the preset stays `pending` and
    `rescoreSimulator` returns `preset_incomplete`).
14. **Unverified shape.** The per-leg splash fields (leg stroke, distance,
    `flystart`, `eventtime`) are decoded from the archived bundle's `kf`, not
    seen on a live page. The fixture builder (`tests/helpers/simulatorFixtures.ts`,
    `pageLegs`) rebuilds them by that rule and requires exactly one position
    to explain each recorded relay time (11 of 11 do). A live capture of one
    relay splash would confirm it.
15. **Point tables** (`packages/swimcloud/src/browser/pointTables.ts`) are
    read from a third-party bundle, so their provenance is `tool-derived`,
    never `published`. A test compares every table to the verbatim bundle
    text. The archive under `data/swimcloud-captures/` is gitignored; the
    hash test runs only where it exists.

16. **Lead decision (2026-10-26): `scoring.ties`, payload version 2, `engine-neutral`.**
    - **Setting.** `scoring.ties: Setting<TieRule>`, `TieRule = 'split' | 'ordered'`.
      `'split'` is today's legacy behavior: tied entries share a rank and the
      points of the places they cover. `'ordered'`: every entry takes its own
      place; a tie is broken by entry order (the lineup order, a stable sort).
      `scoreMeet` hands the legacy scorer the ranks chosen by the rule, so
      `'split'` is byte-identical to before (the golden file is unchanged).
    - **Versions.** `RulePreset` is payload version 2; `RulePresetV1` is the old
      shape. `parseRulePreset` reads version 2, and reads version 1 by explicit
      migration (`migrateRulePresetV1`): every setting kept, `ties` pending, no
      rule assumed. `parseRulePresetV1` reads version 1 as version 1.
      `requireComplete` and `pendingPaths` throw `unsupported_version` for an
      object that still says version 1, so a stored payload read without a parse
      cannot look complete. `toLegacyScoringSettings(p, { ranksAreDistinct: true })`:
      `'ordered'` throws without the flag, because the legacy scorer would split.
    - **Built-ins.** Frozen payloads keep their pinned hashes (nsisc 1, nsisc 2,
      generic 1). A reference to `{nsisc, 2}` resolves to the same values plus
      `ties: 'split'` (README R45, line 69, "Ties split."), which the legacy scorer
      already applied. nsisc v1 and generic v1: `ties` pending (no source). The
      registry entry carries `frozen` (version 1) and `preset` (version 2); the
      version 2 view has its own pin.
    - **Simulator.** `ties: 'ordered'`, tool-derived from the archived bundle (`gf`).
      The stable `orderBy` is read from a later bundle that was not archived, so it
      has no hash here; `02-SIMULATOR-RECON.md` records it.
    - **`engine-neutral`.** `{kind: 'engine-neutral', reason}`: a neutral value no
      source or tool states, held only so the preset is complete. The simulator
      preset uses it for the nine paths in `SimulatorPresetBuild.inert`.
    - **Not done, for the storage owner.** `apps/extension` storage still records
      `PAYLOAD_VERSION = 1` and stores a rule preset payload as given. A stored
      version 1 payload validates (it migrates in `parseRulePreset`) but the stored
      value stays version 1, so storage must migrate on read before scoring.

## 9. Deviations taken during P3.core-a (2026-10-26)

1. **Over-cap removal is engine-side.** `scoreMeet` now scores a per-event
   scorer cap whose `overCap` is `'removed-from-consideration'`, for
   individual and diving events. The cap picks the over-cap entries from
   the full-field ranks. `scoreMeet` then ranks the field again without
   them, under the same `scoring.ties` rule, and hands only the survivors
   to the legacy scorer. `packages/engine/src/lib` is unchanged.
2. **A removed row has its own reason.** `NotScoredReason` gains
   `'removed_over_event_cap'`. A removed row has `place: null` and
   `points: 0`. `no_time` also has `place: null`, so a reader must check
   the reason, not `place`.
3. **`placement_unsupported` is no longer thrown.** It stays in
   `ScoreMeetErrorCode` so existing callers still compile.
4. **Relays always hold their place.** `scoringRelaysPerTeamPerEvent` has no
   over-cap rule (section 6). A test pins this. The question is open with
   the user (state file, `Q-relay-overcap`).
5. **A tie at the cap boundary.** When two teammates tie exactly at the cap,
   `placeOrderCompare` picks the one removed, by synthetic-id order. The
   team total does not change. Which swimmer earns the points is arbitrary.
   This matters for per-swimmer totals in P3.core-b.
6. **Relay over-limit treatment (P3.relay-overcap, 2026-10-27, README R67).**
   `RulePreset` is payload version 3. It adds `scorers.relayOverCap`:
   `'holds-place' | 'exhibition'`. It sets what happens to a relay over
   `scorers.scoringRelaysPerTeamPerEvent`. This supersedes item 4: a relay no
   longer always holds its place.
   - Which relays are over the limit does not change. `overCapKeys` picks them
     by rank in the full field, and a relay ranked past the point table takes
     no cap slot.
   - `'holds-place'` is today's behavior (reason `relay_scorer_cap`).
   - `'exhibition'` reads R67's "tagged exhibition" as "removed from the places
     like an exhibition entry". The over-limit relays leave the field, and the
     field is ranked again without them under the same `scoring.ties` rule.
     This is the removal of item 1. A removed relay keeps its row with
     `place: null`, `points: 0` and `notScoredReason: 'exhibition'`.
   - A payload of version 1 or 2 migrates on read with `relayOverCap` pending
     (`migrateRulePresetV2`). No rule is assumed.
   - Built-ins: `nsisc` v3 is v2 plus `'exhibition'`, from README R67
     (line 91). `nsisc` v1, `nsisc` v2 and `generic` v1 keep `relayOverCap`
     pending, so their scoring does not change. The SwimCloud simulator preset
     sets `'holds-place'`, because the page zeroes an over-limit relay and
     keeps its place.
7. **R42 is not modeled.** R42 says a 3rd NSISC relay is an entry violation.
   `Results.violations` has no relay entry-limit violation yet, so a 3rd
   relay scores as an exhibition (nsisc v3) and nothing flags the entry. The
   entry violation needs its own spec.
8. **Past-table relays under exhibition (fixed 2026-10-27).** Under
   `'exhibition'`, every relay after a team's first
   `scoringRelaysPerTeamPerEvent` leaves the places, past the point table
   or not. Before the fix, a team's 4th relay past the table took no cap
   slot. It moved into the place the removal opened and held it with 0
   points. Under `'holds-place'` a relay past the table still takes no
   slot (legacy `relayScoring.ts`, SwimCloud parity).
