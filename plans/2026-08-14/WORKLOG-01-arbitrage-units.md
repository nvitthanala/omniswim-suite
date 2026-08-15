# Worklog 01 — arbitrage cards: real points, not seconds × 2

**Started:** 2026-08-14
**Finding:** [01-fabricated-values.md §1](01-fabricated-values.md#1-arbitrage-points-are-not-points)
**Status:** ✅ done — shipped, verified live
**Guard:** `scripts/test_arbitrage_units.mjs`

## Goal

`buildArbitrageCards` renders `Prefer 1650 Freestyle (~+58.7 pts)`. The number is
`(fieldMedianSeconds - athleteSeconds) * 2`. It is seconds, scaled by an
underived constant, labelled points. The maximum any individual event can award
is 20.

Make the number either **real points** or **honestly labelled seconds**. No third
option.

## Plan

1. Measure the cost of one `teamTotalForTeam` scoring pass on the real roster.
   This decides whether a true re-score is viable inside a UI panel.
2. If viable → compute genuine point deltas by scoring the swap.
   If not → render the seconds gap with a seconds label and no fabricated scale.
3. Guard with a units test: no individual-event delta may exceed
   `max(SCORING_POINTS)`.
4. Verify in the running app, on both workspaces.

## Acceptance

- [ ] No card claims a point value outside what the scoring scale can award
- [ ] A card's `arbitragePts` equals the actual change in team total when applied
- [ ] Distance and sprint events are treated on the same scale
- [ ] `npm test` green, lint clean, no console errors in the app

---

## Log

### 1. Baseline measurement — real re-scoring is viable

Measured on both live workspaces:

| | Blank Workspace 1 (meet loaded) | HSU (roster only) |
| - | - | - |
| rows scored | 502 | 281 |
| `buildWhatIfResults` | 13.8 ms | 0.6 ms |
| `calculatePoints` | 9.5 ms | 1.6 ms |
| **one full swap + rescore** | **9.4 ms** | **2.0 ms** |
| whole team (47 / 32 athletes, 2 passes each) | 0.9 s | 0.1 s |

**Decision: take the real re-score (option B), not the honest-seconds fallback.**
Under a second for the largest workspace, on a panel that is not on the critical
render path. The fallback in the plan is no longer needed.

### 2. Design — how to model "swim A instead of B"

Reading `buildWhatIfResults` / `applyOverlayPlans` changed the design. A naive
"add a planned entry for event A and re-score" is **wrong** whenever the athlete
already has a meet result in A: overlay plans without `replacesResultId` are
*appended*, so the athlete would appear twice in the field and inflate the total.

`PlannedSwimEntry.replacesResultId` exists for exactly this. A plan carrying it
swaps the referenced result rather than adding to it — which is precisely the
arbitrage question. So the trial states are built per case:

| Athlete currently has | Trial construction |
| --------------------- | ------------------ |
| both A and B | **skip** — "prefer A over B" is a drop decision, not arbitrage. `rankDropOnly` owns that. |
| A only | compare current vs `plan{replacesResultId: A's row, event: B}` |
| B only | mirror |
| neither | compare `plan{event: A}` vs `plan{event: B}`, both additive |

Any pre-existing *planned* entry for A or B is filtered out first, so a trial
never stacks on top of a previous plan.

`arbitragePts` becomes a genuine difference of two team totals, which is bounded
by the scoring scale by construction — the units test then has something real to
assert rather than a scaled guess.

### 3. First attempt — hand-rolled trial states, abandoned

Built the design above: strip the athlete's planned entries for both events, add
one back via `replacesResultId`, re-score, diff. It produced real numbers, but two
of twelve cards claimed 47 and 29 points from a single swap, which did not look
like a swap could produce.

Instrumented one (`Colin Candebat`, 200 IM → 100 Free) and found the swap was
being applied correctly — 200 IM gone, 100 Free at 44.32 present, still 7 rows —
but **his 100 Butterfly dropped from 20 points to 0 and his 200 Butterfly from 16
to 0**, events the swap never touched.

Chased two hypotheses:

- **Scorer cap (`maxIndividualScorersPerTeam: 18`)** — measured scorer status in
  both states. He is a scorer in both, and the team has 42 scorers either way.
  **Not the cause.**
- **Entry-limit voiding** — found the answer at `crossCourseArbitrage.ts:1464`:
  *"over-entry only surfaces in the lineup audit"*. The engine does **not** void
  over-entered swimmers; `crossCourseArbitrage` applies that as its own
  "effective total" adjustment on top. So my hand-rolled comparison was missing a
  correction that the existing module already implements.

That was the signal to stop. Two confounders found in twenty minutes, in a
regime the codebase had already solved once.

### 4. Second attempt — delegate to `rankExactSwaps`

`crossCourseArbitrage.rankExactSwaps` already answers exactly this question and
carries everything my version lacked:

- applies each candidate swap and **re-scores the field**, so `deltaPoints` is a
  genuine difference of two team totals
- handles the over-cap effective-total correction
- has an incremental fast path with structural self-validation
- **knows when the answer is meaningless** — `pointsMeaningful: false` with a
  `reason` when the field has fewer than two scoring teams — instead of returning
  a confident number
- is covered by three existing test files

`buildArbitrageCards` is now a presentation layer over it. Net: the second
implementation of a solved problem is gone rather than repaired.

### 5. Correction to the plan doc — my proposed units bound was wrong

[01-fabricated-values.md](01-fabricated-values.md) and
[06-testing-verification.md](06-testing-verification.md) both proposed asserting
`delta <= max(SCORING_POINTS)`. **That bound is wrong**, and the first version of
the probe failed against it for legitimate results.

It bounds *one swim's* points. A **team-total** delta is not so bounded: moving a
swimmer out of an event promotes every teammate behind them, each gaining points,
so one swap can legitimately move a team total by more than any single event
awards. `Alan Alejan Gonzalez Mujica: 1000 Free ← 200 Free, +40.5` is real.

The assertion that actually holds is **internal consistency**:

- `deltaPoints === newTotal - baseTotal`, and
- applying the swap and re-scoring reproduces it.

Verified on the live meet workspace: **claimed 40.5, observed 40.5 — MATCH.**

### 6. Two further defects found and fixed while verifying

- **One athlete flooded the panel.** `rankExactSwaps` returns every
  (athlete × add-event × drop-event) combination, so `Gavin Kock` occupied 6 of
  12 cards with permutations of the same idea. Now one card per athlete — their
  best available swap. 12 cards, 12 distinct athletes.
- **The empty state lied by omission.** With no meet loaded, HSU produced zero
  cards and rendered *"No clear trade-offs yet"* — which reads as "we checked and
  found nothing". The truth is that no point value is computable without a scored
  field. Added `buildArbitrageCardsResult` returning `{cards, pointsMeaningful,
  reason}`; the panel now says *"Point values need a scored field to place
  against. No men's individual results to score against"* and notes that swaps can
  still be made by hand.

### 7. Result

Before → after on the live meet workspace:

| Before | After |
| ------ | ----- |
| `Prefer 1650 Freestyle (~+58.7 pts) over 1000 Freestyle` | `Swim 1000 Freestyle (9:28.24) instead of 200 Freestyle` · **+40.5** |
| number = seconds × 2 | number = real difference of two scored team totals |
| 6 of 12 cards were one swimmer | 12 cards, 12 distinct athletes |
| no provenance on the entry time | shows the time, flags converted swims, flags placings inside conversion noise |
| empty panel when unscoreable | says why, and what can still be done |

Cards on the meet workspace render in ~1.3 s, memoised per
(workspace, gender, team, settings). No console errors.

## Acceptance

- [x] No card claims a point value the model cannot produce — replaced with the
      correct assertion, since the original bound was wrong (§5)
- [x] A card's `arbitragePts` equals the actual change in team total when applied
      — verified live, 40.5 = 40.5
- [x] Distance and sprint events are treated on the same scale
- [x] `npm test` green (**47 passed / 0 failed / 3 skipped**), lint clean, build
      exit 0, no console errors in the app

## Follow-ups this opened

1. **`Alan Alejan Gonzalez Mujica` tops the card list** — and is one half of a
   split athlete ([02 §2](02-data-quality-aliasing.md#2-four-athletes-are-still-two-people-each)).
   His +40.5 may be inflated by his history being divided across two identities.
   The aliasing fix should land before this number is trusted.
2. **`preferredDelta` / `alternateDelta` are now dead fields**, kept at 0 for
   compatibility and marked `@deprecated`. Remove once no consumer reads them.
3. **~5.4 s to compute all swaps** for a 47-athlete team in the probe (the UI
   path is faster and memoised). If it becomes noticeable, `rankExactSwaps`
   already has `forceFullRescore` and an incremental context to tune.
4. **The old heuristic's `median`/`convertTimeToSeconds` import is gone** from
   `rosterArbitrage.ts`; the file is now ~60 lines lighter and has one job.
