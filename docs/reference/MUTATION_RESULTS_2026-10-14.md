# Mutation testing results, scoring path (plan item T6)

Runs: 2026-10-14 and 2026-10-15. Tool: Stryker 9.6.1 with the vitest runner.
Plan item: `docs/reference/IMPROVEMENT_PLAN_2026-10-10.md`, T6.

## Why this exists

A mutation `teamPts / n` to `teamPts` in relay scoring passed the whole suite
(no test pinned per-swimmer relay points; fixed in 4e4c7299). T6 asks for a
systematic search for the other holes in the scoring path.

## How to run

```bash
npm run test:mutation -- --mutate packages/core/src/lib/relayScoring.ts
```

- Config: `stryker.config.mjs`. Test set: `vitest.stryker.config.ts` (the base
  vitest config minus backend, SwimCloud, auth and route tests that never
  reach the scoring modules).
- Run one file at a time. A run of all nine files takes about two hours.
- Stryker copies the repo to `.stryker-tmp/` and writes `reports/`. Both are
  gitignored. Delete both after a run.
- New tests are in `tests/mutation/`. Each file states, in comments, the hand
  derivation of every expected number (NCAA Rule 7-1-1 place table, relay
  table = 2x individual, a tie shares the points of the places it spans).

## Method and deviations

- Version: 9.6.1 (released 2026-04-10). 10.0.0 needs Node 22 or newer; the
  repo allows Node 20.
- `coverageAnalysis: 'perTest'`, `ignoreStatic: true`, concurrency 12 (the
  brief said 4; 4 took more than 27 minutes for the 505-mutant file).
  `ignoreStatic` leaves module-level constants and tables unmutated. The NCAA
  point tables in `ncaaScoringRules.ts` (lines 328-740) are such tables, so the
  NCAA row below covers lines 741-1492 only.
- "Before" numbers are the Stryker run on the suite as it stood before this
  work (the `tests/mutation/` folder is ignored when `MUTATION_BASELINE=1`).
  The relayScoring baseline used an older config and the full suite.
- "After" numbers are not a second full Stryker run. Each baseline survivor
  and no-coverage mutant was replayed one at a time against the new tests in a
  copy of the repo (a mutant counts as killed when the new test file fails).
  A baseline "killed" mutant stays killed because the old suite is unchanged.
  This cost about 25 minutes instead of two hours. One file was cross-checked
  with a real Stryker run on the final tests: `relayScoring.ts` gave 145
  killed, 0 timeout, 10 survived, 6 no coverage (90.06%), the same score as
  the replay (the replay split the 16 left mutants 8/8). The other files were
  not cross-checked, so run Stryker for the authoritative figure. The "remaining" classes below come from reading each mutant against
  the source, not from a proof tool.
- Score = (killed + timeout) / (total - ignored). A no-coverage mutant counts
  as not killed. Source files were not changed.

## Results

| File | Mutants | Killed before | Timeout | Survived before | No coverage before | Score before | Killed after | Survived after | No coverage after | Equivalent (judged, after) | Score after |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `relayScoring.ts` | 161 | 89 | 0 | 50 | 22 | 55.28% | 145 | 10 | 6 | 16 | 90.06% |
| `scoringRules.ts` | 505 | 285 | 1 | 188 | 31 | 56.63% | 474 | 25 | 5 | 30 | 94.06% |
| `individualScoring.ts` | 484 | 246 | 0 | 176 | 62 | 50.83% | 439 | 35 | 10 | 45 | 90.70% |
| `meetPool.ts` | 80 | 40 | 0 | 16 | 24 | 50.00% | 75 | 4 | 1 | 5 | 93.75% |
| `calculatePoints.ts` | 395 | 208 | 3 | 136 | 48 | 53.42% | 337 | 39 | 16 | 55 | 86.08% |
| `scorerRoster.ts` | 339 | 171 | 0 | 127 | 41 | 50.44% | 333 | 4 | 2 | 6 | 98.23% |
| `ncaaScoringRules.ts` (741-1492) | 425 | 298 | 6 | 85 | 36 | 71.53% | 404 | 14 | 1 | 15 | 96.47% |
| `relaySimulation.ts` | 406 | 224 | 1 | 140 | 41 | 55.42% | 339 | 45 | 21 | 65 (1 not pinned) | 83.74% |
| `arbitrage/relayLegSwaps.ts` | 406 (4 ignored) | 236 | 4 | 125 | 37 | 59.70% | 285 | 93 | 20 | 0 (113 unclassified) | 71.89% |
| Total | 3201 (4 ignored) | 1797 | 15 | 1043 | 342 | 56.68% | 2831 | 269 | 82 | n/a | 89.02% |

Timeout counts are the same before and after. "Killed after" excludes
timeouts; the score includes them. The score is (killed + timeout) /
(mutants - ignored); the total row uses 3197. "Equivalent (judged)" is the
count of left mutants placed in an equivalent, unreachable or dead-field class
below, by reading the source. "Before" has no such judgement.

Relay scoring and tie-share paths, the focus of the brief:

- `relayScoring.ts`: 55.28% to 90.06%. Every remaining mutant is equivalent
  (table below).
- Tie share (`tiedPlaceShare`, `scoringRules.ts`) and its callers in
  `individualScoring.ts`, `relayScoring.ts`, `ncaaScoringRules.ts`: the tie
  arithmetic mutants die; the one that survives (`scoringRules.ts` L366) is equivalent. `ncaaScoringRules.ts` gained a straddling-tie
  test (a 5-6-7 tie: one third of places 5, 6 and 7 each, no reason string).

## Remaining mutants

Four classes. "Equivalent" means the output is provably the same for every
input. "Unreachable" means a guard that no caller can trip (a second guard
covers the same case, or the value is always defined). "Dead field" means a
property that nothing reads. "Not pinned" means reachable and not proven
equivalent; no test was written. Only `relayLegSwaps.ts` and the
`relaySimulation.ts` theoretical-relay lines have mutants in that last class.

### relayScoring.ts (16, all equivalent or unreachable)

| Lines | Why |
|---|---|
| L27, L42, L58-61, L106, L168 | Fallback `''` strings that feed a join key. Replacing one changes the key for every row alike. |
| L39, L40 | A row with no named swimmers: empty list or `length === 0` both give `''`. |
| L91 | `rk != null`: a null rank never reaches the call. |
| L167 | `'Unknown'` team label used only as a map key. |
| L206 | `n > 0 ? n : 1`: a group always has at least one row. |
| L208 | `n >= 4` against `n > 4`: both give 4 at n = 4. |

### scoringRules.ts (30)

| Lines | Why |
|---|---|
| L24, L58, L82, L106, L107, L206, L229 | String sentinels (`''`) compared only with the same sentinel. |
| L32 | `/^FINALS?$/` against `/^FINALS$/` and `trim`: the later checks in `classifyRoundTier` give the same tier for every label that reaches it. |
| L72, L137, L297, L330, L389 | Guards whose false branch runs the same code (empty list, absent table). |
| L99 | Event-number cap: `null` and non-finite both fall to the same return. |
| L214, L218, L238, L241, L245, L296, L304, L359 | Range guards that a later check repeats (`rank < 1`, `idx >= 0`, bracket edge). |
| L366 | `spanned += 1` to `-= 1`: `spanned` is read only as `=== 0`, and a sign change keeps zero at zero. |

### individualScoring.ts (45)

| Lines | Why |
|---|---|
| L47 | An empty event list is not a timed-final session, and scoring an empty list returns `[]`. |
| L58 | `parseRankInt` returns `null` or a positive integer, so `rk > 0` is always true when not null. |
| L126 | Counts places past the table end, all worth 0. |
| L137, L309, L346, L652, L459-463 | `'Unknown'`/`''` literals and `trim` on grouping keys of rows that score 0 anyway (no rank). |
| L160, L617 | `cap < 999`: at 999 the cap path admits every member, same as the no-cap path. |
| L193 | Unreachable: guarded by L47. |
| L304-305 | Rows that cannot score sort after A and B rows, so they never move a scoring row over the cap. |
| L385, L391, L394, L398 | `shiftRanksAfterRemoval` guards on ranks that over-cap rows always have. |
| L424, L446 | `overCap.size === 0` and the rank restore: with no over-cap row the scorer is called with the same input and returns the same rows; a restored rank equals the rank already there. |
| L533, L534 | Second guard (`tiedPlaceShare` returns `null`) zeroes the row. |
| L598 | An empty member list adds no rows. |

Killed by new tests: blocked prelim dives hold no place (cap 3 and cap 2
cases), every removed rank moves later rows up, an unranked row holds no
place, a trailing-space round label still ties.

### meetPool.ts (5)

| Lines | Why |
|---|---|
| L20 | `''` team key part. |
| L47 | `cap >= 999` against `> 999`: cap 999 means no cap either way. |
| L51 | `<=` against `<` with an epsilon of 1e-9: equal only at exact fits of binary fractions. |
| L80 | `t < prev` against `t <= prev`: equal times are ordered by index either way. |

### calculatePoints.ts (55)

| Lines | Why |
|---|---|
| L55 | Printed points of 0 or null both return 0. |
| L92, L143, L165, L219, L226 (x2), L233 | Tie-break and guard conditions that are redundant: the first row always wins, an empty recruit list returns `[]`, a recruit is in one field. |
| L153, L307, L326-330 | `''`/`[]` fallbacks and the probe row's id, name, team: `placeFieldByTime` reads only the time. |
| L172, L177, L337, L339 | Unreachable throws. |
| L379, L386, L532, L535, L539, L582, L583, L489 | Fallbacks `?? {...p, points: 0}` that never run, because every row is in `scoredById`. |
| L407-415, L444-452, L461, L485, L410 (part) | Dispatch flags. The independent path and the chronological path return the same rows when no meet-wide pool exists, and `maxRelayCap < 999` or `maxIndivCap < 999` are repeated by the per-event cap code. The `relayEligibleFromScorerPool` clause was not equivalent: a test now pins that a flag-off relay takes no pool slot. |

Killed by new tests: a recruit with no gender is placed against every gender,
label choice (three tie-break cases), output order (round, rank, time; recruits
by time), the conference passed with the call overrides generic caps, and the
relay-pool flag.

### scorerRoster.ts (6)

| Lines | Why |
|---|---|
| L76 | `rules?.` optional chain: `rules` is always defined there. |
| L109 | `!rules`: `effectiveAutoRules` always returns a value. |
| L143 | `?? []` on a list that is always present. |
| L220, L307 | `''` literals compared with the same literal. |
| L397 | The key includes gender, so the gender test is redundant. |

### ncaaScoringRules.ts, lines 741-1492 (15)

| Lines | Why |
|---|---|
| L1102 | Empty pool: the loop body does not run. |
| L1105, L1183 | Index tie-break of a stable sort. |
| L1131 | Tied-place list variants give the same share for a group of one. |
| L1140, L1209, L1217 | Status labels of capped entries; capped entries always carry `'scoring'`. |
| L1288, L1290, L1364 | `holds-place` branches whose false path returns the same rows. |

### relaySimulation.ts (66)

| Lines | Why |
|---|---|
| L51 (`''`), L52, L53 (`''`), L86, L90 | Join-key fallbacks. |
| L84 | `isRelayLegEvent` is false with no stroke, so the guard is redundant. |
| L224 | The first delta line already equals the branch result (`null` and `NaN` fall through alike). |
| L241-243 | Placeholder-name filter for "already on the relay": no assignee is ever named `—` or `Unknown`. |
| L277-281, L337-341 | Dead fields: `id`, `name`, `classYear`, `isRelay` of a replacement row are never read. |
| L397, L408, L411 | Second guard / same string. |
| L440, L442, L444 | `modified` short-circuits, so the right side is read only when rows are returned unchanged. L440 `some` against `every` differs only for a group that mixes theoretical and measured legs; none exists in data (not pinned). |
| L503, L515, L516, L560-566 | Unreachable: every relay row is processed in the main loop. |
| L594, L618, L619 | `?? []` and `length > 0` on lists that are empty or defined. |
| L670-688 | `relaySplitQualificationCutEvent` fallback after a thrown normalise; `normalizeEventForCutline` does not throw on any label tried. |

Killed by new tests: group key parts (clock, place, round, team, trimmed),
split lookup by leg index, clamp of a row index past the last leg, blank
manual time, medley stroke names, null leg-only pool.

### arbitrage/relayLegSwaps.ts (113, best effort)

This file was in the brief as "if time". Its baseline was 59.70%. The new
tests lifted it to 71.89%. The 113 left were not classified one by one. By
group:

| Lines | Group |
|---|---|
| L226, L252, L259, L286-288, L297-319 | Entry and leg-row selection (team, place, round, signature filters). A test with three sibling relays of the same team showed no output change, because leg names come from `relayNames`; these only matter for rows with no `relayNames`. Not pinned. |
| L348-352, L362-368, L380-382 | Individual-swim lookup filters (team trim, gender, class-year fallback). Not pinned. |
| L466-470, L504-505, L524-525, L535-536 | Entry-cap counting and split display. Not pinned. |
| L567, L585, L600, L616-617, L638, L652-653, L671 | Cap bypass at 999, the candidate-equals-outgoing guard, time-trial candidates, `keepBestSwap` ties. Not pinned; tie behaviour is not specified. |
| L703-713, L733-758, L787-804 | Per-leg distance, dedupe and sort of results. Not pinned. |

Treat this file as the next place to look. A defect in cap or pool handling
here shows up as a wrong "gain" number.

## Defects and gaps the work found

Item 1 was fixed afterwards. The rest were not fixed (no source change was
allowed in the mutation run). Each is pinned only where noted.

1. FIXED 2026-10-15 (commit 3af2219c). `classifyRoundTier('Timed Finals')` returned `'D'`,
   because `includes('D FINAL')` matches the text "TIME-D FINAL". A SwimCloud row
   with `roundSwam: 'Timed Finals'` was unscored. `normalizedRoundLabel` now reads
   it as Finals in `classifyRoundTier` and `isUnscoredRoundOrEvent`, and the same
   fix is in `backend/point_calculator.py`. Effect: in computed mode a meet with
   no `scoredEventNumberMax` also scores post-meet time trials that SwimCloud
   prints as Timed Finals.
2. Relay-pool eligibility (`relayEligibleFromScorerPool` with a meet-wide
   pool) had no coverage. A relay entry that held no place took a team relay
   slot undetected. Per-leg split for entries with other than four legs was
   untested. Now pinned.
3. `removed-from-consideration` mode: an over-cap diver's own prelim row loses
   its "blocked by finals dive" status and scores prelim points (D2 prelim got
   20 in the probe). Reported, not pinned.
4. `maxIndividualScorersPerTeam` (per-event, not meet-wide) counts per group,
   so one athlete in the A and B final uses two slots. Semantics unclear; not
   pinned.
5. Timed-final distance ladder with a blank mid-table cell stops: every swimmer
   behind scores 0. Not pinned.
6. A diver with a blank team never matches `athleteHasFinalsDiveInEvent`
   (`''` against `'Unknown'`).
7. `relaySimulation`: when an override has both `assigneeName` and
   `manualLegTime`, the clock moves by the manual time but the shown leg split
   uses the assignee's own swim, so the team splits do not sum to the clock.
8. `relaySimulation.simulateRoster` appends recruits without the
   `staysOnRoster` gate (a senior recruit stays with `removeSeniors`). A vacant
   leg with no recorded split shows a fixed 30.00 + 3.00 placeholder (33.00).
9. `relaySimulation`: when a leg row is missing from a group, the leg total of
   the missing index reads the next row's split (`ordered[index]` fallback).
10. `rankRelayLegSwaps` in roster mode builds its scorer lookup from raw meet
    rows only, so recruits are never offered as leg fills unless a scorer
    override names them, while scoring treats recruits as scorers by default.
    A probe gave 0 candidates in roster mode and 1 in points-pool mode. This
    can be a silent empty result.
11. Relays are scored by the stored `rank` field, not by the clock. Vacating a
    leg does not change a relay's place in points-pool mode (calculatePoints
    and relayLegSwaps).
12. `buildMeetPlaceField` includes a time-trial row as a comparator when
    another non-time-trial row names the same event (`recruitComparators`
    does not exclude time trials).
13. `rowSuggestsScorer` distance-final rule (`tier === 'PRE'`) is unreachable
    for typed settings (`abFinalTiers` is `'A' | 'B'`); it runs only for a
    stored out-of-type `'PRE'`.
14. Initial scores were 50-57% for the scoring modules (71% for the NCAA
    engine). Classification helpers, tie share, B-final index mapping, meet
    pool admission and error-message paths were exercised only indirectly.
