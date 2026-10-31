# D6. Dashboard (phase P7)

Architect spec, 2026-10-31. Scope: plan `01-REDESIGN-PLAN.md` S2 (line 38),
F5.1 theming, F5.2 score chart, F5.4 SwimCloud look, F6 saved lineups,
snapshots and undo, reports and entry CSV. Acceptance (plan line 525): a
visual check in both themes, and exports open in Excel. Build core first,
then UI. Do not redesign the AutoBuilder UI (D5 amendment 7) or the
planner UI; leave slots for them.

## 0. Facts that shape the design

- **The tab host has no live data.** The panel port opens only for the
  docked host (`apps/extension/src/dashboard/main.tsx:209-215`). The tab
  works from stored records; the docked panel holds everything live.
- **Two meet keys exist.** Scoring uses `'swimcloud-simulator'`
  (`main.tsx:48`); tags and the planner use `meetKeyFor(snapshot)`
  (`main.tsx:109,112`). Every saved lineup and snapshot uses `meetKeyFor`.
  `scoreMeet` throws `meet_key_mismatch` across keys. A new date window
  gives a new key; P7 diffs only within one key.

## 1. Information architecture

| Host | Sections |
| --- | --- |
| Docked (360×240 px, `shadowStyle.ts:46-47`) | Tab bar: **Score** (parity table, `main.tsx:72-93`), **Chart**, **Build** (slot for U1-b), **Plan** (`SessionPlannerEditor`, moved from `main.tsx:94`), **Save** (save lineup, snapshot, Undo, "Open in tab"). One added "expanded" size. Harness assertion 7 (D3 §13) still passes. |
| Tab | Left nav: **Meets** (lineups and snapshots per meet → diff, chart, report, CSV), **Presets** (slot), **Settings** (theme, accent, cut threshold, storage estimate, backup export/import). Exports and printing happen only here: download and print from an iframe on swimcloud.com are unverified. |

## 2. Engine: new module `packages/engine/src/report/`

Additive root exports. Inputs are what a stored `LineupRecord` holds; only
`captureReportFacts` takes a `MeetModel` (docked, live data only).
`packages/engine/src/lib/**` stays frozen: adapt around `entryExport.ts`,
`reportBuilder.ts` and `scenarioDiff.ts`, never edit them.

```ts
export function parseResults(json: unknown): Results;            // throws ReportParseError{path}; never cast `results: unknown` (schema.ts:115)
export type SeedFact = { kind:'time'; hundredths: Hundredths; estimated: boolean } | { kind:'score'; hundredths: Hundredths }
  | { kind:'none'; reason:'no_time'|'not_convertible' };
export interface ReportFacts { payloadVersion:1; seeds: Record<string, SeedFact>; classYears: Record<SwimmerId, ClassYearCode|null> }
export function captureReportFacts(model: MeetModel, lineup: Lineup): ReportFacts;
export function parseReportFacts(json: unknown): ReportFacts;
export type ProgressionOrder = { kind:'schedule' } | { kind:'simulator'; reason:'no_schedule'|'unplaced';
  unplaced: readonly { eventKey: EventKey; gender: Gender; why:'unscheduled'|'pending_setting' }[] };
export interface Progression { order: ProgressionOrder;
  points: readonly { eventKey: EventKey; gender: Gender; scoresIn: SessionRef|null; totals: Readonly<Record<TeamId, number>> }[] }
export function scoreProgression(results: Results, schedule: SessionPreset|null): Progression;   // F5.2
export function swimmerPoints(results: Results, lineup: Lineup): readonly { swimmerId; teamId; individual: number; relayShare: number; total: number }[];
export function diffResults(then: {results: Results; lineup: Lineup}, now: {results: Results; lineup: Lineup}, teamId: TeamId): ResultsDiff;
export function entryCsv(lineup: Lineup, results: Results, facts: ReportFacts, roles: ReadonlyMap<SwimmerId, RoleLabel>): { content: string; count: number; issues: readonly CsvIssue[] };
```

**`scoreProgression`** (each rule is a test):
- Where an event scores: a timed final in its session; prelims-finals in
  **finals**; a split timed final in `fastHeat` (R20), or in
  `smallFieldSession` when entries ≤ `fastHeatSize`; a pending setting leaves
  the event unplaced.
- Order: (day, morning < afternoon < evening, the preset's array index). A
  `'both'` row expands to Men and Women, tie broken by `Results.events` order.
- Any unplaced event switches the whole chart to simulator order with
  `reason:'unplaced'` and lists it: never dropped, never appended. No
  schedule gives `reason:'no_schedule'`. Every model team gets a series.
- Invariant: each series ends at `results.teams[].points`, tested at 1e-9
  (a three-way tie split makes float sums order-dependent,
  `results.ts:846-849`), plus an exact test with all-quarter points.

**`swimmerPoints`:** a relay leg gets a quarter of the relay's points (both
branches of `relayScoring.ts:205-209` give 1/4 for four legs, R34).
Swimmers' totals sum to the team's points.

**`diffResults`:** the shape of `ScenarioDiffResult`, with `inThen`/`inNow`
flags (`scenarioDiff.ts:55-101`). An absent side is never zero. Throws on a
meet-key mismatch.

**Seed facts:** `scyValue` returns a value, not its swim
(`results.ts:399-407`), so `captureReportFacts` finds the swim itself; on a
tie between a recorded and a converted swim it picks the recorded one. A
test checks every seed equals `resolveLineup(...).value`. `scoreMeet` never
fills `Results.display`, so a snapshot's seed times need `facts`.

## 3. Storage: no `DB_VERSION` bump

New optional fields need no bump (precedent `migrations.ts:41-44`), which
also avoids the upgrade whose backup prompt (E3) is unbuilt.

- `LineupRecord` gains optional `tags?: { coach: readonly ScorerTag[];
  suggested: readonly ScorerTag[] }` (Results depend on tags,
  `main.tsx:157`) and `facts?: ReportFacts` (SwimCloud data). Add both to
  the allowlist (`validate.ts:433-434`). The validator runs `parseResults`
  and `parseReportFacts`. `withoutSwimCloudData` strips `facts`
  (`exportImport.ts:106-108`); import rule 2 rejects `facts` when the file
  says it has no SwimCloud data. A missing `tags` means "not recorded",
  never "no tags".
- Settings gains `rivalsByMeet: Record<meetKey, RivalRef>` (`RivalRef` from
  `autobuilder/types.ts:34`), added to `SETTING_VALUES` (`validate.ts:320`).
- `StorageRepo.putMany(ops)`: one readwrite transaction, every rev checked,
  all or nothing.
- Undo (`storage/undo.ts`): in memory, per host, up to 50 entries. Each
  holds the "before" state of each key and the rev written after the change.
  Undo writes the inverse through `putMany`; if any rev changed, the whole
  undo is refused with "changed elsewhere". It covers tags, own team, preset
  choices, session edits, lineup save, rename and delete, and AutoBuilder
  Accept (U1 calls `recordUndo`). Before an Accept or a bulk tag clear the
  dashboard takes a snapshot automatically. Undo cannot revert the
  simulator's own entries: D4 writes settings only.

## 4. Exports

- **CSV columns:** Team, Team ID, Gender, Event, Entry Type, Relay, Leg, Full
  Name, SwimCloud ID, Class, Seed, Seed (hundredths), Seed Basis (`recorded`,
  `estimated`, `no time`), Role, Place, Points (swimmer share). One row per
  relay leg. Points sum to the team total. No legacy `splitName` heuristic.
- **Encoding:** UTF-8 BOM, CRLF, a final CRLF. No `sep=` line (Excel then
  ignores the BOM).
- **Quoting:** quote a cell holding `"`, `,`, `\r`, `\n`, or a leading or
  trailing space (the legacy escaper misses `\r`, `entryExport.ts:103`).
- **Formula guard:** prefix `'` on a text cell starting with `= + - @`, tab
  or CR. Numeric columns are numbers and never guarded.
- A snapshot with no `facts` refuses the CSV and says why. Issues show before
  the download (as `entryExport.ts:54`).
- Download: Blob + `<a download>`, `text/csv;charset=utf-8`. No network
  request, no `downloads` permission.
- Report: a React view from the functions above, printed with
  `window.print()` and `@media print`, always in light tokens. No HTML
  strings.

## 5. Theming

- The dashboard reads `settings.theme` (today it calls `bindTheme` with no
  preference, `main.tsx:100`) and follows the change bus. It sends the page
  panel a new `panelProtocol` message `theme-state {preference, accent?}`
  (the overlay already accepts it, `overlay.ts:39`).
- Custom accent: `applyAccent` sets `--osx-accent` inline (`theme.ts:157`),
  which overrides the dark block's lightened accent (`theme.ts:106`). Set
  `--osx-accent-user` instead. Light: `var(--osx-accent-user, #1565C0)`.
  Dark: `color-mix(in srgb, var(--osx-accent-user, #1565C0) 65%,
  CanvasText)`. Compute `--osx-accent-fg` per theme. The accent validator
  must require `#rrggbb` (it accepts any string today, `validate.ts:322`).
- Chart lines: own team in the accent, thick; the rival `--osx-fg`, thick,
  dashed; others `--osx-fg-muted`. Never good or bad colors.
- **Blocked on user question E2:** only dark `--osx-good` and `--osx-bad`
  (`CanvasText` today, `theme.ts:108,111`). Until then dark mode never tells
  a state apart by color alone; every status and diff delta also carries a
  word or a sign.

## 6. No Recharts in P7

Measured with esbuild in memory: React-only base 607 KB (193 KB min); with
Recharts 1,485 KB (538 KB min), so +878 KB (+344 KB min). `dashboard.js` is
1,257 KB today, so about +70%. An iife bundle cannot be split, so the docked
iframe would load it on every simulator page view, plus 20 transitive
packages. Build a plain SVG `ScoreChart.tsx` whose colors are CSS variables
(a theme switch needs no re-render hook, unlike `MomentumChartCard.tsx:9`).
If Recharts is chosen anyway (user question F3), pin `"recharts": "3.8.1"`.

## 7. Slices

| # | Scope | Acceptance | Provider |
| --- | --- | --- | --- |
| C1 | `packages/engine/src/report/**`, root `index.ts` exports, `tests/engineReport*.test.ts` | Section 2 rules; the 1e-9 and exact-quarter tests; swimmer totals sum to the team; recorded beats converted on a tie | claude:executor; codex review |
| C2 | `apps/extension/src/storage/{schema,validate,exportImport,repo,undo}.ts`, `tests/extensionStorage*.test.ts` | Round trip keeps `facts` and `tags`; default export strips `facts`; `putMany` all or nothing; a stale undo writes nothing | claude:executor; codex review |
| U-a | `dashboard/main.tsx` split into a `Shell` with slots, `dashboard.css`, `shared/theme.ts`, `panelProtocol.ts`. After U1-a lands, serially with U1-b. | The planner works in its slot; the theme switches tab, iframe and page panel | codex |
| U-b | `dashboard/ScoreChart.tsx` | Markup matches for both themes; the "simulator order" label shows | cursor |
| U-c | Snapshots, diff and undo UI | Harness: save, diff, undo, then "changed elsewhere" | codex |
| U-d | Report and CSV views, print CSS | Opens in Excel: "José" reads back; `1:52.34` reads back as written | claude:worker |
| U-e | Settings: cut threshold, storage estimate, backup export and import; Presets view | Harness: change each setting, export then import a backup, round trip equal | codex |
| F | Gates, visual check in both themes | Full gates green | claude:finisher |

## 8. User questions

F1 to F3 in `QUESTIONS_FOR_USER.md`: the rival default, whether restoring a
snapshot writes back into SwimCloud, and Recharts versus a custom chart.

## Amendment 1 (lead rulings, 2026-10-31, slices C1 and U1-b)

1. **`diffResults`** returns the shape of `ScenarioDiffResult`: per-swimmer
   rows (a relay stays one row), per-event rows and team totals. An absent
   side reads `null`, never 0. A meet-key mismatch throws `ReportDiffError`
   with code `meet_key_mismatch`. Time changes come from `lineup.display`,
   so a record stripped of SwimCloud data shows no time changes (U-c must
   say so).
2. **CSV.** A dive seed prints as points ("250.00"). A missing swimmer name
   or a missing result row is a `CsvIssue` (`name_missing` and the like),
   never the swimmer id or a blank. Seed stays a text cell until U-d's Excel
   check settles "1:52.34".
3. **`ClassYearCode`** is derived from the model's own class-year type, so
   user question E1 changes one place.
4. **Keys.** A saved lineup's record uses `meetKeyFor(snapshot)` as its
   store key. Its payload keeps the scoring key `'swimcloud-simulator'`, so
   it can be re-scored. Two copies of the `meetKeyFor` formula exist
   (`main.tsx:114`, `autoBuilderRequest.ts:36`); U-a keeps one.
5. **`StorageRepo.putMany` moved into U1-b.** AutoBuilder Accept needed an
   all-or-nothing write. C2 reuses `PutManyOp` from `storage/index.ts` and
   does not rebuild it.

## Amendment 2 (lead rulings, 2026-10-31, slice C2)

1. **Stored `results` stays unchecked.** It has always been stored as
   `unknown`, and older records or backups may hold other shapes. Strict
   checks on it would refuse a whole import (T-E3). Readers parse it at use
   time with the engine's `parseResults`. This overrides section 3, which
   said the validator runs `parseResults`.
2. **The new fields are strict.** `facts` runs `parseReportFacts`. Each tag in
   `tags.coach` and `tags.suggested` passes the tags store's own check.
3. **Shipped fixtures are never edited** (`tests/fixtures/extension-db/FROZEN.json`).
4. **Accent** must be `#rrggbb`. The only writer is a colour picker, which
   writes that form, so no stored value is expected to break. If an older
   backup holds another form, its import is refused with the path.
5. **Undo** (`storage/undo.ts`, `createUndoStack(repo, limit = 50)`):
   `recordUndo({changes})`, `undo()` returns `undone`, `empty` or `changed
   elsewhere`. It writes the inverse through `putMany` with the revs written
   after the change. Not wired into the UI yet (U-c).

## Amendment 3 (lead rulings, 2026-10-31, slice U-a)

1. **Dive scores in stored display text.** The adapter writes a dive seed as
   points with two decimals ("504.60"). The lineup validator accepts that
   form only for an individual entry key whose event is diving, and the
   text must equal `hundredths` exactly. A swim key keeps `parseTimeText`,
   so a swim written as "75.00" is refused. Before this, Save failed on
   every recorded meet, because each has a diving event.
2. **New engine root export `isDivingEvent`.** The extension may import only
   the engine root (D2 0.4). It is additive.
3. **Rival tie-breakers.** F1's rule comes first: the nearest final points,
   then the team above yours. Rank, then team id, break any tie that is
   left, so the pick is deterministic.
4. **A missing total is never drawn as zero.** ScoreChart stops a team's
   line at a gap, shows a visible note, and writes "missing" in the
   legend, the table and the aria label.
5. **Suggested tags lose `source` on Save.** The tag schema has no `source`
   field. The category is kept.
6. **Moved to U-c:** lineup save, the diff view and Undo.
7. **New slice U-e:** the Settings cut threshold, storage estimate, backup
   export and import, and the Presets view (section 1 items U-a left out).

## Amendment 4 (lead rulings, 2026-10-31, slice U-c)

1. **A saved lineup opens no report, chart or diff.** Only a snapshot holds
   results (`validate.ts`, D3). A lineup can be edited, and results come
   from SwimCloud for one moment. Meets lists the lineup and says: "A saved
   lineup has no results. Save a snapshot to see its report and compare
   it." The diff picker offers snapshots only. This narrows section 1.
   User question F4 asks whether to re-score lineups instead.
2. **A saved lineup keeps its tags and seed facts**, which the validator
   allows on any record. It drops only `results`.
3. **Undo covers snapshot save and lineup save only.** AutoBuilder Accept
   can delete a tag. A deleted row has no rev, and `putMany` cannot expect
   an absent row, so an undo could overwrite a tag made elsewhere. Accept
   stays out of Undo until `putMany` gains that check (follow-up
   `undo-accept-expect-absent`, user question G2).
4. **Diff order follows the save time**, not the order the coach picked
   (`orderForDiff`).
5. **A meet-key mismatch reads in plain words** and names the code:
   "These two records come from different meets, so they cannot be
   compared (meet_key_mismatch)."

## Amendment 5 (lead rulings, 2026-10-31, slice U-e)

1. **Clear cache deletes all fetched SwimCloud data** (`swimmerHistory` and
   `rosters`), not records past an age. D3 5.7 says "by age" but names no
   age, and none is invented. User stores are never touched.
2. **A backup includes settings by default.** Settings hold the coach's
   team, rules, schedule and rival for each meet. SwimCloud data stays out
   by default, as D3 says; a checkbox includes it, and the page says a
   default backup carries IDs only.
3. **The cut threshold is live.** The page panel's cut tags read
   `cutCloseThresholdPct` (default 1.0, R11). Before U-e they used 0, so no
   swim was ever tagged "close".
4. **Presets is read-only.** It lists built-in and user presets, each user
   copy's base, and "v<n> available" when the built-in is newer.
5. **The conflict choice comes before the file input**, because choosing a
   file starts the import.
