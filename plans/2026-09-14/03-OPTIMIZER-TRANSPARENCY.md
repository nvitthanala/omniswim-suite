# Optimizer transparency — scoping only, not built

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

## 3. Proposed scope, if taken further

1. **Small, UI-only:** a persistent (dismissible, not auto-fading) summary
   panel replacing the current toast for `applyLegacy`/`applyAll`/the
   guarded-mode apply, listing `appliedStages`, the aggregate gain, and
   each individual override/entry-plan change from the result object
   already returned. No `rosterOptimizer.ts` change.
2. **Medium, one core change:** add a lightweight
   `consideredButRejected` (or similarly named) field to `OptimizerResult`
   for the specific case the brainstorm's own example describes — an
   athlete who would have improved the score but was excluded by a cap —
   verified with the same golden-output-over-3-workspaces discipline this
   file's other fixes already used.
3. **Small, new pattern reused from elsewhere:** one-shot "Undo this
   optimize" following `lastAliasLink`'s existing shape, scoped to the
   single most recent optimizer run in that session (not a full history
   stack).

These three are independent and could ship in any order or subset.

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
