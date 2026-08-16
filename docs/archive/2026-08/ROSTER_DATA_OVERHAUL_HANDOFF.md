> Archived 2026-08-16. Kept for the reasoning it records; may not reflect current behaviour.

# Roster Data & UI Overhaul — Handoff

> Companion to `ROSTER_LINEUP_PROGRESS.md`. Covers the 2026-07 overhaul: multi-athlete
> SwimCloud import, SCM/LCM→SCY conversion with distance remapping, scoring-theory
> import, class-year overrides, the suite-wide UI modernization, and the HSU 26-27 seed.

Last updated: 2026-07-18.

## 1. Data pipeline

### Multi-athlete SwimCloud paste (`packages/core/src/lib/swimCloudMultiProfile.ts`)

`parseSwimCloudMultiProfile(text, { team, gender, division? })` splits a concatenation of
SwimCloud "Personal Bests" profile pastes into per-athlete blocks. A block is a bare name
line (no tabs, diacritics preserved — "Máté Hosszú", "Olivér Pózvai") followed by
tab-separated `Event\tTime\t[stamp]\tMeet\tDate` rows. Embedded
`Event\tTime\t\tMeet\tDate\tStamp Link` header rows are skipped; orphan rows before any
name and empty blocks produce warnings, never throws.

`detectSwimCloudPasteFormat` now returns `'multi_profile'` for such pastes, and
`parseSwimCloudPasteDetailed` routes them automatically — so the existing Manager
**SwimCloud import** panel accepts a whole-roster paste with no extra steps.

### SCY conversion & distance remapping (`packages/core/src/lib/utils.ts`)

- `convertToSCY` (unchanged): time-only conversion using `CONVERSION_FACTORS`
  (`packages/core/src/constants.ts`).
- **New** `convertSwimToSCY(event, time, gender, timeType) → { event, time }`: also remaps
  event identity — 400 Free LCM/SCM → **500 Free**, 800 → **1000**, 1500 → **1650** — so a
  European distance swim competes in (and can fill) the correct SCY event slot instead of
  creating a phantom event.
- **Non-destructive by design**: `athleteHistory` rows always keep the original
  `time` + `timeType` (+ meet/date). Conversion happens on read. This is what preserves
  raw data for event arbitrage.
- `foldDiacritics(s)`: used for name comparison (never for stored display names).
- 50s of stroke have no dedicated factors; they intentionally fall back to the matching
  100-event factor.

### Program-event filter (`isChampionshipProgramEvent`, `athleteHistory.ts`)

Lineup candidate generation only considers championship-program events
(50/100/200/500/1000/1650 Free, 100/200 strokes, 200/400 IM, relays). 25-yard events,
100 IM, diving, and odd relay-split distances stay in history but are never auto-entered.

### Class-year overrides

`importHistoryToRoster(workspace, swims, opts)` accepts
`classYearOverrides?: Record<string, ClassYear>` (name-keyed, matched
diacritic-insensitively). Only overridden swimmers are affected; everyone else keeps
existing class years (new recruits default to `HS` as before). The Manager import panel
exposes per-swimmer class-year selects in the paste preview and passes them through.

### Scoring-theory import (`packages/core/src/lib/scoringTheory.ts`)

`parseScoringTheory(text)` parses the hand-written plan format
(`possible_hsu_scoringteam2627.txt` style):

- Relay sections (`800 FR` / `200 MR` … with `A name, name, name, name` squads; a leg may
  list alternates: `Colton/Hunter/Alan` → first is chosen, alternates recorded).
- Per-swimmer event lists — `Bartu Akin (1000, 4IM, 500, 1650)` — via `expandEventToken`
  (`1fly`→100 Fly, `2br`→200 Breast, `4IM`→400 IM, bare `50/100/200`→Free, `?`→skip, etc.).
- An `Other possibilities:` section (kept as notes, not entries).

`resolveTheoryName(rawName, rosterNames)` matches nicknames/misspellings/diacritics
("Beni"→Benedek BONA, "Mate Hozzsu"→Máté Hosszú, "Cam Mask"→Camden Mask, "Tristin F"→
Tristin Ferguson) with a ≥0.6 confidence floor; below that the name goes to warnings —
never guessed.

`applyScoringTheory(workspace, parsed, { team, gender, classYearOverrides? })` returns a
non-destructive workspace patch: scorer marks (roster mode only — requires NSISC-style
`scorerEligibilityMode: 'roster'`), `meetEntryPlans` from each swimmer's theory events
using best SCY-converted history times (individual entry caps respected; missing times
warned), and relay-leg fills via the existing `RelayLegOverride` structures.
**Relay legs attach to existing relay entries** — on a workspace with no loaded meet the
relay squads are reported as warnings and should be re-applied after loading a meet PDF.

### Manager UI wiring

- `RosterSourceStep.tsx` right column: `AthleteHistoryImportPanel` (multi-profile aware,
  with class-year selects) + **new** `ScoringTheoryPanel.tsx` (paste → parse preview with
  match/relay/warning readout → apply). Both respect What-if gating.

## 2. HSU 26-27 seed (`scripts/seed_hsu_roster.mjs`)

`npx tsx scripts/seed_hsu_roster.mjs [--dry-run]` parses the two local files
(`hsuroster26-27.txt`, `possible_hsu_scoringteam2627.txt` — local-only, not committed) and
upserts a **"HSU 2026-27 Roster Plan"** workspace into **both** stores (`data/meets.json`
and `data/omniswim.db`), so it appears under either `OMNI_DB` mode. Idempotent by
workspace name; workspace `conference: 'NSISC'` activates roster-mode scorer marking.

Seeded + verified (2026-07-18, incl. Curtis Malone added as FR): 32 athletes, 871 history
swims (best per event **per course**), 96 recruit rows, 54 theory entries, 18 scorers.
Class years: Alex Tarkovács FR, River Paulk JR, Máté Hosszú FR, Noel Kis FR,
Benedek BONA FR, Fabio Capocci FR, Curtis Malone FR; other 25 untouched.
Conversion spot-checks: Benedek 400 Free LCM 3:58.84 → 500 Free 4:26.31; Noel 50 Free SCM
22.10 → 20.02; Fabio 100 Back SCM 54.44 → 49.32.

Known caveats:

- Relay squads not materialized in the seed (no loaded meet) — use the Scoring Theory
  panel after loading a meet PDF.
- `mergeHistoryIndex` keeps the best time per event **per course** (SCY/LCM/SCM each keep
  their own best) — changed 2026-07-18 so the cross-course arbitrage view can compare an
  actual SCY swim against its converted LCM/SCM counterpart.
- Theory lists 4 individual events per swimmer; NSISC cap is 3 — the first 3 are entered,
  the 4th stays available in history (compliance checklist governs swaps in Lineup;
  each skip is warned explicitly).
- "Luka H" from the theory's Other-possibilities list has no roster data yet.

## 3. UI modernization (both themes + custom colors preserved)

Token layer (`packages/ui/src/index.css`): `--ui-radius-sm/md/lg/xl`,
`--ui-shadow-sm/md/lg` (theme-aware), `--transition-fast/base`,
`.text-heading-1/2`, global theme-aware `:focus-visible` ring. Prefixed `--ui-*`
deliberately — bare `--radius-*`/`--shadow-*` collide with Tailwind v4's internal theme
variables and would silently corrupt `rounded-*`/`shadow-*` utilities app-wide.

- **Shell**: nav pills/header unified on the radius scale, heading utilities adopted.
- **Matrix**: cards/modals/tables normalized (radius scale, hover transitions,
  `tabular-nums` on numeric columns).
- **Metrics**: fixed a real dark-mode gap — its `dark:` variant was keyed to a `.dark`
  class nothing sets, so dashboard/setup/player chrome rendered light in dark theme.
  Now uses shared `[data-theme]` tokens. In-video HUD intentionally stays dark.
- **Manager**: wizard step states (done/current/upcoming with check icons), arbitrary
  `text-[9-11px]` → `text-ui-*` scale, bare 4px `rounded` → scale, pill badges,
  row hovers, `tabular-nums` on time/score columns, theme-aware modal shadows.
- `TeamManagementSubTabs.tsx` is dead code (unreferenced since the wizard refactor) —
  candidate for deletion.
- Metrics keeps its own sky-blue `accent-*` sub-brand palette (deliberate; unifying it
  with the user accent is a design decision left open).

## 3b. Cross-course arbitrage view (Lineup step)

`packages/core/src/lib/crossCourseArbitrage.ts` (+ `crossCourseArbitrageClient.ts`,
worker op in `scoringWorker.ts`, tests in `scripts/test_cross_course_arbitrage.mjs`):

- `buildCrossCourseTable` — per swimmer × SCY program event: actual SCY best vs best
  converted LCM/SCM (source course/time/meet retained), flagging rows where the converted
  time beats the actual (`convertedWinsBy` seconds). 56 flags on the seeded HSU roster
  (e.g. Curtis Malone 100 Back: LCM 57.29 → 48.41 vs actual SCY 48.71).
- `rankExactSwaps` — full re-score enumeration (no heuristics): every candidate event ×
  current individual entry 1-for-1 swap gets a true `buildWhatIfResults` +
  `calculatePoints` team total; only positive deltas returned, descending. Droppable
  entries are the union of active plans (`dropSource:'plan'`), meet result rows
  (`'result'`, simulated exactly like the Manager's delete-credited-swim: filter the row
  by id), and recruit rows (`'recruit'`) — so a lineup loaded from a meet PDF gets the
  same "is this optimal" analysis as a planned one. Skipped entirely (with
  `pointsMeaningful: false` + reason) when the workspace has no opposing field —
  the UI then shows times-only with a guided note. Measured on HSU roster merged with
  the 2026 NSISC Championships field: 936 candidates, 94 positive swaps, ~3.5 s in the
  worker (top finding: HSU fields no 200 Back — any entry there out-points a crowded
  sprint-free slot; Colin's 1650 suggestion comes from his converted LCM 1500).
- `buildCoverageGaps` — program events with open team slots (pure counts, no guesses).
- `computeCrossCourseArbitrage` bundles all three; the client helper runs it in a
  short-lived scoring-worker instance (~1 ms standalone; ~0.65 s worst-case full
  enumeration on a 445-row field — hence the worker).
- **Incremental re-scoring** (2026-07-18): swap enumeration runs ~62× faster
  (3.65 s → 59 ms on the merged NSISC workspace) via a two-event overlay plus an explicit
  meet-wide scorer-pool sweep. Correctness is structural, not assumed: the fast context
  re-derives the baseline total two ways and silently falls back to the full re-score if
  they disagree (also for PDF place-points, plan-sheet mode, per-event scorer caps, and
  non-scorer swap athletes). Equivalence tests assert fast === full on synthetic and
  realistic workspaces (`forceFullRescore` opt exists as a diagnostic hook).
- **`applyExactSwap(workspace, swap, {team, gender})`** → `{ patch, inverse,
  description }` — pure one-click-apply helper. Drops by source (plan id / result row id /
  recruit id — same semantics as the Manager's delete-credited-swim), adds an active
  optimizer plan; `inverse` round-trips exactly (tested) and powers undo.
- **Recency weighting**: candidate bests prefer times within `recencyMonths` (default 24,
  `DEFAULT_RECENCY_MONTHS`) of the newest dated swim in the workspace history (anchored on
  data, not wall clock; undated rows count as recent). Stale-only events keep their best
  flagged (`stale`/`addTimeStale`) rather than dropping data. Suppresses artifacts like a
  2019 age-group time driving a swap suggestion.
- UI: `CrossCourseArbitragePanel.tsx` under the compliance checklist in the Lineup step
  (jump-to-athlete; Apply/undo when What-if is on). Section order reflects priority:
  **Lineup optimization** (swaps grouped by athlete+event, entry-source chip, stale tags,
  tied drops collapsed to "N other drop options") → **Converted-time upgrades** (framed
  as the swap candidate feed) → **Coverage gaps**. `ScenarioSnapshotsPanel.tsx` below it:
  save/restore named lineup scenarios on the workspace-snapshot API (SQLite/Postgres
  backends only; saved projected totals embedded in labels for diff-vs-current chips;
  auto-backup snapshot before every restore).

## 4. Performance

See `PERFORMANCE_NOTES.md` for per-file costs and fixes. Highlights: bounded memo cache
on `convertTimeToSeconds` (hot in scoring comparators), stabilized `mergeScoringSettings`
identity in `TeamRosterPanel` (was rebuilding scorer lookups over hundreds of rows per
keystroke), memoized entry counts in `AthleteMeetEntriesPanel`, and `useTransition` +
`content-visibility: auto` rows for the ~850-row import preview table.

## 5. Verification

```bash
npm run lint            # all workspaces
npm test                # scoring/persistence/import/theory suites
npm run test:e2e        # Playwright chart render (starts dev server itself)
npx tsx scripts/test_multi_profile_import.mjs
npx tsx scripts/test_scoring_theory.mjs
npx tsx scripts/seed_hsu_roster.mjs --dry-run
```

Verified 2026-07-18: lint clean (7 workspaces), `npm test` 27 passed / 0 failed
(2 pre-existing fixture skips), Playwright chart e2e passing, and live Playwright drives
of the Lineup step confirming: arbitrage panel resolves with 54 converted-time upgrades +
STALE pills (Camden 200 Free correctly flagged), guided points note when no field is
loaded, scenario save → list → diff chip round-trip against SQLite snapshots.

### Known issues

- **Workspace-switch oscillation (pre-existing, app-level)**: switching the active
  workspace by clicking a row in the *Manager* workspace sidebar can leave the app in a
  state where the active-workspace object churns identity continuously (~170 ms cadence,
  observed as a snapshot-fetch storm ~40 req/s from both the shell sidebar and any
  workspace-keyed fetcher, and debounced effects never firing). A page reload fully
  settles it; switching via the Matrix workspace tabs + in-app nav does not trigger it.
  `SuiteWorkspaceProvider` itself looks sound (idempotent keep-valid effect, memoized
  activeWorkspace) — suspicion is a second selection writer fighting the provider.
  `CrossCourseArbitragePanel` is hardened against it (effect keyed on workspace *content
  fields* with a latest-props ref, so churn can't permanently reset its debounce), but
  the underlying trigger deserves a dedicated investigation.

## 6. Brainstorm — future improvements

Shipped from earlier rounds: cross-course arbitrage view, exact swap ranking over all
entry sources, one-click apply + undo, incremental re-scoring (62×), recency weighting,
lineup scenario snapshots. Still open, roughly in value order:

### Arbitrage / scoring

- *Relay-aware swaps*: extend the swap enumeration to relay leg substitutions via the
  existing `RelayLegOverride` machinery — NSISC doubles relay points, so leg arbitrage
  likely dwarfs individual swaps.
- *Field projection*: swap deltas currently assume last year's field returns unchanged.
  Age the opposing field (drop graduating seniors, apply improvement curves) for more
  honest next-season deltas.
- *Drop-only / add-only analysis*: pure "drop this entry" deltas cleanly flag over-cap
  situations (an over-entered swimmer voids all their points); "add without drop" shows
  open-slot gains for swimmers under cap.
- *Conversion confidence bands*: mark swaps whose winning margin is inside ~1% of a
  conversion factor as "verify in practice".
- *Taper/improvement curves*: replace the flat drop % in `calculateProjectedTime` with
  per-swimmer progression fitted from `athleteHistory` dates.
- *Dual-meet preset*: 6-lane scoring + 3 relays so the same pipeline works in-season.
- *Relay leg auto-fill from theory alternates*: promote the recorded alternate when a
  leg's primary is capped or soft-removed, with a checklist entry.

### Import & data

- SwimCloud roster *URLs* (server-side fetch + parse) to skip manual pasting.
- Import diffing: on re-paste, show which bests improved since the last import.
- Time-standard overlays (NCAA A/B, NSISC invite cuts) as import-preview badges
  (cutlines infra already exists in `data/cutlines`).
- "Load this meet here" shortcut: copy a meet's frozen results into another workspace so
  roster plans and scoring fields stop living apart (today: re-upload the PDF).

### UI / workspace

- Fix the workspace-switch oscillation (see Known issues) — highest-leverage stability
  item; likely also removes a hidden scoring-worker message storm during churn.
- Scenario diff drill-down: per-event/per-swimmer diff between a saved scenario and the
  current lineup, not just the total-points chip (restore-free compare by scoring the
  snapshot content in the worker). Also: disable Save until the scoring worker settles so
  a freshly-mounted page can't capture a transient total.
- Command palette (Ctrl+K) for jump-to-athlete/team/step.
- Keyboard-first lineup editing (arrow through athletes, type `expandEventToken`
  abbreviations).
- Delete stale Chart E2E workspaces automatically after `npm run test:e2e` (they
  accumulate in the sidebar).

## 7. AI-assisted development workflow (per project owner)

Standing instructions from the project owner for AI-driven work in this repo:

- **Fable acts as planner/orchestrator** — reads the codebase, makes the plan, splits and
  sequences the work, reviews/verifies results, and owns final integration. It should ask
  clarifying questions (data-file semantics, product intent, UI placement) *before*
  executing, and verify end-to-end (lint → `npm test` → live Playwright drive) after.
- **Opus subagents take the high-level/complex work**: core architecture, scoring/SCY
  conversion correctness, arbitrage/optimization logic, performance passes with
  correctness proofs, anything needing invariance reasoning or equivalence testing.
- **Sonnet subagents take the worker tasks**: UI formatting/restyles, panel wiring
  against an already-specified core API, boilerplate, docs polish.
- Sequencing rule of thumb: core (Opus) lands first with tests green, then UI (Sonnet)
  builds against the reported API; keep concurrent agents in disjoint package scopes
  (core+scripts vs ui/shell vs manager) to avoid conflicts.
- Hard constraints for every agent: never touch git state; keep Dark/Light/custom-color
  theming intact (tokens only, no hex); additive API changes only; `npm run lint` and the
  test suite must be green before reporting back.
