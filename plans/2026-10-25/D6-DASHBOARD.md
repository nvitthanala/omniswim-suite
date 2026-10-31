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
| F | Gates, visual check in both themes | Full gates green | claude:finisher |

## 8. User questions

F1 to F3 in `QUESTIONS_FOR_USER.md`: the rival default, whether restoring a
snapshot writes back into SwimCloud, and Recharts versus a custom chart.
