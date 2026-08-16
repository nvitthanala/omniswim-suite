# Round 3 — wiring, diagnosis, and one bad discovery

**Shipped:** `f7054e00`, 2026-08-16
**Result:** lint clean, 56 passed / 0 failed / 3 skipped, build exit 0

Four agents launched; **three hit a session limit mid-work.** Their partial edits
were assessed individually rather than trusted — one was reverted, two were
verified and kept, and one interrupted agent had already finished the work that
mattered.

## The alias chain is now closed end to end

Round 2 gave four core functions an optional resolver. Round 3 passed one in.

Seven call sites: four Manager components (`AthleteMeetEntriesPanel`,
`AthleteEntriesSection`, `AthleteLineupEditorPanel`, and all five sites in
`TeamRosterPanel`) plus three core modules (`rosterLineupAudit`,
`rosterOptimizer`, `scoringTheory`).

**Verified in the running app, not by lint.** The Lineup compliance checklist now
reads **"Entry limits (3)"** and lists Stevie Balistreri and Oliver Pozvai
alongside Oskar Cebula. Both were previously reported compliant while holding **9
and 8 entries against an NSISC cap of 7**. No console errors.

Effect on the optimiser, measured before and after on the live DB: Blank
Workspace 1 Henderson men 1695.17 → 1691.00, scorer overrides 24 → 18 as six
duplicate rows collapse. Small and explicable.

## The inert cap: diagnosed, and both my hypotheses were wrong

I proposed two explanations for `maxIndividualScorersPerTeam` having no effect.
Both are refuted, and the refutation is pinned in
`scripts/test_scoring_settings_effect.mjs`.

- **Not the PDF path.** `calculatePoints` does have a branch that copies HyTek
  place points and bypasses every cap — but it reads `SwimmerResult.pdfPoints`,
  the *parsed input* column, not `.points`, which is the engine's own *output*
  and is on every scored row. **Zero live rows carry `pdfPoints`.** My "676 of
  920 rows carry points" observation conflated the two columns.
- **Not roster mode.** The cap is equally inert under `points_pool`.

**The mechanism** is `mergeScoringSettings`: when `conference` matches NSISC,
seven fields are unconditionally overwritten with the preset constants *after*
the caller's settings are spread in. Deliberate — the 18-scorer pool is a
competition rule, not a preference, and a coach should not be able to dial it to
999 and produce a fantasy total.

**Working as designed. The remaining defect is a UI one:** both settings panels
still render those seven controls as editable, so a coach can change a number,
save, and watch nothing happen.

## The bad discovery

While measuring the optimiser's before/after — a measurement only needed because
the agent doing it died first — the **Optimize team** button turned out to
destroy the primary planning workspace:

| Workspace | Before | After optimising |
| --------- | ------ | ---------------- |
| Blank Workspace 1, Henderson men | 1383.83 | **1695.17** ✅ |
| HSU 2026-27 Roster Plan, Henderson men | 1277.00 | **0.00** ❌ |

Confirmed pre-existing by stashing this round's work and re-measuring on `HEAD`.
Full write-up: [2026-08-14/12](../2026-08-14/12-optimizer-destroys-score.md).

It connects to the cap finding above: the engine's automatic scorer set ignores
the cap while the optimiser enforces it, so the optimiser "corrects" the roster
down to 18 and, with no meet results to fall back on, the lineup scores nothing.

## What was reverted, and why that mattered

`arbitrage/shared.ts` — an interrupted agent renamed `TeamScoreGroup.ptsEach` to
`ptsTotal` and died before updating its two usages. The tree did not compile.
Reverted to the byte-identical-verified state from `ef98abe0`.

This is the case the "assess, don't trust" rule exists for. Four files of partial
work all looked equally plausible in `git status`; only compiling them separated
the broken one from the good ones.

Its comment recorded a lead worth keeping: **points are awarded per row, not per
distinct name**, so the two counts diverge whenever a team holds more rows than
distinct swimmers in one placement — a duplicate import, or a prelims/finals pair
landing on the same key.

## Standing rule that earned its place

> *A guard is not trusted until it has been seen to fail.*

Applied twice more this round: the parse-plausibility gate was mutation-tested
three ways, and the arbitrage split was proven byte-identical by sha256 over 1.2 MB
of captured output rather than by its tests passing.
