# 01 — Numbers that are not what their label says

`CLAUDE.md` opens with the reason this file matters: *"A wrong number does not
throw; it silently produces a plausible, wrong lineup a coach may act on."* Each
item below is a number currently rendered with a unit it does not have.

---

## 1. Arbitrage "points" are not points

> **✅ FIXED 2026-08-14.** `buildArbitrageCards` now delegates to
> `rankExactSwaps`, so the number is a real difference of two scored team totals.
> See [WORKLOG-01](WORKLOG-01-arbitrage-units.md) — including a **correction to
> the proposed acceptance test below**: the `delta <= max(SCORING_POINTS)` bound
> suggested here is wrong, because it bounds one swim's points rather than a
> team-total delta. The section is left as written for the record.

**Severity: P0.** `packages/core/src/lib/rosterArbitrage.ts:123-137`

### What it does

```ts
const gapA = Math.max(0, median(fieldA) - bestA.timeSec);  // SECONDS
const preferredDelta = Number((gapA * 2).toFixed(1));      // labelled "pts"
```

The athlete's time is compared to the field median, and the gap **in seconds** is
multiplied by 2. The result is rendered as `Prefer 1650 Freestyle (~+58.7 pts)`.

### Why it is wrong

`SCORING_POINTS` in `packages/core/src/constants.ts` is
`[20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1]`. **The most any
individual event can award is 20.** Measured on the HSU roster today:

| Card | Claimed "pts" | Implied gap (s) | Possible? |
| ---- | ------------- | --------------- | --------- |
| Emiliano Pina — 1650 Freestyle | **58.7** | 29.35 | No — nearly 3× the entire scale |
| Bartu Akin — 1650 Freestyle | **37.1** | 18.55 | No |
| Colin Candebat — 200 IM | **20.3** | 10.15 | No |
| Camden Mask — 100 Breaststroke | 16.4 | 8.20 | Coincidentally in range |
| Tristin Ferguson — 50 Freestyle | 1.7 | 0.85 | In range |

The `× 2` is not a conversion. It is a scaling constant with no derivation, and
the comment concedes it: *"lightweight heuristic — not a full re-score per swap"*.

### The part that makes it urgent

**The error scales with event length.** A 1650 swimmer 29s clear of the median
gets "+58.7"; a 50 swimmer 0.85s clear gets "+1.7". Both may be worth the same
number of actual points. So the cards systematically rank distance events above
sprints for a reason that has nothing to do with scoring.

That is the *same bug class* fixed in the ranking today (`350a42a7`) — a
length-dependent quantity used as if it were a quality measure — surviving one
layer down. And the ranking fix made it more visible: now that distance events
surface correctly, the two largest fabricated numbers on the screen are both 1650s.

### Proposed fix

Re-score the swap for real. The machinery exists and is already used:
`rosterOptimizer.ts:38 teamTotalForTeam()` builds a trial workspace, runs
`buildWhatIfResults` + `calculatePoints`, and returns a genuine team total. The
optimizer calls it in a loop today (`optimizeScorersForTeam`, line ~123).

```
for each athlete:
  base    = teamTotalForTeam(ws, …)
  withA   = teamTotalForTeam(ws + entry(athlete, evA), …)
  withB   = teamTotalForTeam(ws + entry(athlete, evB), …)
  card.preferredDelta = withA - base        // real points
  card.alternateDelta = withB - base
  card.arbitragePts   = withA - withB
```

- **Effort:** ~half a day. The hard part is not the maths, it is that a full
  re-score per athlete per event is O(athletes × events) scoring passes; see
  the performance note below.
- **Risk:** low correctness risk, real perf risk.
- **Acceptance:** no card may exceed `max(SCORING_POINTS)` for an individual
  event; a card's `arbitragePts` must equal the actual change in team total when
  the swap is applied. Both are directly assertable.

### Performance caveat, and the honest alternative

A full re-score per candidate pair on a 47-athlete roster is roughly 100+ scoring
passes. `useWorkspaceScoring` already runs scoring in a Web Worker with a 200 ms
debounce, so this is feasible off the main thread but not free.

If that proves too slow, the correct fallback is **not** to keep a fake number —
it is to **stop claiming points**. Render the comparison in the unit actually
computed: *"29.4s faster than the field median in the 1650; 12.1s in the 1000."*
That is true, useful, and needs no re-score. The current output's only advantage
over this is that it looks more precise than it is.

**Recommendation:** ship the honest-units version first (an hour), then add real
re-scoring behind it.

---

## 2. An unmapped team is still scored against the D1 table

**Severity: P0.** `packages/core/src/lib/athleteHistory.ts:505`

```ts
const div = division ?? divisionForTeam(team);
```

`divisionForTeam` is **deprecated in its own source** precisely for this:

> `packages/core/src/data/teamDivisions.ts:682-686`
> *"This is a legacy behaviour, not a correct one: an unknown team is not a D1
> team."* — `LEGACY_UNKNOWN_TEAM_DIVISION: NcaaDivision = 'D1'`

And `CLAUDE.md` rule 5 states it flatly: **"Unknown division ≠ D1. An unmapped
team surfaces as unknown rather than quietly scoring against the wrong table."**

`enrichWithComputedCut` is what stamps `computedCut` on every history swim — the
cut badges a coach reads. For an unmapped team it currently compares D2/D3/NAIA
times against **D1 standards**, which are the fastest, so the visible symptom is
under-reporting cuts rather than over-reporting. Quiet, and wrong.

### Why it did not bite today

Measured: **0 of 4 teams** in the loaded meet are unmapped. The bug is latent for
the current data and fires the moment a meet includes a school not in
`teamDivisions.ts` — which is the normal case for an unfamiliar invite.

### Proposed fix

Switch to `divisionForTeamOrNull` and emit `computedCut: null` when it returns
null. `compareTimeToCutline` already distinguishes this via
`status: 'no_table_for_division'`, and `cutlineUtils.ts:72` already documents
that *"Only `ok` licenses the statement 'did not achieve a cut'"* — the consumer
contract exists, this caller just is not honouring it.

- **Effort:** ~1 hour including a test with a deliberately unmapped team.
- **Risk:** low. Changes badges from "no cut" to "unknown" for unmapped teams,
  which is the intent.
- **Acceptance:** a swim from `"Nowhere College"` renders `unknown`, not `no_cut`.

The remaining `divisionForTeam` call, `teamDivisions.ts:794`, is a bulk mapping
helper inside the module that owns the fallback — acceptable, but should take an
explicit fallback parameter for symmetry.

---

## 3. `?? 0` on competition values — audit, do not assume

**Severity: P1 (review task).** 56 occurrences across 17 files in
`packages/core/src/lib`.

`CLAUDE.md` §3 rule 1: *"Absent ≠ 0. No `?? 0`, no `|| 0`, no default constant on
any race value."* Most of the 56 are legitimate (array lengths, indices,
accumulator seeds). A targeted search for the dangerous shape — the default
applied to something named `time`/`sec`/`points`/`score` — returns 13:

| File | Lines | Assessment |
| ---- | ----- | ---------- |
| `scenarioDiff.ts` | 234, 235, 280, 281, 305, 307 | **Worth review.** `pointsThen ?? 0` / `pointsNow ?? 0` makes "this entry did not exist in the baseline" indistinguishable from "it existed and scored zero". Those are different facts and the diff panel is where the difference matters most. |
| `crossCourseArbitrage.ts` | 929, 948, 1014, 1015 | Probably fine — summing points where a non-scoring row genuinely contributes 0. |
| `athleteHistory.ts` | 387, 397, 415 | Mine, from today. Defensive reads on a record built two lines above, and every consumer guards `sec > 0` before use. Textually the banned pattern; should be tightened for consistency. |

**Proposed:** work the `scenarioDiff` six first — they are the ones where absent
and zero carry different meaning. Then add the lint rule from
[06](06-testing-verification.md#4-encode-the-prose-rules-as-tests) so the
category cannot regrow.

---

## 4. Relay leg times fall back to `'NT'`

**Severity: P2.** `rosterOptimizer.ts:183`, `rosterArbitrage.ts:181`

```ts
time: best?.time ?? 'NT',
```

This is the *correct* shape — `'NT'` (no time) is a real swimming concept and is
honest about absence, unlike `0`. Flagged only so it is not mistaken for the
pattern above during the audit. **No action.**
