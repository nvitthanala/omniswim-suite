# Meet-import reconciliation against official totals — scoping only, not built

**Date:** 2026-09-14
**Trigger:** `docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md` item 12:
"nothing compares computed team totals to `officialTeamScores` before a
coach trusts an import — exactly the kind of gap that let the ROCK/LU
mapping bug and the Delta State discrepancy go unnoticed until manually
caught."

## 1. Correction to the brainstorm's own premise — the comparison already exists, per team

The claim "nothing compares computed totals to official totals" is not
accurate as stated. `ProjectedActualScore.tsx` (both the Manager and Matrix
copies) already computes `delta = projected - actual` and renders it as a
color-coded badge (`text-points-positive`/`text-points-negative`) wherever
a team's score card renders — confirmed live via
`packages/matrix/src/components/MeetOperationsView.tsx`'s `officialLookup`
(built from `buildTeamScoreLookup`/`officialScoresForGender`, both real,
tested functions — see this session's own fix to their ambiguity handling)
feeding `actualScore` into that component.

**The real gap is narrower: this comparison is per-team-card, not
consolidated.** A coach sees each team's own delta only by looking at that
team's own card. There is no single "this meet's official-score
reconciliation" summary that lists every team/gender combination and flags
which ones disagree, so the ROCK/LU-shaped bug this item is named after —
one team quietly absorbing another's points — would only be caught by a
coach who happened to expand and compare two specific team cards, not by
anything that actively surfaces the mismatch.

## 2. Proposed scope, if taken further

A new, small, pure function — `buildMeetReconciliationSummary(workspace,
gender)` in `packages/core/src/lib`, sibling to `teamScoreMatching.ts` —
that:

- Iterates every team `buildTeamScoreLookup` already resolves for the
  gender.
- For each, reads the same `delta` `ProjectedActualScore` already computes
  (reusing that exact math, not a second copy of it).
- Buckets results into `matched` (delta within a small tolerance, e.g. the
  same `> 0.05` threshold `isMeaningfulDelta` already uses),
  `mismatched` (a real delta on a team with both an official and a
  computed score — the ROCK/LU shape), and `officialOnly`/`computedOnly`
  (a team present in one side but not the other — a different failure
  shape, e.g. a team-name match miss).

One new small UI element — a banner or a checklist-style summary line at
the top of Matrix's Standings step, shown only when `officialTeamScores`
is present for the workspace, reading something like "7 of 7 teams match
official totals" or "2 of 9 teams disagree with official totals — Ouachita
Baptist (+4.0), Rockhurst (−4.0)" with a link/scroll to each flagged team's
own existing card (not a new detail view — the per-team detail this
banner would point at already exists and does not need rebuilding).

## 3. What this does NOT propose

- **No new score-matching logic.** `matchOfficialTeamScore`/
  `buildTeamScoreLookup` already do the real work, including the
  ambiguity-safe fix from this session; this reuses them.
- **No automated "fix" of a mismatch.** A mismatch is a fact for a coach to
  investigate (team-name mapping, a genuinely wrong official PDF, a real
  scoring-engine gap) — this repo's own provenance rules forbid guessing at
  which one it is.
- **No change to `ProjectedActualScore.tsx` itself** — the per-team detail
  stays exactly as it is; this only adds a summary ABOVE it.

## 4. Open questions for the user

1. **Where does the summary live?** Matrix's Standings step (where team
   cards already render) is the natural home, but Manager's own Lineup step
   also reads `officialTeamScores` (`RosterLineupStep.tsx`,
   `TeamRosterPanel.tsx`) — should the same summary appear there too, or is
   Matrix's Standings step the one place a coach is expected to check this?
2. **Tolerance.** `isMeaningfulDelta`'s `0.05` threshold exists to filter
   floating-point noise from a genuine discrepancy — reusing it directly
   assumes it's still the right cutoff for a WHOLE-MEET summary, not just a
   single team's own display. Worth confirming rather than assuming.
3. **`officialOnly`/`computedOnly` teams** — is a team-name mismatch (the
   team exists on one side, absent on the other after fuzzy matching)
   something this feature should flag as its own category, or fold into
   the same "mismatched" bucket? These are genuinely different failure
   causes (a scoring gap vs. a name-matching gap) and probably deserve
   different guidance text.
4. **Effort estimate**, if approved: small. The reconciliation function is
   a thin, read-only wrapper over already-tested primitives; the UI is one
   new summary element reading data the Standings step already computes.
   Real work is mostly in the summary's own wording and the tolerance
   decision above, not new logic.

Not started. No code changed for this item.
