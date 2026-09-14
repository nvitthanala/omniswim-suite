# Optimizer transparency

**Status 2026-09-14: all three pieces shipped.** See §3.

**Date:** 2026-09-14
**Trigger:** `docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md` item 11:
"`BatchOptimizerPanel` and the individual optimizer panels show a completed
aggregate with no accepted/rejected breakdown, exact deltas, or undo."

## 1. Correction to the brainstorm's own premise — the underlying data already exists

`OptimizerResult` (`packages/core/src/lib/rosterOptimizer.ts`) already
carries `outcome` (`'unchanged' | 'improved'`), `appliedStages`
(exactly which stages ran: `'scorers'`, `'events'`, `'scorers+events'`, or
`'none'`), and `unguardedTotal` (what the optimizer would have returned
without its own never-loses guard) — this is real, already-computed
per-run detail, not something that needs new optimizer logic to produce.
`RosterOptimizeStep.tsx` already reads all three fields.

**The real gap is narrower: this detail reaches only a one-line toast.**
`` `${team}: +${gain.toFixed(1)} pts → ${result.projectedTotal.toFixed(1)}
(${result.appliedStages})` `` is everything a coach sees — an aggregate
gain and which stages ran, gone as soon as the toast fades. What the
brainstorm actually wants (an accepted/rejected breakdown, and undo) needs
new UI and, for the "rejected" half specifically, new data the optimizer
does not currently expose at all.

## 2. What's missing, broken into the two real halves

### 2a. "What exactly changed" — mostly a UI gap, not a data gap

`result.overrides` (`ScorerRosterOverride[]`) and `result.meetEntryPlans`
are the literal write patches already applied to the workspace — the
"accepted changes" are already sitting in the result object, just never
rendered as a list. A persistent (not toast-only) summary panel could list
each override/entry-plan change by athlete name, reusing data already
computed, no optimizer change needed.

### 2b. "What was rejected/considered" — a real, new data gap

Nothing in `OptimizerResult` currently records candidates the optimizer
considered and did NOT choose, or specifically which athletes an
entries-cap decision pushed out. Surfacing "rejected" changes as the
brainstorm asks would need the optimizer's own internal candidate-ranking
step (`rosterOptimizer.ts`'s pool-admission logic, the same code this
session's merged `fix-scoring-roster-integrity` branch touched for the
tie-group/pool-cap fixes) to additionally report what it passed over, not
just what it kept. This is a real, if contained, addition to
`rosterOptimizer.ts`'s own return shape — not just a UI change.

### 2c. Undo

No optimizer-run-specific undo exists today. The closest existing pattern
in this codebase is `RosterImportWizard.tsx`'s `lastAliasLink`/
`handleUndoAliasLink` — a component-local "last action" snapshot with a
single dedicated Undo affordance, not a general history stack. The same
shape (snapshot the workspace patch just before `onUpdate`, offer one
"Undo this optimize" action that re-applies the pre-optimize values) would
fit an optimizer run without inventing a new undo architecture — but it
is genuinely new code, not a rendering change over existing data, since no
"pre-optimize snapshot" is currently kept anywhere.

## 3. Scope, and what shipped 2026-09-14

1. **✅ SHIPPED — small, UI-only.** `OptimizerChangeSummaryPanel`, a
   persistent (dismissible, not auto-fading) panel alongside the existing
   toast (kept, not replaced — a deliberate lower-risk default, see
   `08-Open-Decisions-For-You.md` item 16 in the Obsidian vault) for
   `applyTeam`/`applyLegacy`/`applyAll`, listing `appliedStages`, the
   aggregate gain, and each individual override/entry-plan change from
   `diffOptimizerChanges` — a real diff against the workspace's pre-run
   state, not "every override the result carries" (see that function's own
   doc comment for the accuracy trap this avoided). No `rosterOptimizer.ts`
   change for this piece.
2. **✅ SHIPPED — the core change.** `optimizeScorersForTeam` now returns
   `{ overrides, rejected }` instead of a bare array; `rejected` is computed
   from the FINAL accepted state (after the local-improvement flip pass,
   not just the initial rank-and-cap pass, so it never disagrees with who
   is actually on the roster), each entry carrying `points` and
   `behindByPoints` (points behind the lowest-scoring athlete who DID make
   the cap). Threaded onto `OptimizerResult.consideredButRejected` from all
   three optimizer entry points (`optimizeRosterForTeam`,
   `optimizeRosterAllTeams`, `optimizeWithArbitrage`) and rendered in
   `OptimizerChangeSummaryPanel` (closest misses first, capped at 10 shown
   with a "+N more" note). Diagnostic only — never feeds back into which
   candidate the guard accepts. Verified against real data
   (`scripts/test_roster_optimizer.mjs`): a cap wider than the roster
   rejects nobody, a cap of 1 rejects real candidates, and the rejected set
   is always disjoint from the actual final scorers.

   **A real finding while testing this**: NSISC's scorer cap is locked by
   `mergeScoringSettings` whenever `workspace.conference` is NSISC
   (deliberate — competition rules, not a preference, see
   `NSISC_LOCKED_SETTING_KEYS`), so a naive test that tried overriding the
   cap on a real NSISC workspace silently had no effect and produced a
   confusing false failure. Fixed by cloning the workspace with `conference`
   cleared for the cap-override tests specifically — not a bug in the new
   code, but worth recording so nobody re-trips on it.
3. **✅ SHIPPED — small, new pattern reused from elsewhere.** One-shot "Undo
   this optimize" in `OptimizerChangeSummaryPanel`, following
   `lastAliasLink`/`handleUndoAliasLink`'s exact shape
   (`RosterImportWizard.tsx`): a component-local snapshot of the
   pre-run state (`captureBeforeState()`) plus one dedicated Undo button,
   scoped to the single most recent APPLIED run in that session — lost on
   refresh, not a history stack, same as the pattern it follows.

   **A real design bug caught and fixed before shipping, not after**: the
   undo snapshot and the displayed change summary are set together on every
   *applied* run, but a coach can run the optimizer again and get
   `outcome: 'unchanged'` without applying anything — if the undo slot were
   left alone on that path, the panel would show "no change" while still
   offering to undo an EARLIER, different, already-superseded run, which is
   exactly backwards. Fixed by clearing the undo slot on every `unchanged`
   branch, not just on team switch.

## 4. Open questions for the user

1. **Priority among the three pieces above.** #1 is safe and cheap; #2
   touches the optimizer's own candidate-selection code, the highest-
   stakes part of this codebase per `CLAUDE.md`'s own delegation table
   (routed to `executor`, not `worker`, regardless of how small it looks);
   #3 is a UI pattern this codebase already has a template for.
2. **Does "undo" need to survive a page reload / app restart**, or is an
   in-session-only undo (lost on refresh, matching `lastAliasLink`'s own
   scope today) sufficient?
3. **Effort estimate**, if approved: #1 alone is small (a day or less,
   UI-only). #2 is medium and belongs to `executor` given the stakes
   involved in touching candidate-selection logic in the scoring/roster
   core. #3 is small, following an established pattern.

Not started. No code changed for this item.
