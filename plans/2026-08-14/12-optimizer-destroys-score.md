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
> **The root cause is diagnosed below.** ✅ **Its severe half — the `every()`
> tie-group gate — was fixed 2026-08-16.** See the next section.

## ✅ The `every()` gate is fixed — eligibility is now per athlete

`scoreIndividualsInEvent` gated a team's slice of a tie group with
`uniqueNames.every(n => rosterLookup.isScorer(...))`, so **one athlete off the
scoring roster zeroed every teammate tied with them**. It now filters: the
non-scorer takes 0, the scorers keep their share.

Measured on the two live workspaces, HSU men:

| | current | `scorers` | `events` | `scorers+events` |
| --- | --- | --- | --- | --- |
| meet loaded — before | 1383.83 | 1214.33 | 1242.00 | 1691.00 |
| meet loaded — **after** | 1383.83 | **1364.24** | 1242.00 | **1566.87** |
| recruits only — before | 1277.00 | **213.00** | 1395.00 | **0.00** |
| recruits only — **after** | 1277.00 | **1270.03** | 1395.00 | **1407.27** |

The catastrophic cells are gone. `scorers` alone on the roster workspace goes
**213 → 1270**, and the chained stage that previously produced the 0.00 wipeout
is now the **best available answer at 1407.27** — 12 points better than the
`events` stage the guard used to have to fall back to.

Two properties worth stating because they are what make this safe to ship:

- **No displayed total moves.** Every `current` figure is unchanged, on both
  workspaces and both genders, and `scripts/test_nsisc_team_totals.mjs` reports
  byte-identical numbers before and after. With automatic scorers nobody is a
  non-scorer, so the gate never fired until the optimizer wrote an override.
- **Benched points are forfeited, not redistributed.** The tie share is set by
  the placement, so it is identical before and after; a rival's points do not
  move either. `scripts/test_tie_group_scoring.mjs` asserts both directions,
  including that benching a whole team still scores nothing.

The meet workspace's optimum falls 1691.00 → 1566.87. That is expected and is
not a loss of real points: under the old gate a mixed group was zeroed *without
consuming meet-wide pool weight*, so the 18-scorer pool stretched further than
it should have. Scorers now score and consume, which is the honest accounting.

The guard from the previous round stays. It is what made this change measurable
rather than dangerous, and it still catches any future stage that loses points.

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

> #3 is fixed (see above). **#1 and #2 still stand** and are still worth closing:
> the engine's automatic scorer set ignores `maxIndividualScorersPerTeam` while
> the optimizer enforces it, so the two components still disagree about who
> scores; and `prepareRecruitsForScoring` still returns every recruit at rank 1
> when there are no comparators, which is why a whole event can be one tie group
> at all. Neither is destructive any more — but #2 means a roster-only workspace
> is still scoring an event as a 281-way tie, which is not what a coach is
> looking at.

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
