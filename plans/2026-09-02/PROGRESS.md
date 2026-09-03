# Round 4 progress log — read this first if resuming after an interruption

Plan: [00-plan.md](00-plan.md). Update this file after every meaningful step (agent
dispatched, agent returned, commit made, test result). Newest entry on top.

---

## 2026-09-02 — round started

- Read `plans/STATE.md`, the 2026-08-14 review docs, `WORKLOG-01-arbitrage-units.md`,
  `swimmerEntryLimits.ts`, `prelimsProjection.ts`, `historyImportRoster.ts`
  (`classifyImportAction`, `resolveImportIdentity`, `countExistingEntries`),
  `athleteAliases.ts` refactor commit message, `SwimmerResult` type.
- Confirmed working tree has pre-existing unrelated uncommitted changes (silent-except
  removal in `backend/pdf_parser.py` / `point_calculator.py`, a `seasonAnalytics.ts`
  official-zero fix, 4 new untracked test files, `run-tests.mjs` registrations) — **not
  part of this round**, left untouched, not committed by this round's work unless the
  user asks.
- Wrote `00-plan.md`. Root-caused a strong lead for Bug A:
  `classifyImportAction`/`resolveImportIdentity` in `historyImportRoster.ts` gate
  "already known to the roster" on `isConfidentRosterMatch` (fuzzy score ≥ 0.7 via
  `matchAthleteToRoster`), and the `3e2738a0` refactor commit's own message flags an
  `isExistingRecruit` branch it says is "unreachable on current data ... but would
  matter again if that changed" — a plausible regression seam.
- Next: dispatch `executor` for Bug A.

## 2026-09-02 — Bug A dispatched

- Launched `executor` agent (opus, xhigh) for Bug A (aliasing misclassification),
  agent id `ae00765508f2ac20a`, running in background. Brief: reproduce Oliver
  Pozvai/Alan Gonzalez first, bisect against `3e2738a0~1`/`639af9b5~1` to confirm
  regression vs. pre-existing, fix root cause, add a regression test, report root
  cause + API surface + test/lint/build output. Told explicitly not to touch the
  pre-existing unrelated uncommitted diff (pdf_parser.py, point_calculator.py,
  seasonAnalytics.ts, run-tests.mjs existing entries) and not to commit.
- Waiting on this before dispatching Bug B (entry limits) — sequential by plan.

## 2026-09-02 — Bug A done, committed `a64143fc`

- Executor's root cause: **not** a refactor regression. `matchAthleteToRoster` in
  `athleteHistory.ts` had a pre-existing gap — exact match or raw substring
  containment only, no diacritic/comma-order folding — so "Oliver Pozvai" never
  matched the roster's "Olivér Pózvai" despite sharing an `aliasNameKey` (the
  codebase's own definition of identity elsewhere). Bisected against
  `3e2738a0~1`/`639af9b5~1`: identical behavior pre/post those refactors, so
  those commits are cleared as suspects for this bug.
- Fix: two new match tiers (folded-equality 0.95, folded-containment 0.7)
  between exact (1.0) and raw containment (0.7), strictly weaker so no existing
  match's answer changes. `recruitNameKeys`/`isExistingRecruit` now key on the
  same fold. Fixed a live silent-resolve in `classifyImportAction` (bare
  `match.match` read, ignoring confidence). Added `rosterReviewCandidates` so a
  `new_recruit` badge carries near-misses (e.g. Alan Gonzalez → Alan Alejan
  Gonzalez Mujica, a token-subset relation deliberately NOT auto-merged — two
  people can share that relation) for the existing alias-suggestions UI to act
  on.
- Verified myself (not just trusting the report): reviewed full diff, ran
  `test_roster_identity_match.mjs` (new, 10/10), `test_history_import_roster.mjs`,
  `test_athlete_aliases.mjs`, `test_duplicate_athletes.mjs` (all green), full
  suite via `node scripts/run-tests.mjs` (73 passed / 1 failed / 3 skipped —
  the 1 failure is playwright e2e, no browser binary installed in this
  environment, confirmed pre-existing and unrelated), `npm run lint` clean
  across all 7 workspaces.
- Committed `a64143fc`. Only `athleteHistory.ts`, `historyImportRoster.ts`,
  `run-tests.mjs` (+1 line), new `test_roster_identity_match.mjs`, and this
  plan dir were staged — pre-existing unrelated uncommitted diff (pdf_parser.py,
  point_calculator.py, seasonAnalytics.ts, 4 other new test scripts) left
  untouched as instructed.
- Residual findings from executor, not acted on (out of scope): `athleteAliases.ts`
  has a literal NUL byte at line 108 (`SCOPE_SEP = '\x00'`) — harmless at
  runtime but is why git/grep need `--text`/`-a` on this file; a paste with
  both spellings of one athlete yields two preview rows (cosmetic, write path
  verified safe); `rosterNames` passed to the matcher unresolved in
  `previewHistoryImportActions` (harmless today).
- Next: dispatch `executor` for Bug B (entry-limit double count).

## 2026-09-02 — Bug C verified and committed `d24fd3e5` — round complete

- Verified myself before committing: reviewed the full `utils.ts` diff plus
  the four comment-only auxiliary diffs (`rosterOptimizer.ts`,
  `test_tie_group_scoring.mjs`, `test_scorer_pool_cap.mjs`,
  `test_fast_swap_context.mjs` — confirmed no logic changes in any of them).
  Ran all 6 named arbitrage tests plus the new `test_recruit_placement_grid.mjs`
  (13/13) directly — all green. **Ran `test_nsisc_team_totals.mjs` myself**
  specifically to check the executor's "official scoring is untouched" claim:
  confirmed all seven published NSISC team scores still reproduce exactly
  (delta 0.00 on every one). Full suite: 75 passed / 1 failed (same
  pre-existing playwright/no-browser issue) / 3 skipped (pre-existing). Lint
  clean across all 7 workspaces, build exit 0.
- Committed `d24fd3e5`. Staged only `utils.ts`, `rosterOptimizer.ts`,
  `run-tests.mjs` (+1), new `test_recruit_placement_grid.mjs`, and the three
  comment-only test file updates, plus this progress file.
- **This finding was bigger than the arbitrage framing suggested.** Root
  cause was not in the arbitrage layer at all — `rankExactSwaps` and every
  arbitrage module were already correct. It was in `prepareRecruitsForScoring`
  (core scoring engine, `calculatePoints`'s recruit-placement step), which
  ranked each recruit alone against PDF-only comparators, so (a) on a
  roster-only workspace every recruit tied at rank 1 (whole event = one N-way
  tie), and (b) on a projected workspace it overwrote the correct placement
  `projectRanksInField` had already given a recruit row with a wrong one
  derived from a narrower field. This was previously flagged in
  `plans/2026-08-14/12` §2 as "STILL OPEN, not destructive" — it WAS
  destructive, just masked at the time by a separate, since-fixed, more
  catastrophic bug (total wipeout) that made the fractional-points damage
  hard to see. Confirmed the specific card the user would have seen:
  `Avery Henke +400 IM / -100 Fly` read **+8.667** (a fabricated 3-way tie),
  now reads **+7**.
- Residual findings from executor, not acted on (out of scope, both
  documented with a "STILL OPEN" note in the new code): a recruit row can
  still collide with a MEET row's placement in one narrow unprojected-workspace
  shape (no saved workspace currently reaches it); `buildFastSwapContext`
  returns null (falls back to full re-score, correctly slow not wrong) on the
  primary HSU workspace due to a pre-existing, unrelated shadowed-row gate.

### Round summary — all three bugs fixed and committed

| Bug | Root cause | Commit |
| --- | --- | --- |
| A — aliasing misclassified known swimmers as new recruits | `matchAthleteToRoster` had no diacritic/comma-order folding | `a64143fc` |
| B — entry limits double-charged a prelims+finals relay swim | relay entries keyed on a physical-swim identity (embeds round/rank/clock) instead of event identity | `0efcd602` |
| C — arbitrage showed non-grid ("wonky") point values | `prepareRecruitsForScoring` fabricated dead heats by ranking recruits without full-field or each-other comparators | `d24fd3e5` |

All three verified independently by the orchestrating session (not just
trusting agent reports): diff review, targeted test runs, full suite, lint,
build — before each commit. Pre-existing unrelated uncommitted work
(`backend/pdf_parser.py`, `backend/point_calculator.py`,
`packages/core/src/lib/seasonAnalytics.ts`, 4 untracked test scripts) was
left untouched throughout, as instructed to every agent.

<!-- Append new entries below this line, newest first. -->

## 2026-09-02 — Bug C done (arbitrage non-grid points), NOT committed

- **None of the five suspects was the cause.** The arbitrage engine is
  correct and always was. The wrong number comes from the scoring engine
  underneath it: `calculatePoints` fabricates dead heats.
- Root cause: `calculatePoints` (`utils.ts:1446`) re-derives a placement for
  every `isRecruit` row through `prepareRecruitsForScoring`, which ranks each
  recruit ALONE against the meet rows in its event. Two consequences, both
  putting rows with DIFFERENT times on one rank:
  1. It overwrites the placement `projectRanksInField` already assigned. That
     pass ranks the whole what-if field — meet rows, plans and recruit rows
     together — so on a projected workspace every row arrives already placed
     correctly, and the re-derivation replaces a right answer with a wrong one.
  2. With no meet rows there are no comparators at all, so EVERY recruit came
     back rank 1 and a whole event scored as one N-way tie.
  `scoreIndividualsInEvent` groups by event+round+rank and divides the place
  ladder across the group, so each fabricated tie pays fractional points.
- Measured before touching code, on `data/meets.json`:

  | workspace / gender | fabricated ties | team total |
  | --- | --- | --- |
  | Blank Workspace 1 / Men | 14 | HSU 1128.5 · OBU 911 · DSU 761 |
  | HSU 2026-27 Roster Plan / Men | 14 | **1066.3686902422194** |
  | OBU 2026-27 Roster / Men | 14 | **1114.597072467762** |

  Two of the three live workspaces show a projected team total that is not
  even a half point. The arbitrage card the user saw: `Avery Henke +400
  Individual Medley −100 Butterfly` **+8.667**, from a "tie" at 400 IM A-Final
  rank 7 between three swimmers timed 4:05.95, 4:07.75 and 4:09.18.
- After: **0** fabricated ties on every workspace, every total on the grid
  (HSU meet 1076, HSU roster plan 1299, OBU roster 1259), **0** off-grid
  arbitrage deltas out of 239 across every team and gender. That one card
  reads **+7**. All 12 HSU cards are now whole numbers.
- Fix, both halves inside `prepareRecruitsForScoring`: a row that already
  carries a placement keeps it (rank 0 = unplaced, positive = placed), and
  rows that still need one are placed against each other as well as the meet
  rows, sharing a place only on an exact time tie.
- **Official scoring is untouched.** `prepareRecruitsForScoring` only ever
  sees recruit rows, so a pure-PDF score never enters it —
  `test_nsisc_team_totals.mjs` still reproduces all seven published NSISC
  team scores exactly.
- Proved the new test fails on the old logic section by section before
  keeping it (17.667 ×3 instead of 20/17/16; 14 fabricated ties per workspace;
  the 8.667 card).
- Files: `packages/core/src/lib/utils.ts`, new
  `scripts/test_recruit_placement_grid.mjs`, `scripts/run-tests.mjs` (+1),
  plus comment corrections in `rosterOptimizer.ts`,
  `test_tie_group_scoring.mjs`, `test_scorer_pool_cap.mjs`,
  `test_fast_swap_context.mjs` (they described the collapse in the present
  tense as still-open). Pre-existing unrelated uncommitted diff untouched.
  No git operations run.
- Tests: all six arbitrage tests green; full suite **75 passed / 1 failed / 3
  skipped** (baseline 74/1/3, +1 is the new test, the 1 failure is the
  pre-existing playwright e2e with no browser binary). `npm run lint` clean
  across all 7 workspaces, `npm run build` exit 0.
- Residual findings, out of scope, NOT acted on:
  1. A recruit can still collide with a MEET row: the meet rows keep their own
     places, so a recruit placed 7th shares a rank with the real 7th finisher.
     Unreachable while the field is projected, so no saved workspace hits it —
     but deleting every planned entry from Blank Workspace 1 does: 18 such
     placements, e.g. River Paulk 19.42 (recruit) tied with Sam Ragsdell 20.22
     (meet row) for 18.5 each. Closing it means deciding that injected
     recruits re-place the meet field, a projection-gating change. Documented
     as STILL OPEN on the function and in the new test's header.
  2. `buildFastSwapContext` returns null on the primary workspace — the
     shadowed-row gate fires (13 collapsed cross-plane duplicates for HSU
     men), so `rankExactSwaps` runs 849 full re-scores, ~11 s. Fail-closed and
     correct, pre-existing and independent of this fix, but
     `test_fast_swap_context.mjs` only asserts engagement on synthetic
     fixtures, so it does not see this. Performance, not correctness.
  3. `projectRanksInField` gives equal times sequential ranks, so it never
     records a dead heat; `prepareRecruitsForScoring` now does. The two
     disagree on genuine ties. Nothing live depends on it.
- Next: `finisher` verification pass, then commit.

## 2026-09-02 — Bug B verified and committed `0efcd602`

- Verified myself: reviewed full diff (root cause + fix matches the report
  exactly — relay branch keyed on `relayEntryKey` embedding round/rank/clock,
  individual side already correct), ran all 4 relevant tests directly
  (`test_entry_limits.mjs`, `test_entry_limits_aliases.mjs` 9/9,
  `test_lineup_audit.mjs`, new `test_entry_limits_prelims_finals.mjs` 6/6,
  including its explicit "distinct relay events stay distinct, only round
  collapses" check — confirms keying purely on event name doesn't
  accidentally merge two genuinely different relay entries). Full suite:
  74 passed / 1 failed (same pre-existing playwright/no-browser issue) /
  3 skipped (pre-existing). Lint clean across all 7 workspaces.
- Committed `0efcd602`. Only `swimmerEntryLimits.ts`, `run-tests.mjs` (+1
  line), new `test_entry_limits_prelims_finals.mjs`, and this progress file
  staged.
- Residual findings from executor, not acted on (out of scope):
  `AthleteMeetEntriesPanel.tsx` merges `meetEntryPlans` with raw event labels
  with no remapper, so a plan event label that differs cosmetically from the
  matching meet-row label could double-count (a label-identity bug, not a
  round bug — `whatIfProjection`'s remapper already solves this elsewhere but
  this panel bypasses it); a real data defect in `data/meets.json` (Mark
  Eberhard, Event 39, two DQ rows same time — costs one entry correctly but
  worth a duplicate-scan flag).
- Dispatched `executor` for Bug C, agent id `ae904c538ef5d5823`, running in
  background. Brief: confirm which of 5 ordered suspects (parallel UI compute
  path, float/display residue, fast-swap self-validation gate broken,
  applyScoringTheory/computeScenarioDiff/buildTeamLineupAudit refactor
  fallout, or Bug A's now-fixed aliasing having inflated one athlete's times)
  is real before fixing anything; known-good baseline for full suite is
  74 passed / 1 failed / 3 skipped.

## 2026-09-02 — Bug B done (entry-limit double count), NOT committed

- **The plan doc's two guesses were both wrong, and so was the framing.** The
  double count is in `countSwimmerEntries` itself (`swimmerEntryLimits.ts`) —
  the very function the plan doc argued was already correct — but on the RELAY
  branch, not the individual one. It is not a display path, and no import or
  extraction path forges duplicate rows.
- Root cause: the relay branch keyed entries on `relayEntryKey(...)`, which is
  `team|event|roundSwam|rank|clock` (`relaySplits.ts:625`). That key names one
  physical relay SWIM — correct for landing a leg override on the right heat,
  wrong for a cap. `backend/pdf_parser.py:1120` keys relay rows on
  `(school, event, gender, ROUND, finals_time, rank)`, so a squad that swims a
  relay in prelims and again in the final really does reach the counter as two
  rows whose round, rank and clock all differ. Every leg swimmer was charged
  two entries for one relay.
- Measured repro before touching code: 3 individual events + 4 relays, each
  swum prelims + final → counted `3 ind + 8 relay = 11/7 OVER CAP`; correct is
  `3 ind + 4 relay = 7/7 at the cap`.
- The INDIVIDUAL side was already correct (it keyed on the event alone), which
  is why the individual half of the repro returns 1. The parser also merges an
  individual prelims row and finals row into ONE row keyed
  `(name, event, gender)` — `prelimsTime`/`finalsTime`/`roundSwam` share a row —
  so individual events never reach the counter twice at all.
- Fix: one new exported helper, `entryCapKey(r)` — the trimmed event, used by
  BOTH branches. `relayEntryKey` / `relayTemplateFromLeg` imports dropped, which
  also removes an O(n) scan per relay row from a function `PERFORMANCE_NOTES.md`
  flags as hot (the loop is now O(n), not O(n²)).
- No second implementation needed fixing. `historyImportRoster.ts`'s
  `countExistingEntries` already dedupes by event across all three planes and is
  correct as written (read only, not modified). `rosterLineupAudit.ts`,
  `scoringTheory.ts`, `arbitrage/dropAdd.ts`, `arbitrage/relayLegSwaps.ts` and
  every UI panel route through `countSwimmerEntries`, so all inherit the fix —
  no unification was needed and none was forced.
- Zero silent defaults: a row with no event name is now COUNTED under a
  `' unlabeled|<id>'` key (leading space, which a trimmed event can never
  produce) instead of being dropped from the count. That closes a pre-existing
  silent-empty path on the individual branch. An over-count is visible to the
  coach; an under-count hides a violation.
- Proved the new test fails on the old logic (`8 !== 4`) before keeping it.
- Verified on real data: old key vs new key over all 172 athletes in
  `data/meets.json` → **0 differing counts**. This meet has no relay contested
  in two rounds, so the change is a no-op on the primary workspace and only
  moves the prelims+finals case. Confirmed the HSU lookup returns real rows
  (167 Henderson State men rows, e.g. Colin Candebat 3 ind + 4 relay = 7/7).
- Tests: `test_entry_limits.mjs`, `test_entry_limits_aliases.mjs` (9/9),
  `test_lineup_audit.mjs`, new `test_entry_limits_prelims_finals.mjs` (6/6) all
  green. Full suite `node scripts/run-tests.mjs` → **74 passed / 1 failed / 3
  skipped** (baseline was 73/1/3; +1 is the new test, the 1 failure is the
  pre-existing playwright e2e with no browser binary). `npm run lint` clean
  across all 7 workspaces, `npm run build` exit 0.
- Files touched: `packages/core/src/lib/swimmerEntryLimits.ts`,
  `scripts/run-tests.mjs` (+1 line), new
  `scripts/test_entry_limits_prelims_finals.mjs`. Pre-existing unrelated
  uncommitted diff (pdf_parser.py, point_calculator.py, seasonAnalytics.ts,
  4 other new test scripts) left untouched. No git operations run.
- API surface added (additive; nothing removed or renamed):
  `export function entryCapKey(r: Pick<SwimmerResult, 'id' | 'event'>): string`.
  `SwimmerEntryCounts.relayEvents` now holds relay EVENT names rather than
  `relayEntryKey` strings; its size still equals `relayCount`, and no consumer
  reads the members (only tests compare the set to itself).
- Residual findings, out of scope, NOT acted on:
  1. `AthleteMeetEntriesPanel.tsx:66-86` merges `meetEntryPlans` into the row
     array with the plan's RAW event label and no remapper, so a plan for
     "100 Yard Breaststroke" beside a meet row "Event 26 Men 100 Yard
     Breaststroke" counts twice. That is an event-label identity bug, not a
     round bug — `whatIfProjection`'s `makeEventRemapper` /
     `collapseCrossPlaneDuplicates` is the machinery that already solves it
     elsewhere, and this panel bypasses it.
  2. `entryIdentityKey` (`whatIfProjection.ts:107`) keys on `row.event` raw and
     depends on that same remapper having run first.
  3. `data/meets.json` "Blank Workspace 1" has one genuinely duplicated
     individual row: Mark Eberhard, Event 39 Men 200 Yard Breaststroke, two ids,
     both `A Final` rank 1 DQ. Deduped by the event key, so it costs one entry
     — but it is a real data defect the duplicate scan should surface.
- Next: dispatch `executor` for Bug C (arbitrage), per the plan's sequence.
