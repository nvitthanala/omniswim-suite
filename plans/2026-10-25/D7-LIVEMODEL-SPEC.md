# liveModel wiring spec (D7 section 8, step 4b)

Author: Claude `architect` agent (Opus), 2026-11-06, read-only. Saved by
the lead. Inputs: D7 decisions L and P, section 4, section 5;
`docs/reference/F1_1A_ROSTER_ARCHITECT_REVIEW.md` ruling 2;
`docs/reference/F1_3A_FOLLOWUP_ARCHITECT_REVIEW.md` rulings 2 and 3.
Lead decision: the planner veto point below is accepted (the session
planner moves to `live`).

This is the first change that lets fetched SwimCloud data alter scoring
inputs.

## 1. API: new `apps/extension/src/dashboard/liveModel.ts`

```ts
export interface LiveStored { membership: ReadonlyMap<string, RosterRecord>; current: ReadonlyMap<string, RosterRecord>; overrides: readonly ClassYearOverrideRecord[] }
export interface LiveModel {
  meetKey: string; key: string; choice: RosterSeasonChoice; currentLabel: string | null;
  adapted: AdaptedSimulator;      // raw adapter output (preset, divisionSeasonNote). Never enriched.
  model: MeetModel; lineup: Lineup;
  sourcing: SourcingSettings;     // the caller's object, same reference
  enrichment: Pick<EnrichResult, 'teams' | 'removedEntries'>;
}
export type LiveOutcome = { kind: 'not_loaded'; missing: readonly string[] } | { kind: 'error'; reason: string } | { kind: 'ready'; live: LiveModel };
export function buildLiveModel(i: { snapshot: SimSnapshot; choice: RosterSeasonChoice; currentLabel: string | null; stored: LiveStored; sourcing: SourcingSettings }): LiveOutcome;
export async function loadLiveModel(a: { snapshot: SimSnapshot; repo: StorageRepo; currentLabel: string | null; sourcing: SourcingSettings }): Promise<LiveOutcome>;
export type LiveLoader = (snapshot: SimSnapshot) => Promise<LiveOutcome>;
export function partitionTags(live: LiveModel, tags: readonly ScorerTag[]): { kept: ScorerTag[]; notMember: readonly ScorerTag[] };
export { loadStored as loadLiveStored, currentLabelOf };  // moved here from rosterTab.tsx
```

- `buildLiveModel` is pure. It runs `adaptSimulatorSnapshot`, then
  `enrichRosterMembership`. It passes `rosters` and `classYears` for every
  team. A `RangeError` or `AdapterError` from enrichment becomes `error`.
- `key` comes from `snapshotKey`, the choice, `currentLabel`, each
  roster's `[teamId, seasonId, fetchedAt]` and each override's
  `[swimmerId, classYear, rev]`. Equal keys mean equal output.
- `partitionTags` drops only the tags of `not_member` swimmers. It keeps
  the tags of `unknown` swimmers. It never deletes a stored row.
- `main.tsx` makes one `LiveLoader`, with
  `currentLabel = currentLabelOf(rosterFlow.seasons(), rosterFlow.save())`
  and `SIMULATOR_SOURCING`. Each operation loads once and passes `live`
  down. Nothing loads again after an await.

## 2. Score versus decision P

- **Stay on `rescoreSimulator` with the raw snapshot:** Score, Chart,
  parity (`main.tsx:91`) and `sessionPlannerEditor.tsx:38`. The editor
  reads only events, and enrichment does not change events.
- **Read `live`:** Build, Accept, the Plan session load, scorer tags,
  suggestions, cut tags and Save.
- Decision P governs parity. Ruling 2 governs the scoring inputs that use
  the coach's rules. The two do not conflict.
- **Planner (accepted veto point):** `buildPlannerState`
  (`main.tsx:173-191`) moves to `live` and to a new
  `dashboard/plannerState.ts` so it can be tested. If it stayed raw,
  session load would count swimmers that Build removed.
- **Score tab note when a season is chosen:** "Roster season S applies to
  Build, Plan and scorer tags (N entries removed). This table is
  SwimCloud's own lineup, scored as SwimCloud scores it."

## 3. Persisting the choice

- **New `SettingsMap` key** `rosterSeasonsByMeet`:
  - Type: `Readonly<Record<string, string>>`. Each value is a label
    matching `^\d{4}-\d{4}$`.
  - No key for a meet means simulator-current.
  - No `SETTINGS_DEFAULTS` entry. DB_VERSION stays 2.
- **New in `settingsStore.ts`:**
  - `readRosterSeason(repo, meetKey): Promise<RosterSeasonChoice>`
  - `saveRosterSeason(repo, meetKey, choice)`: saving simulator-current
    deletes the meet's entry.
- **`rosterTab.tsx`:** it reads and writes the setting instead of
  `useState`. It always renders the stored label as an option, even when
  the season list is null or lacks it.
- **Recompute triggers:**
  - `watchChanges` adds the `rosters` and `classYearOverrides` stores to
    the tag-state and planner triggers.
  - Subscribe to `rosterFlow`, but publish only when `currentLabelOf`
    changes or a save reaches `saved`. Progress ticks must not start LP
    solves.
  - Build runs on demand, and `key` catches a stale result.

## 4. Scorer tags on `not_member` swimmers: drop and report

- `scoreScorerTags(live, hasOwnTeam, tags, preset?)` warns: "{name} is
  not on the {label} roster; the {role} tag is not used."
- `suggestOpponentRosters(live, ownTeamId, coachTags, preset, solve)`
  partitions the coach tags first. Otherwise the preflight at
  `rosterSuggest.ts:623` throws.
- `prepareRequest({ live, repo, solveLp, controls })`:
  - `request.tags` is the kept tags plus the suggested tags.
  - `request.sourcing` is `live.sourcing`.
  - `RunInputs.coachTags` stays the stored list, so Accept does not
    always report "tags changed".
  - `RunInputs.liveKey` and `ready.droppedTags` are new.
  - In season mode it returns `missing` when the own team's status is not
    `members` (`space.ts:121` would otherwise fix every event silently).
- `verifyProposal`: `AcceptDeps` gains `loadLive`. It loads once and
  refuses when `live.key !== inputs.liveKey`.
- `panelCutTags(live, pct)` reads `live`.
- The literal sourcing objects at `scorerTagScoring.ts:88` and
  `suggestedRosters.ts:31` go.
- **`buildSnapshotRecord`:**
  - It calls `deps.loadLive` once.
  - In season mode it refuses: "Saved snapshots cannot record a roster
    season yet."
  - Otherwise `results = scoreMeet(live.model, live.lineup, [],
    requireComplete(live.adapted.preset.preset), live.sourcing)`,
    `payload = live.lineup`, and `facts = captureReportFacts(live.model,
    live.lineup, live.sourcing)`.
  - Suggestions come from `live`.

## 5. Tests

New files: `tests/extensionLiveModel.test.ts` (pure) and
`tests/extensionLiveModelWiring.test.ts`. Fixture ids are numeric
(decision I). The setup asserts `status === 'members'`, so a
non-numeric id fails instead of passing on the not-loaded path.

| # | Invariant | Mutation it kills |
|---|---|---|
| T1 | Simulator-current with empty stores: `live.model` and `live.lineup` are `toStrictEqual` to the adapter's, and results are `toStrictEqual` to `rescoreSimulator(...).results` | membership applied in simulator-current |
| T2 | Two teams with current rosters: both teams get a non-null `classYear`; results equal | class years for the selected team only |
| T3 | Season mode: a `not_member` swimmer's individual entry is removed; a relay with one `not_member` leg is removed whole, from `request.lineup` and from the planner | drop the leg only |
| T4 | A team with no record, or with a non-numeric id: status `not-loaded`, every swimmer `unknown`, zero removals | a missing record treated as `members: []` |
| T5 | A `not_member` tag is dropped from scoring and suggestions and reported; an `unknown` tag is kept; the stored row is unchanged | drop `unknown` too; filter in one site only |
| T6 | Season mode with the own team not loaded: `prepareRequest` returns `missing` | the check removed |
| T7 | The season setting changes between Run and Accept: Accept is refused | the key comparison skipped |
| T8 | Save calls the loader once; `captureReportFacts` gets `toBe` `live.model`, `live.lineup`, `live.sourcing`; season mode is refused; `extensionSnapshotSaveSourcing.test.ts` pins the injected object (a fresh object equal to the constant) | use the constant; load again after an await |
| T9 | The setting round-trips; the validator rejects `''` and `'abc'`; the Rosters tab with a stored label and null seasons shows that label selected | render only the season-list options |
| T10 | In season mode the Score view still equals `rescoreSimulator` | feed `live` to `main.tsx:91` |

Gates:
- The golden check and `bash tests/fixtures/lp-baseline/lpBaseline.sh
  check` must stay unchanged. The golden harness imports only
  `packages/core`, so T1 is the real equivalence check.
- `git diff --exit-code packages/swimcloud/src/browser/rescore.ts`.
- `npm run lint` and `npm test`.

## 6. Scope

**May touch:**
- `apps/extension/src/dashboard/`: `liveModel.ts` (new),
  `plannerState.ts` (new), `main.tsx`, `scorerTagScoring.ts`,
  `suggestedRosters.ts`, `autoBuilderRequest.ts`, `autoBuilderAccept.ts`,
  `autoBuilderResult.ts`, `autoBuilderPanel.tsx`, `snapshotSave.ts`,
  `liveView.tsx`, `rosterTab.tsx`, `settingsStore.ts`.
- `apps/extension/src/storage/schema.ts` and `validate.ts`, for the new
  key only.
- The tests named above, and existing tests whose call sites change.

**Out of scope:**
- `packages/swimcloud/**`, `packages/engine/**` and
  `sessionPlannerEditor.tsx`.
- Migrations, DB_VERSION, `tests/fixtures/extension-db/*` and
  `FROZEN.json`.
- F1.3b, F1.2, the `builtUnder` schema and `relayLegReadout`.

## 7. User choices (built to the defaults; questions U14-U16)

- **U-a (U14): Save in season mode.** Default: refuse until `builtUnder`
  can record the season (F1.3b schema change).
- **U-b (U15): Is the choice per meet or global?** Default: per meet.
- **U-c (U16): Do class years apply in simulator-current mode too?**
  Default: yes. Results do not change, but `facts.classYears` fill in once
  a current roster or an override is stored.

## Findings the spec fixes

- `autoBuilderAccept.ts:43` checks only `snapshotKey`, so a roster or
  season change between Run and Accept would get past it (T7).
- An unloaded own team makes every own swimmer `unknown`, so Build changes
  nothing and says nothing (`space.ts:121`, T6).
- `suggestOpponentRosters` runs at four sites (`main.tsx:228`,
  `autoBuilderRequest.ts:167`, `snapshotSave.ts:58`,
  `autoBuilderAccept.ts:108`), and each one adapts the snapshot again.
- `watchChanges` (`main.tsx:195-203`) ignores the `rosters` and
  `classYearOverrides` stores.
