# 12 — "Optimize team" zeroes a recruit-driven workspace

> **✅ FIXED 2026-08-16.** The guard turned out better than "refuse a loss":
> each stage is now evaluated as a **complete candidate state** and the best one
> wins, so the roster workspace does not merely avoid the wipeout — it **gains
> +118** (1277 → 1395) where it previously lost everything.
>
> | HSU men | current | scorers | events | scorers+events |
> | --- | --- | --- | --- | --- |
> | meet loaded | 1383.83 | 1214.33 | 1242.00 | **1691.00** |
> | recruits only | 1277.00 | 213.00 | **1395.00** | 0.00 |
>
> The measured data forced that shape: the `scorers` stage *alone* loses 170 on
> the meet workspace and only pays off once `events` runs after it, while on the
> roster workspace the chained result is the wipeout and `events` alone is the
> best answer. Neither "always chain" nor "reject stage A" finds both.
>
> `optimizeRosterAllTeams` needed its own guard — team B's baseline was measured
> *after* team A's changes, so per-team guards can sit on top of a chain-induced
> loss. Note the per-team gains largely cancel when chained: +307 and +18
> individually net to +16 across the field.
>
> `OptimizerResult` gained `outcome`, `appliedStages` and `unguardedTotal`, and
> the UI no longer shows a success toast for a no-op.
>
> **The root cause is diagnosed below and is NOT fixed** — the guard makes the
> button safe while the disagreement stands.

## Root cause — three behaviours compounding

Verified by perfect correlation, not inferred.

1. The optimiser enforces `maxIndividualScorersPerTeam` (18 under NSISC); the
   engine's automatic set does not — `buildScorerRosterLookup` defaults a recruit
   row to `isScorer: true` unconditionally. 32 auto-scorers get "corrected" to 18,
   so **every override written is an OFF**. This is the disagreement
   [02 §2b](02-data-quality-aliasing.md) named.
2. `prepareRecruitsForScoring` ranks a recruit against the PDF rows in its event.
   With no PDF there are no comparators, so **all 281 rows come back rank 1**,
   round "A Final" — one event becomes one tie group.
3. `scoreIndividualsInEvent` gates a tie group with
   `uniqueNames.every(n => rosterLookup.isScorer(...))`. **One non-scorer zeroes
   the entire group.**

So turning 14 of 32 athletes off does not cost 14 athletes' points — it zeroes
every event any of them entered. Measured: 12 of 14 events contained a turned-off
athlete and scored 0; the other 2 still scored. 1277 → 213. Running `events` after
that puts an off athlete into all 14 → 0.00. Zero exceptions either way.

**The severe half is #2/#3, not #1.** The `every()` gate turns a per-athlete
eligibility decision into an all-or-nothing *event* decision whenever ranks
collapse. Fixing #1 alone would leave that landmine for any workspace where a tie
group spans a scorer and a non-scorer.

---


**Severity: P0. Pre-existing — confirmed on `HEAD` before any of this round's
changes.** Found 2026-08-16 while measuring something else entirely.

This is the most severe user-facing defect found in this review. It is not a
wrong number in a panel; it is the primary action on the Optimize step
destroying the projection a coach has been building.

---

## Measured

`optimizeRosterForTeam(workspace, gender, team, false, settings, 'all')` — the
path behind the **Optimize team** button:

| Workspace | Team / gender | Before | After optimising |
| --------- | ------------- | ------ | ---------------- |
| Blank Workspace 1 (meet loaded) | Henderson State, Men | 1383.83 | **1695.17** ✅ |
| Blank Workspace 1 | Henderson State, Women | 476.00 | 476.00 |
| Blank Workspace 1 | Ouachita Baptist, Men | 871.67 | 889.67 ✅ |
| **HSU 2026-27 Roster Plan** (no meet) | **Henderson State, Men** | **1277.00** | **0.00** ❌ |

**1277 → 0.** The entire projection is destroyed.

That workspace is the one `CLAUDE.md` names as the primary workspace: *"HSU
2026-27 roster (swimmers, class years, NSISC event rules)"* — 214 recruits, 67
planned entries, 313 recorded changes. It is the tool's main planning artefact.

## Confirmed pre-existing

Measured on `HEAD` with the working tree stashed, then again with this round's
alias-resolver wiring applied. Both produce 0. The resolver work is not the
cause, and does not fix it.

For completeness, the resolver's own effect where the optimiser *does* work is
small and explicable — Blank Workspace 1 HSU men 1695.17 → 1691.00, with the
scorer-override count dropping 24 → 18 as six duplicate rows collapse.

## What is probably happening

Not diagnosed — recorded so the next person starts ahead of where I did.

`optimizeScorersForTeam` writes overrides where its choice differs from the
engine's automatic answer. On both HSU rosters **every override it writes is
`isScorer: false`** — it turns 14–24 athletes *off* and turns nobody on.

That is consistent with the cap interaction in
[02 §2b](02-data-quality-aliasing.md): the engine's automatic scorer set ignores
`maxIndividualScorersPerTeam` (42 auto-scorers on a cap of 18), while the
optimiser enforces it. So the optimiser "corrects" the roster down to 18, and on
a workspace with no meet results to fall back on, the remaining lineup scores
nothing at all.

On a workspace with a loaded meet the PDF rows keep scoring, which is why the
same code gains +311 there and loses everything here. **The two components
disagree about who scores**, and the disagreement is invisible until you apply it.

## Why this outranks everything else in this folder

Every other finding is a number that is wrong. This one is a **destructive
action with no warning and no undo path in the UI** — and it is offered as the
recommended next step on a wizard step titled *"Find more points"*.

## Proposed

1. **Guard first, diagnose second.** `optimizeRosterForTeam` should refuse to
   apply a result that lowers the team total, or at minimum surface
   `projectedTotal < previousTotal` prominently before writing. It already
   computes both numbers — it just does not compare them.
2. Then reconcile the scorer-set disagreement in §2b.
3. A regression test asserting the optimiser never lowers a team total on either
   live-shaped fixture.

**Do not ship the guard without the test.** A silent "optimise did nothing"
would be its own trust problem.

## Caveat on the measurement

Totals came from `optimizeRosterForTeam`'s own `previousTotal` / `projectedTotal`
fields, not from re-scoring the applied patch independently. Those are the numbers
the UI reports in its success toast, so they are the right ones for "what does the
user see" — but an independent re-score should confirm the 0 before anyone
concludes the lineup itself is empty rather than merely scored as empty.
