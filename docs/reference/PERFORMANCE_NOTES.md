# Performance Notes

Targeted render/parse performance pass for large championship workspaces
(hundreds of result rows per gender, ~500 `athleteHistory` swims, ~90 recruits,
~50 planned entries — see the seeded "HSU 2026-27 Roster Plan" workspace).

Goal: keep the just-restyled UI identical in look and behavior while removing
per-render / per-keystroke work on the hot paths. No visual, theming, or chart
changes. Every change below is a pure referential-stability / memoization /
offscreen-skip win — no public API shapes changed.

---

## 1. `packages/core/src/lib/utils.ts` — `convertTimeToSeconds` memo cache

**Cost:** `convertTimeToSeconds` is a pure `string -> number` parse called inside
tight sort/group comparators — `calculatePoints` (grouping keys, `roundTierSort`
tie-breaks, recruit interleave sorts), relay grouping, and per-swimmer rows in
`TeamCard`. On a championship meet the same handful of time strings are split and
`parseFloat`-ed thousands of times per scoring pass.

**Fix:** Added a bounded module-level `Map<string, number>` cache (cleared past
20k distinct keys). The function stays pure and deterministic (including the
`NT`/`DQ`/`Infinity` and `NaN` cases), so memoizing is safe. Removes redundant
`split`/`parseFloat` work in the scoring worker and in matrix render rows.

## 2. `packages/manager/src/components/TeamRosterPanel.tsx` — stabilize `merged`

**Cost:** `const merged = mergeScoringSettings(settings)` ran on every render and
`mergeScoringSettings` returns a **fresh object each call** (`{ ...DEFAULT, ...settings }`).
`merged` is a dependency of the `{ rows, autoLookup }` `useMemo`, which calls
`buildScorerRosterLookup` **twice** over all `genderResults` (hundreds of rows).
Because `merged` changed identity every render, that memo — and everything
derived from it (`teamRows` sort, roster window) — recomputed on **every**
workspace patch / keystroke that re-rendered the panel.

**Fix:** `const merged = useMemo(() => mergeScoringSettings(settings), [settings])`.
The roster-lookup memo now only reruns when `settings`, `genderResults`,
`overrides`, or `gender` actually change. (`officialForGender` was checked and
left as-is — `officialScoresForGender` returns the stable nested `official.men`/
`official.women` reference, so its `useMemo` was already stable.)

**Left alone deliberately:** The windowed row body already virtualizes to ~visible
rows via the existing `ROSTER_WINDOW_THRESHOLD` slice, so per-row calls
(`countSwimmerEntries`, `getAthleteProfile`) are bounded and were not touched.

## 3. `packages/manager/src/components/AthleteMeetEntriesPanel.tsx` — memoize entry counts

**Cost:** `allResults` spread the full men/women result arrays (hundreds of rows)
and `countSwimmerEntries` scanned them on **every render** — including each
keystroke in the paste `<textarea>` and the per-entry time `<input>`s, none of
which affect the counts.

**Fix:** Memoized `athletePlans`, folded the `allResults` build into a `counts`
`useMemo` keyed on `[gender, workspace.menResults, workspace.womenResults,
athletePlans, team, athleteName]`, and memoized `over` on `[counts, settings]`.
Typing in the time/paste fields no longer rebuilds and rescans the result set.

## 4. `packages/manager/src/components/AthleteHistoryImportPanel.tsx` — parse in a transition + windowed preview

**Cost:** A SwimCloud paste parses to ~850 preview rows. `parseLocal` committed
`setPreview`/`setWarnings`/`setFormatLabel` synchronously, so the whole ~850-row
table (plus derived `swimmerActions` badges) rendered as a blocking update that
froze the button/paste box. The preview `<table>` also rendered all ~850 `<tr>`
even though only a handful are visible inside the `max-h-56` scroll box.

**Fix (two parts):**
- Wrapped the preview-commit state updates in `useTransition`
  (`startPreviewTransition`). The parse itself is unavoidable synchronous CPU
  work on click, but deferring the commit keeps the input/buttons responsive
  while React renders the large table as an interruptible transition.
- Added `content-visibility: auto` + `contain-intrinsic-size: auto 37px` to each
  preview `<tr>` so the browser skips layout/paint for offscreen rows. All rows
  stay in the DOM and scroll exactly as before — zero visual/behavioral change,
  no row cap.

## Investigated and deliberately left unchanged

- **`ScoringTheoryPanel.tsx`** — the `preview` `useMemo` running `applyScoringTheory`
  is keyed on `[parsed, workspace, team, gender, classYearOverrides]`. Typing in
  the theory `<textarea>` only updates local `text` state (not `parsed`), so the
  memo does **not** rerun on keystrokes — already correct. No change.
- **`packages/matrix/src/components/TeamCard.tsx`** — already `React.memo` with the
  heavy derived data (`eventData`/`classData`/`topSwimmers`/`topEvents`) behind
  `useMemo`s with correct deps. Left untouched. Its parent (`MeetOperationsView`)
  passes an inline `onUpdateTime` arrow, but that closes over `workspace` (new
  every edit) and `searchQuery` is already a per-keystroke prop to `TeamCard`, so
  memoizing the callback would not prevent the re-renders that matter — not worth
  the churn/risk.
- **`MeetDiffTable.tsx` / `PrelimsDiffTable.tsx`** — build a couple of `Map`s and a
  sort in the render body, but only over team-count rows (dozens), and the
  `searchQuery` filter legitimately must recompute per keystroke. Not a hot path
  at these sizes; left as-is.
- **`IndRelayManagementView.tsx`** — `activeSwimmers`, `stats`, `relayGroups`,
  `poolCandidates`, and split comparisons are already behind `useMemo`s with
  correct deps. No unstable-dep or in-render-sort issues found.
- **`LineupComplianceChecklist.tsx`** — renders only the (small) set of compliance
  issues; `grouped` is memoized. Cheap; left as-is.
- **`useWorkspaceScoring.ts` / provider** — scoring already offloads to the Web
  Worker and the derived `*ByTeam` maps / timelines are memoized on the snapshot
  signatures. Per the constraints the provider shape was not restructured; the
  `convertTimeToSeconds` cache (#1) is the referential/JSON-churn win that also
  benefits the worker path.

## Verification

- `npm run lint` — pass
- `npm run build` — pass
- `npm test` — see run log (Playwright e2e requiring a dev server skipped)
