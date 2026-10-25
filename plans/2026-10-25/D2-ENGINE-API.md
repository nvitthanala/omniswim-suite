# D2: `packages/engine` public API and extraction plan

Status: spec, 2026-10-25. Author: Claude architect (Opus, read-only), written
into the repo by the lead. Builds with D3 (`D3-STORAGE-AND-BUILD.md`); D3's
records wrap these payload types.

Evidence: [ran] = a command was run on tree 2f7c501d. [read] = code read there.
**Base the extraction on the reorg commit** (`03-REPO-REORG.md` rule 4) and
rerun the import scan there before Step A. Graph numbers below come from
`packages/core/src` as of 2f7c501d.

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

**Step 0: baseline** (orchestrator, main clone, at the reorg commit).
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
- `scripts/test_team_abbreviation_parity.mjs:25` → engine JSON path.
- `backend/pdf_parser.py:42` (at its post-reorg path) → engine JSON path. It
  fails loudly on a missing file (:47).

Step A proves shims, aliases, tsx, Stryker and the purity gate before the
large move.

**Step B: everything else (62 files: 61 `.ts` + `team_colors.json`)**, including
the cycle and `types.ts`, in one diff. Repoints in the same step:
- `tests/altitudeAdjustment.test.ts:516`: allowlist →
  `packages/engine/src/constants.ts` and `packages/engine/src/lib/altitude.ts`
  (fails loudly without it).
- `scripts/test_cutlines.mjs:687` → engine `cutlines.ts`; `:694` walks both
  `packages/engine/src` and `packages/core/src`.
- `scripts/test_cutline_tags.mjs:1193` → engine `lib/cutlineTags.ts` and
  `data/teamDivisions.ts`.
- `tests/theoreticalMeetShellNits.test.ts:111` → engine `lib/theoreticalMeetLabel.ts`.
- `tests/relayLegCredits.test.ts:93` → engine `types.ts` (works through the
  shim already; repoint for clarity).
- The other 8 `stryker.config.mjs` mutate paths → engine paths.
- `tests/optimizeStepOwnership.test.ts:16,32` (legacy after the reorg): mock
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
  | { readonly kind: 'user-edited'; readonly editedAt: IsoTime; readonly previous: Provenance | null };
export type Setting<T> =
  | { readonly state: 'set'; readonly value: T; readonly provenance: Provenance }
  | { readonly state: 'pending'; readonly question: string; readonly blocks: readonly string[] };
```

Invariants (each has a test): a parser rejects any other `kind`, including
`'legacy'`; editing gives `user-edited` with `previous`, and provenance is never
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

export interface RulePreset {
  readonly payloadVersion: 1;
  readonly scoring: {
    readonly individualPoints: Setting<readonly number[]>;    // scoringPoints :263; places = length
    readonly relayPoints: Setting<RelayPointRule>;
    readonly divingPoints: Setting<DivingPointRule>;
    readonly halfRateRelaySwimmer: Setting<boolean>;          // :265
    readonly aFinalBracketSize: Setting<number>;              // :270
  };
  readonly scorers: {
    readonly eligibility: Setting<'roster' | 'points_pool'>;  // scorerEligibilityMode :302
    readonly autoRules: Setting<ScorerAutoRules | null>;      // :309
    readonly scoringTeamSize: Setting<Cap>;                   // maxIndividualScorersPerTeam :266
    readonly scoringTeamScope: Setting<'meet' | 'event'>;     // scorerCapScope :291
    readonly diverWeight: Setting<DiverWeight>;               // diverScorerWeight :293
    readonly perEventScorerCap: Setting<PerEventScorerCap>;
    readonly divingPerEventScorerCap: Setting<DivingPerEventScorerCap>;
    readonly scoringRelaysPerTeamPerEvent: Setting<Cap>;      // maxRelaysScoringPerTeam :268
    readonly relayEligibleFromScorerPool: Setting<boolean>;   // :297
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
  | { readonly method: 'table_d'; readonly multiplierPermille: number;
      readonly turnAdjustmentHundredths: number; readonly provenance: Provenance };     // R10 fallback, "est."
export type ScyStatement =
  | { readonly kind: 'recorded-scy' }
  | { readonly kind: 'converted'; readonly hundredths: Hundredths; readonly basis: ConversionBasis }
  | { readonly kind: 'not-convertible';
      readonly reason: 'event_not_swum_in_course' | 'no_conversion_available' | 'conversions_excluded' };
export type SwimOrigin =
  | { readonly kind: 'simulator'; readonly snapshotId: string }
  | { readonly kind: 'history-fetch'; readonly fetchedAt: IsoTime; readonly url: string };
export interface MeetSwim { readonly swimId: string; readonly swimmerId: SwimmerId; readonly eventKey: EventKey;
  readonly recordedCourse: Course; readonly recordedTime: TimeValue | null;   // null = NT
  readonly date: IsoDate | null; readonly seasonId: string | null;
  readonly flags: SwimFlags; readonly scy: ScyStatement; readonly origin: SwimOrigin }
export interface RelaySplit {                     // RelayLegCredit, types.ts:659
  readonly splitId: string; readonly swimmerId: SwimmerId; readonly relayEventKey: EventKey;
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
export function validateMeetModel(m: unknown): MeetModel;
```

`validateMeetModel` checks: unique IDs; every reference resolves; an
individual swim's swimmer gender equals the event gender; a `converted`
statement never sits on a recorded SCY swim or a null time; a swim with
`altitudeAdjustedBySource` is never adjusted again (invariant 9).

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
export type NotScoredReason = 'non_scorer' | 'scoring_team_full' | 'event_scorer_cap' | 'relay_scorer_cap'
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
      readonly reason: 'wrong_gender' | 'duplicate_swimmer' | 'event_mismatch' }
  | { readonly kind: 'unscheduled_event'; readonly eventKey: EventKey; readonly gender: Gender };
export interface Results {
  readonly payloadVersion: 1;
  readonly teams: readonly { readonly teamId: TeamId; readonly points: number; readonly rank: number }[]; // TeamScore types.ts:231
  readonly events: readonly { readonly eventKey: EventKey; readonly gender: Gender; readonly rows: readonly ResultRow[] }[];
  readonly violations: readonly Violation[];
  readonly rosterUnknown: readonly SwimmerId[];
  readonly display?: LineupDisplay;   // names and times, removable
}
export function scoreMeet(model: MeetModel, lineup: Lineup, tags: readonly ScorerTag[],
  rules: CompleteRulePreset, sourcing: SourcingSettings): Results;
export function stripResultsDisplay(r: Results): Results;
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
  equals `model.observedScores` exactly.

### 3.9 Cut tags (`sourcing/cutTag.ts`), P4

```ts
export type { CutlineTier as CutTier } from '../cutlines';   // cutlines.ts:152, the source's own name
export type CutGap = { readonly tier: CutlineTier; readonly standard: TimeValue;
  readonly gapHundredths: number;      // > 0
  readonly gapBasisPoints: number;     // floor(gap * 10000 / standard)
  readonly source: CutlineSourceRef };
export type CutUnknownReason = 'division_unknown' | 'program_discontinued' | 'gender_not_sponsored'
  | 'no_table_for_division' | 'event_not_in_table' | 'no_time' | 'conversion_unavailable'
  | 'user_inputted' | 'extracted_split' | 'program_unconfirmed' | 'event_not_swum_in_course';
export type CutTag =
  | { readonly kind: 'achieved'; readonly tier: CutlineTier;
      readonly slot: 'A' | 'B' | null;          // legacySlotForTier, cutlines.ts:560
      readonly marginHundredths: number; readonly source: CutlineSourceRef;
      readonly nextTier: CutGap | null }         // a B swimmer's gap to A (R11); null at the strictest tier
  | { readonly kind: 'close'; readonly nearest: CutGap; readonly thresholdBasisPoints: number }
  | { readonly kind: 'none'; readonly nearest: CutGap | null }
  | { readonly kind: 'converted'; readonly indicative: CutlineIndicativeComparison | null }  // never a cut
  | { readonly kind: 'not-applicable'; readonly reason: 'diving' }
  | { readonly kind: 'unknown'; readonly reason: CutUnknownReason; readonly detail: string };
export type CloseThreshold = { readonly basisPoints: number };   // 100 = 1.0%
export function closeThresholdFromPercent(pct: number): CloseThreshold;   // D3 cutCloseThresholdPct
export function cutTagForSwim(swim: MeetSwim, swimmer: MeetSwimmer, team: MeetTeam, t: CloseThreshold): CutTag;
export function cutTagFromLegacy(r: CutlineTagResult, t: CloseThreshold): CutTag;
```

- `closeThresholdFromPercent` throws unless `pct >= 0` and `pct * 100` is an
  integer to within 1e-9.
- A swim with `scy.kind === 'converted'` returns `converted` before any lookup
  (F1.2, invariants 10 and 11).
- `cutTagFromLegacy` is an exhaustive `switch` over `CutlineTagState`
  (`cutlineTags.ts:149`) with a `never` default: `tagged` → `achieved`;
  `converted_estimate` → `converted`; `not_applicable` → `not-applicable`;
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
export interface SourcingSettings {
  readonly includeConvertedSwims: boolean;   // per meet (F1.2)
  readonly tableD: TableDPreset | null;      // null = no Table D fallback
  readonly splitWindow: DateWindow;          // the caller computes "current + previous season"
  readonly flyover: FlyoverSetting;
}
export function flyoverFromSeconds(sec: number | undefined): FlyoverSetting;
export function scyStatementFor(swim: Omit<MeetSwim, 'scy'>, swimcloudScy: TimeValue | null,
  division: DivisionRef, s: SourcingSettings): ScyStatement;
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
6. An LCM swim with a complete matching Table D row → `table_d`.
7. Otherwise → `no_conversion_available`.

The new API does not use the gendered LCM factors (`constants.ts:11-29`, no source).

**Table D math** for `truncate`: `floor((lcmH − adjH) * permille / 1000)` in
integers. Rounding is pending (Q-D4); until it is set no row is usable.

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
  | { readonly kind: 'prelims-finals'; readonly prelims: SessionRef; readonly finals: SessionRef };
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
  prelims-finals event counts 1 race in the prelims session and 1 more in the
  finals session only when the swimmer's projected place is inside the point
  table (place ≤ length of `individualPoints`). Relay legs count. Diving counts
  per the `diving` setting.
- An event in the lineup missing from the schedule gives an
  `unscheduled_event` violation, never zero races.

### 3.12 Built-ins (`rules/builtins.ts`, `planner/builtins.ts`, `sourcing/builtins.ts`), P1

```ts
export interface Builtin<P> { readonly id: string; readonly version: number; readonly label: string; readonly preset: P }
export const BUILTIN_RULE_PRESETS: readonly Builtin<RulePreset>[];        // 'nsisc' v1, 'generic' v1
export const BUILTIN_SESSION_PRESETS: readonly Builtin<SessionPreset>[];  // 'nsisc-table-c' v1
export const BUILTIN_TABLE_D: Builtin<TableDPreset>;                      // 'table-d-user' v1
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
| `scoring.halfRateRelaySwimmer` | pending | — | true, :40 |
| `scoring.aFinalBracketSize` | pending | — | 8, :43 |
| `scorers.eligibility` | `'roster'` | user-stated, R15 "Only scoring-team swimmers score"; U:23 | roster, :47 |
| `scorers.autoRules` | pending: "Do scorers come from A/B-final rules, or only from the coach's tags?" | — | :48-53 |
| `scorers.scoringTeamSize` | pending: "NSISC scoring-team size. 18 is only in code." | — | 18, :41 |
| `scorers.scoringTeamScope` | `'meet'` | user-stated verbatim U:21 "Total roster scoring headcount limitation (total number of team members allowed on scoring team)" | meet, :44 |
| `scorers.diverWeight` | `{1, 3}` | user-stated verbatim U:22 "divers are ⅓ of rull roster limit"; R9 | 1/3, :45 |
| `scorers.perEventScorerCap` | `{cap:'unlimited'}` | user-stated, R15 "No limit on how many swimmers from one team score in an event" | absent |
| `scorers.divingPerEventScorerCap` | pending: "Does R15 cover diving events?" | — | absent |
| `scorers.scoringRelaysPerTeamPerEvent` | pending (recon Q17; R15 is silent on relays) | — | 2, :42 |
| `scorers.relayEligibleFromScorerPool` | pending | — | false, :46 |
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
listed only under "(Finals)" are read as timed finals (confirm, Q-D3).

| Day | Prelims-finals: prelims morning, finals evening, in this order | Timed final, evening | Dive: prelims afternoon, finals evening |
| --- | --- | --- | --- |
| 1 | — | 800 Free Relay | — |
| 2 | 200 IM, 50 Free, 1000 Free | 200 Medley Relay | 1 m (Men) |
| 3 | 100 Fly, 400 IM, 200 Free | 400 Medley Relay | 3 m (Women) |
| 4 | 500 Free, 100 Back, 100 Breast, 200 Fly | 200 Free Relay | 3 m (Men) |
| 5 | 100 Free, 200 Back, 200 Breast, 1650 Free | 400 Free Relay | 1 m (Women) |

Evening order follows U:64, U:68, U:72, U:76: finals, then the relay, then the dive.

**`table-d-user` v1.** Rows at U:82-84 and U:88-103 are user-stated verbatim
(`multiplierPermille: 892`, turn adjustments in hundredths). Rows at U:85-87
(400→500, 800→1000, 1500→1650) are **pending** (Q-D2). `rounding` is pending (Q-D4).

**Drift test** (`tests/engineNsiscDrift.test.ts`): every `set` NSISC field,
mapped through the bridge, equals `NSISC_PRESET_SETTINGS`, except
`maxTotalPerSwimmer` (8 against 7) until P3 changes the legacy value on purpose
and updates the goldens. When a pending field becomes `set`, the test covers it
automatically.

## 5. Risks: cases a plausible build gets wrong

| # | Wrong move | How it fails | Guard |
| --- | --- | --- | --- |
| 1 | A source scan reads a shim | Passes, checks nothing | Non-vacuity asserts, E5 canaries |
| 2 | Real-data scripts run in a worktree without `data/meets.json` | "Unchanged" proven by skipping | Orchestrator runs them in the main clone; a skip is not run (E7) |
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

- **Q-D1 (NSISC values).** Pending: individual, relay and diving points per
  place (recon Q17); scoring-team size (18 exists only in code); scoring relays
  per team per relay event (2 exists only in code); A-final bracket size (8);
  half-rate relay swimmers; whether R15's "no per-event scorer limit" covers
  diving; whether scorers come from the A/B-final auto rules or only from the
  coach's tags.
- **Q-D2 (Table D distance rows).** The 400→500, 800→1000 and 1500→1650 rows
  (U:85-87) give impossible times [ran]: a 4:00.00 400 m LCM gives
  (240.00 − 6.40) × 0.892 = 208.37 s for a 500 yd, faster than the shorter
  400 m. A 15:00 1500 m gives 781.39 s for a 1650 yd. Table A's own 400 m →
  500 yd factor is 1.143 (U:46). Confirm or correct.
- **Q-D3 (Table C distance events).** Table C lists the 1000 and 1650 under both
  prelims (morning) and finals (evening) (U:62,64,74,76). R17 says distance
  events are usually timed finals. Are they timed finals with slower heats in
  the morning and the fastest heat in the evening, or true prelims and finals?
  Also confirm relays listed only under "(Finals)" are timed finals.
- **Q-D4 (Table D rounding).** Truncate, or round half up?
- **Q-D5 (diving and load).** Does diving count toward the races-per-session
  preference? Ships as pending, no default.

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
- **F11.** `backend/pdf_parser.py:42` reads core's JSON by path; Step A repoints it.
- **F12.** `docs/INVARIANTS.md` #5 says `calculatePoints` lives in `utils.ts`; it
  now lives in `lib/calculatePoints.ts` and `utils.ts:132-133` re-exports it.
- **F13.** The plan presented "scoring-team size: 18" as decided; no user
  statement or source gives 18. Now pending (Q-D1).
- **F14.** D3 5.6 rule 4 accepted a `published` source only from the cutlines
  manifest; the generic preset cites `data/scoring_rules/sources/manifest.json`.
  D3 now accepts any `data/**/sources/manifest.json`.
- **F15.** `tests/eventStrengthRanking.test.ts:633-652` and
  `tests/altitudeAdjustment.test.ts:516-527` walk `apps/` and `extensions/`;
  after the reorg they must also walk `legacy/` or they lose coverage.
- **F16.** `tests/theoreticalMeetGolden.test.ts` skips 5 tests in the main clone
  (`:411-413`) because the real captures are absent.

What the architect ran: an import-graph and impurity scan of
`packages/core/src`; a no-DOM type-check of the move set; a tsx subpath
resolution check; `npx vitest run` on `tests/mutation`, `theoreticalMeetGolden`,
`altitudeAdjustment`, `raceAnalysisPurity`, `eventStrengthRanking` (486 passed,
5 skipped); the float and Table D arithmetic.
