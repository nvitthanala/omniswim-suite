# Round 4 (2026-09-02): arbitrage math, entry-limit double count, alias misclassification

**Started:** 2026-09-02. **Status:** in progress — see [PROGRESS.md](PROGRESS.md) for the
live log (kept current in case of a rate-limit interruption; resume by reading that
file first).

## Context that shapes the plan

Five cyclomatic-complexity refactor commits landed 2026-08-31, immediately before this
round, all in the scoring/roster-correctness core:

| Commit | Function cut | File |
| --- | --- | --- |
| `639af9b5` | `planAutoAliasLinks` 95→9 | `athleteAliases.ts` |
| `3e2738a0` | `importHistoryToRoster` 74→9 | `historyImportRoster.ts` |
| `08e20c20` | `buildTeamLineupAudit` 40→7 | (lineup audit) |
| `4a83d2c2` | `applyScoringTheory` 48→9 | (scoring theory) |
| `568089cc` | `computeScenarioDiff` 46→2 | (scenario diff) |

All three user-reported bugs sit in or directly adjacent to this list — particularly
Bug A (aliasing) and Bug B (entry counting), which sit right on top of
`historyImportRoster.ts` and `athleteAliases.ts`. **Each commit claims a byte-identical
golden-output harness verified the refactor.** Treat that claim as a hypothesis to
re-check against the *current* repro, not as proof the commits are innocent — a harness
only covers the scenarios it was fed, and "Oliver Pozvai" / "Alan Gonzalez" misclassifying
as recruits was already fixed once before (CLAUDE.md, "Known Bugs & Follow-up Items
(2026-07-19 round)", item 2) — its recurrence now is evidence for a regression, not a
new discovery, so start by diffing pre/post-refactor behavior on this exact repro before
doing a from-scratch investigation.

## Bug A — aliasing misclassifies existing swimmers as new recruits after history import

**User repro:** Oliver Pozvai, Alan Gonzalez — both already on the roster (meet results
or a prior recruit row) end up reclassified as `new_recruit` after an athlete-history
import. Extend the check across the roster; these two are examples, not the full list.

**Prior fix (now possibly regressed):** CLAUDE.md item 2 — the fuzzy matcher itself was
fine (Alan Gonzalez ↔ Alan Alejan Gonzalez Mujica scored 90%); the bug was that alias
*link suggestions* only surfaced for `new_recruit` rows, so an athlete already misfiled
under a long-form name never got offered a link. Confirm that fix is still intact before
looking elsewhere.

**Key files:**
- `packages/core/src/lib/historyImportRoster.ts` — `resolveImportIdentity`,
  `classifyImportAction`, `isConfidentRosterMatch` (`ROSTER_MATCH_CONFIDENCE = 0.7`),
  `previewHistoryImportActions`. Note the refactor commit's own confession: *"an
  isExistingRecruit branch that's unreachable on current data (recruits already appear
  in the roster-name set that gates it, so it always evaluates true) but would matter
  again if that changed"* — check whether current data now takes that branch.
- `packages/core/src/lib/athleteHistory.ts` — `matchAthleteToRoster` (the fuzzy scorer
  `classifyImportAction` gates on) and `suggestAliasCandidates`.
- `packages/core/src/lib/athleteAliases.ts` — `planAutoAliasLinks`, `dispositionForPair`,
  recently refactored (`639af9b5`); diff it against its parent commit if the repro traces
  here.
- `packages/manager/src/components/AthleteHistoryImportPanel.tsx`,
  `RosterImportWizard.tsx`, `AliasSuggestionsPanel.tsx`.

**Acceptance:** Oliver Pozvai and Alan Gonzalez (and any roster athlete found in the same
state) import as `history_matched`/`add_to_lineup`/`already_recruit`, never `new_recruit`,
when they already have a meet-result row or recruit row under any linked/matchable
spelling. `scripts/test_history_import_roster.mjs`,
`scripts/test_athlete_aliases.mjs`, `scripts/test_duplicate_athletes.mjs` green, plus a
new regression fixture reproducing Oliver Pozvai / Alan Gonzalez by name.

## Bug B — entry-limit counting double-charges a prelims+finals swim

**User repro:** a swimmer who swims prelims then qualifies for/swims finals in the same
event should be charged ONE entry against `maxTotalEntriesPerSwimmer`, not two.

**Investigation note:** `countSwimmerEntries` in `swimmerEntryLimits.ts` already dedupes
individual entries by `event` string (a Set keyed on `r.event?.trim()`), which on its
face should already collapse a prelims row + finals row sharing one event label to one
entry. So the double count is either (a) a place where prelims/finals rows for the SAME
swim carry *different* `event` strings and defeat that Set, or (b) a DIFFERENT counting
path — the credited-swims / entry-limit UI may not route through
`countSwimmerEntries` at all. Find the actual double-counting code path before assuming
the fix is "filter to prelims-only rows"; the correct invariant is **one entry per
distinct event, regardless of round**, not literally "only count prelims."

**Key files:**
- `packages/core/src/lib/swimmerEntryLimits.ts` — `countSwimmerEntries`,
  `swimmerExceedsEntryLimits`, `formatEntryLimitLabel`, `canAcceptAnotherEntry`.
- `packages/core/src/lib/historyImportRoster.ts` — `countExistingEntries` (a second,
  independent implementation of the same "one entry per distinct event" rule — good
  reference, or itself a second place carrying the same bug).
- `packages/core/src/lib/scorerRoster.ts` — `AthleteCreditedSwim` builder (feeds the
  credited-swims panel; check whether it emits one row per swim-round rather than per
  entry, and whether whatever consumes it for the entry-limit label counts rows instead
  of deduped events).
- `packages/manager/src/components/AthleteCreditedSwimsPanel.tsx`,
  `AthleteCreditedSwimsRow.tsx`, `AthleteEntriesSection.tsx`, `TeamRosterPanel.tsx`,
  `RosterLineupStep.tsx`.
- `packages/core/src/lib/rosterLineupAudit.ts` — the entry-limit checklist item.

**Acceptance:** a synthetic swimmer with a prelims row and a finals row in the same event
(distinct ids, `roundSwam` differing) counts as one entry everywhere the total-entry cap
is enforced or displayed. `scripts/test_entry_limits.mjs`,
`scripts/test_entry_limits_aliases.mjs` green, plus a new fixture with an explicit
prelims+finals pair for one swimmer/event.

## Bug C — point arbitrage produces non-grid point values

**User framing:** arbitrage points should reflect "potential points gained from the new
event minus points lost from the dropped event" and should land on the scoring grid
(whole or half points), not the "wonky" values currently shown.

**Known-good baseline — do not re-derive from scratch:**
`plans/2026-08-14/WORKLOG-01-arbitrage-units.md` already replaced a fabricated
`seconds × 2` heuristic with `deltaPoints = newTotal − baseTotal` via a genuine
full re-score (`rankExactSwaps` in `arbitrage/exactSwaps.ts`), verified live
(claimed 40.5, observed 40.5 — exact match) and guarded by
`scripts/test_arbitrage_units.mjs` / `test_arbitrage_never_loses.mjs`. Confirm whether
that path is still what the UI renders before assuming the whole model is wrong — the
"wonky" numbers are more likely a narrower regression (see suspects below) than a repeat
of the original fabricated-seconds bug.

**Suspects, roughly in order of likelihood:**
1. A UI surface that does NOT route through `rankExactSwaps` — check every panel under
   `packages/manager/src/components/crossCourseArbitrage*.tsx` and
   `CrossCourseArbitragePanel.tsx` for a second, older, or ad hoc points computation.
2. Floating-point residue surfacing in display (`.toFixed(3)` in `exactSwaps.ts` keeps 3
   decimals — confirm the render layer formats to 1 decimal / snaps to the grid rather
   than showing raw noise like `40.503`).
3. `buildFastSwapContext`'s self-validation (`shared.ts`, `sweepTeamIndividualTotal` vs
   real baseline, gated at `Math.abs(sweepBase - realIndivT) > 1e-4`) silently disabled
   or silently passing when it shouldn't, letting a wrong fast-path number through.
4. Fallout from `applyScoringTheory` / `computeScenarioDiff` / `buildTeamLineupAudit`
   refactors landing 2026-08-31, if the arbitrage panels consume any of those.
5. Aliasing (Bug A) inflating one athlete's history-derived best times — the worklog
   already flagged this by name for `Alan Alejan Gonzalez Mujica`. This is why Bug A
   should land first.

**Key files:** `packages/core/src/lib/arbitrage/{shared,exactSwaps,crossCourseTable,
dropAdd,relayLegSwaps}.ts`, `rosterArbitrage.ts`, `crossCourseArbitrage.ts`,
`crossCourseArbitrageClient.ts`; `packages/manager/src/components/
CrossCourseArbitragePanel.tsx` and `crossCourseArbitrage{View,Sections,Body,Parts}.tsx`.

**Acceptance:** every displayed arbitrage point value is a genuine
`newTotal − baseTotal` team delta from a real `calculatePoints` re-score, and is a
multiple of 0.5 to floating-point epsilon (points table entries are integers; only tie
splits produce halves). `scripts/test_arbitrage_units.mjs`,
`test_arbitrage_never_loses.mjs`, `test_cross_course_arbitrage.mjs`,
`test_fast_swap_context.mjs` green, plus a new grid-snap assertion if none currently
exists.

## Delegation sequence

Run **sequentially**, not in parallel, despite mostly-disjoint file scopes — Bug C's
worklog explicitly says the aliasing fix should land before arbitrage numbers are
trusted, and quota-safety favors a checkpointed commit after each bug over three
concurrent Opus agents burning the same 5-hour window.

1. **`executor` — Bug A (aliasing).** Brief includes this doc's Bug A section verbatim,
   repro names, and the CLAUDE.md item-2 history. Must report root cause + final API
   surface before I commit.
2. **`executor` — Bug B (entry limits).** Runs after A lands (A touches identity
   resolution B's counting depends on). Same reporting contract.
3. **`executor` — Bug C (arbitrage).** Runs after A and B land, per the worklog note.
4. **`finisher`** — full `npm run lint` / `npm test` / `npm run build` pass after each
   bug's commit (not just at the end), so a failure is attributable to one bug, and
   again at the very end for the combined diff.

I (orchestrator) commit after each finisher-verified bug, so the branch is resumable at
a green checkpoint if the session hits a rate limit mid-round.
