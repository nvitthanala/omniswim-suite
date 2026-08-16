> Archived 2026-08-16. Kept for the reasoning it records; may not reflect current behaviour.

# Matrix Rescore & Event-Identity Overhaul — Handoff (Round 2)

> Companion to `ROSTER_DATA_OVERHAUL_HANDOFF.md` (round 1). Covers the 2026-07-19 round:
> event-identity unification between imported roster data and loaded meet PDFs, the
> merged/PDF-only scoring toggle, the swim editor (plans / history / credited swims),
> relay-aware swap enumeration, the workspace-switch oscillation fix, and the
> import-diffing / load-meet-here additions.

Last updated: 2026-07-19.

## 1. The core problem this round solved

Scoring event identity was the raw event string. Meet-PDF rows are HyTek-labeled
(`Event 24 Men 100 Yard Backstroke`) and sort by event number
(`eventMeetSortKey`, default 99999 for anything else); imported athlete-history entries,
recruits, and `meetEntryPlans` carry canonical labels (`100 Backstroke`). The scoring
engine grouped by exact string, so every imported entry scored in a **phantom event
group** — never competing against the PDF field — and those phantom events clumped at the
end of the matrix ("extra events"). On the HSU + NSISC-field workspace the gap is large:
**merged 1572.7 vs PDF-base 1056.0** for the lead team.

## 2. Core: event identity (`packages/core/src/lib/eventIdentity.ts`)

- `canonicalProgramEvent(raw)` — moved here from `crossCourseArbitrage.ts` (re-exported
  there; all old import paths still work).
- `buildMeetEventLabelIndex(results)` — canonical program event → the loaded meet's
  actual event label, per gender. Dedup when several meet labels map to one canonical
  event (prelims/finals variants): most result rows, then lowest `Event N`, then
  lexicographic. Deterministic.
- `computeVisibleEvents(events, allResults, genderPdfResults, settings)` — the meet
  program minus 25-yard events, 100 IM, time trials, and (when a meet is loaded) leftover
  canonical-only labels that matched nothing. Relays + diving always kept.

**Workspace field `scoringView?: 'merged' | 'pdf_only'`** (`types.ts`; absent ⇒ merged):

| | merged | pdf_only |
|---|---|---|
| meet loaded | plan/recruit/`replacesResultId` rows remap onto real meet event labels and compete for points; unmatched canonicals keep their label | plans + recruits excluded entirely; deletions / relay overrides / vacate-legs still apply |
| roster-only | label index empty ⇒ no-op; identical to prior behavior (HSU roster plan unregressed) | plans + recruits excluded ⇒ empty field |

Persistence: `scoring_view` column — SQLite `SCHEMA_VERSION` 4→5, PG `PG_SCHEMA_VERSION`
3→4 (`packages/db`: schema.ts, pgSchema.ts, workspacePersistence.ts, both services).
`data/meets.json` passes the field through untouched.

**`ScoringBundle.visibleEvents`** (additive next to `events`): what the matrix renders.
Totals are always computed over the full `events` set — visibility never changes points.
`useWorkspaceScoring`'s recompute effect now lists `workspace.scoringView` as a
dependency (one-click toggle rescore; the temporary matrix-side refresh-key workaround
was removed).

Tests: `scripts/test_event_identity_scoring.mjs`.

## 3. Core: swim editor (`packages/core/src/lib/swimEditor.ts`)

All functions return `WorkspaceEditorPatch = { patch, inverse, description }` — same
apply/undo contract as `applyExactSwap` (`applied = {...ws, ...patch}`, undo =
`{...applied, ...inverse}`; inverses round-trip deep-equal, tested).

- Planned entries: `addPlannedEntry`, `updatePlannedEntry`, `removePlannedEntry`.
  `activeEntryIds` is an allowlist **only when non-empty**; the helpers keep membership
  in sync with the plan's `active` flag.
- History swims: `addHistorySwim`, `updateHistorySwim`, `removeHistorySwim`.
  `HistorySwimRef`: prefer `{ id }` (editor-created rows get a uuid; additive optional
  `HistoricalSwim.id`), else content match (≥ name+event, diacritic-insensitive).
- Credited meet swims: `editCreditedSwim(ws, gender, resultRowId, {time?, event?})` —
  non-destructive, implemented as a `replacesResultId` overlay plan (raw PDF row stays
  byte-for-byte intact; merged-mode remapping composes for free).
  `removeCreditedSwim` — working-array id filter, exactly the app's existing
  delete-credited-swim semantics. Frozen `sourceMen/WomenResults` never touched.
- `copyMeetIntoWorkspace(source, target)` → `{ patch, description, warnings }` ("load
  this meet here"): copies menResults/womenResults/sourceMen/WomenResults +
  conference/scoringSettings/officialTeamScores/loadedMeet when present; never copies
  roster-plan fields. Warns on target overwrite (UI must confirm).

Tests: `scripts/test_swim_editor.mjs`.

## 4. Core: relay-aware swaps (`crossCourseArbitrage.ts`, `scoringTheory.ts`)

- `rankRelayLegSwaps(ws, {team, gender, settings?, recencyMonths?})` →
  `{ pointsMeaningful, reason?, swaps: RelayLegSwap[], candidatesEvaluated }`.
  Candidates stroke/distance-matched per leg (`relayStrokeForIndex`,
  `relayLegDistanceYards`); times from a recency-weighted `${legDist}|${stroke}` best
  index over `athleteHistory` (SCY-converted, stale-flagged). Constraints are
  engine-native only: roster-mode scorer requirement, `maxRelayEntriesPerSwimmer`,
  resolvability, and leg replaceability.
- `applyRelayLegSwap(ws, swap, {team, gender})` → `{patch, inverse, description}` via
  `RelayLegOverride`; sets `manualLegTime` to the departed leg's split so the relay
  clock holds constant (points are placement-based; `inTime` still shows the incoming
  swimmer's real projected split).
- **Engine finding worth remembering**: under default NSISC rules
  (`includeRelayLegsInFinals: true`) A/B-final relays are unconditionally eligible and
  placed by stored rank ⇒ leg substitutions on a healthy relay are provably zero-delta.
  Relay arbitrage pays only when an eligibility gate flips (vacated non-scorer leg,
  soft-removed swimmer, `includeRelayLegsInFinals: false`) — then the doubled relay
  points appear in the delta. On the seeded HSU+NSISC workspace: 0 replaceable legs ⇒
  0 swaps, ~17 ms (healthy state, not a bug).
- `suggestRelayAlternatePromotions(ws, {team, gender})` — theory alternates are now
  persisted on `RelayLegOverride.alternates` (filled by `applyScoringTheory`); suggests
  promoting the first available alternate when a leg's primary is soft-removed /
  over-cap / missing, each with a ready patch/inverse.

Tests: `scripts/test_relay_swaps.mjs` (deltas vs brute-force, doubled points on
eligibility flip, apply/inverse round-trip, promotions, medley stroke-correctness).

## 5. Shell: workspace-switch oscillation — FIXED

Root cause (not the suspected "second selection writer" in Manager):
`WorkspaceRouteSync` in `apps/shell/src/App.tsx` — its URL→state effect listed
`activeWorkspaceId` in its deps, so a state-first switch (Manager sidebar) made it read
the one-render-stale URL param and revert the selection while the state→URL effect wrote
the new one: a permanent swap loop (~40 snapshot req/s). Matrix tabs switch URL-first,
which is why they never triggered it. Fix: the URL→state effects read current selection
via refs and fire only on genuine URL-param changes (deps `[workspaceParam, workspaces]`
/ `[genderParam]`); the state→URL effect is the single URL writer. Same latent bug fixed
for gender. Verified live: 135 requests/3 s before → exactly 1 per switch after;
shared-URL/back-forward still work.

## 6. UI wiring

- **Matrix** (`MeetOperationsView`, `ScoringSettingsPanel`, `OpsModule`): renders
  `visibleEvents` (TeamCard `eventsList` + momentum builders) — on the HSU workspace 29
  events → 21 visible (7 time trials + 1 unmatched canonical hidden). "Scoring view"
  segmented control (Merged / PDF only) lives in the collapsible **Custom Scoring
  Logic** panel; persists via `onUpdate({scoringView})`. The global shell
  `ScoringSettingsModal` was deliberately not wired (would require shell edits).
- **Manager unified editor** (`AthleteLineupEditorPanel` — the only reachable editor
  surface; `editorMode="unified"` is the sole call site): planned-entry add/edit/remove/
  toggle-active via swimEditor, event editing added, embedded credited-swims editor and
  a collapsible "Supplemental history" section, shared per-athlete "Undo: …" chip.
  Legacy path (`TeamRosterPanel`/`RosterLineupStep`/`TeamManagementView`) routed through
  the same fns for parity. `AthleteCreditedSwimsPanel` gained inline edit (event + time).
- **Arbitrage panel** (`CrossCourseArbitragePanel`): new "Relay optimization" section
  after Lineup optimization — beneficial leg swaps (event, leg/stroke/distance, out→in,
  converted/stale pills, +delta) and alternate promotions, all through the shared
  apply/undo banner. Empty state is framed as healthy: "No beneficial relay
  substitutions — all relay legs are already scoring-eligible under current rules."
- **Import preview** (`AthleteHistoryImportPanel`): per-row diff badges — NEW /
  improvement delta (e.g. `-0.30s`) / SAME — keyed on folded name + team + normalized
  event + course, plus a "{n} new · {n} improved · {n} unchanged" summary above Import.
  Cut pills (A CUT/B CUT) existed already; now carry tooltips like "Beats NCAA D1 B cut
  (20.36)" via `getCutlinesForSwim`.
- **Load this meet here** (`LoadMeetHereCard` in `RosterSourceStep`): picks a sibling
  workspace with loaded results, calls `copyMeetIntoWorkspace`, always confirms with the
  overwrite warning before applying. What-if gated.

## 7. Verification (2026-07-19)

- `npm run lint` — clean, all 7 workspaces.
- `npm test` — **30 passed, 0 failed, 2 pre-existing fixture skips** (includes the three
  new suites and the Playwright chart e2e).
- Live Playwright drives: one-click scoring-view toggle rescore (merged 1572.7 ⇄
  pdf_only 1056.0, round-trip restores), no time-trial events rendered, no page errors;
  oscillation before/after (135 req/3 s → 1 per switch); manager editor + import diff +
  load-meet-here flows driven live by their agents.
- `scripts/test_chart_bundle.mjs` now skips tracked-but-deleted-on-disk files (needed
  because `TeamManagementSubTabs.tsx` was deleted from the working tree).

## 8. Known caveats / open items

- **Git state**: all changes uncommitted by design. `TeamManagementSubTabs.tsx` is
  deleted on disk but still tracked — commit with `git rm`.
- **Cutline data gaps**: only NCAA D1 A/B rows are populated (`packages/core/src/cutlines.ts`);
  D2/D3/NAIA arrays are empty and no NSISC-invite set exists — so NSISC-mapped teams
  never show cut badges. Data task, not wiring.
- `ScoringSettingsModal` (global shell settings) has no scoring-view control.
- Relay swap enumeration only proposes substitutions on replaceable legs (vacated /
  soft-removed); whole-squad reshuffles and relay *entry* add/drop are out of scope.
- Still-open §6 (round 1) items not chosen this round: field projection, drop-only/
  add-only analysis, conversion confidence bands, taper/improvement curves, dual-meet
  preset, SwimCloud URL fetch, command palette, keyboard-first lineup editing, chart-E2E
  workspace auto-cleanup, scenario diff drill-down.

## 9. AI-assisted workflow notes (this round)

Round executed per §7 of the round-1 handoff: Fable orchestrated (plans, sequencing,
integration fixes, final verification); Opus subagents did the core work (event
identity, swim editor, relay swaps, oscillation root-cause); Sonnet subagents did the UI
wiring (matrix toggle/visibility, manager editors, relay section, import/data); **Haiku**
joined for chores (dead-code removal, README staleness pass). Core agents ran
sequentially in `packages/core` to avoid conflicts; UI agents ran in parallel across
disjoint file scopes. Session-limit interruptions were resumed via agent transcripts
without losing work.
