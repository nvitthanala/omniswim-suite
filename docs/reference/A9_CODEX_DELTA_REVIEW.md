# A9 AutoBuilder delta review

## Blocked on me

none

## Changed

- `docs/reference/A9_CODEX_DELTA_REVIEW.md` — added this read-only review. No source, test, or other file was changed.
- Checks: `npx tsc --noEmit -p packages/engine/tsconfig.json` passed. Vitest/npm tests were not run, as instructed.

## Found

### HIGH — A restored scorer can violate respect-mode session load

**Location:** `packages/engine/src/autobuilder/gate.ts:197` (restore condition at line 201).

`restoreIdleRemovals` checks the strict roster-size count and equality of the scoring objective, but it does not check whether adding the swimmer back to the scoring roster creates a hard `respect` session-load violation. `objectiveOfBuilt` computes the load but returns only the objective; it does not reject violations. `addLoad` models `respect` as a hard row (see `packages/engine/src/autobuilder/lp.ts:513-530`), and the gate later checks violations only after restoring (`gate.ts:294`), where a violation becomes `model_mismatch` instead of a proposal.

**Concrete failing input:** `roster: 'propose-swaps'`, finite roster size with room to restore a removed scorer, and `load: { preference: 'respect', ... }`; scorer `s2` has an existing entry in a built timed-final session whose total is at the configured maximum while he is off-roster. The MIP may remove `s2` to satisfy its roster/load assignment; the returned assignment keeps his entry as a non-scorer entry. If `s2` sorts before another removable scorer and the objective is unchanged on re-tagging, this restore adds `s2` to the scoring roster despite his session load being over maximum. The gate then sees the load violation and throws `model_mismatch`. The same case can occur without another removable scorer: the first restore alone is enough.

**Fix:** Before accepting each restore, compute the candidate’s violations and refuse the restore if it adds any hard violation relative to the pre-restore built candidate (in particular `session_load` under `respect`). Keep the existing strict-size check. The final gate should still re-score and run its normal violation check.

### MEDIUM — A legal improving restore is discarded after an early stop

**Location:** `packages/engine/src/autobuilder/gate.ts:201` (unchanged-objective condition; rationale at lines 182-184).

When restoring a scorer raises the objective, the gate leaves the scorer removed. A timeout/incumbent can leave `z = 0` even when putting the scorer back is legal and strictly improves the built lineup. The current build-vs-solver check then motivates keeping this lower objective, but the proposal loses points to a reachable legal roster assignment and can be reported unchanged when the restored candidate would improve.

**Concrete failing input:** finite roster size with slack after the removal; a removed scorer has a scoring entry already present in the built lineup, and adding his scorer tag raises own points (or the selected objective); the solver stops at a feasible incumbent with this scorer removed before it finds/proves the better `z = 1` assignment. There are no entry-cap, strict-diver, or load violations after restoration. The restore is rejected solely because `objectiveOfBuilt(back) !== baseline`.

**Fix:** Preserve the model-mismatch check against the exact raw solver assignment first. Then treat restoration as a separate, gate-validated candidate: allow it when roster size and all hard rules hold, and re-score the final candidate. Do not compare that post-processed candidate’s objective to the raw solver objective; instead retain/check the raw assignment’s score against `mipPoints`, then use the final re-score for improvement/unchanged classification and proposal evaluation. This keeps the solver consistency check sound while permitting a verified legal improvement.

### Reviewed points with no finding

- The synthetic anchor id starts at `\u0000anchor` and is extended until unused across model swimmers, swims, relay splits, scorer tags, and every lineup swimmer reference (individuals and relay legs): `packages/engine/src/autobuilder/evaluate.ts:137-151`. Those cover the id-bearing sources used by `scoreMeet`; opponent/rival references are team ids, not swimmer ids. Test 24 compares a colliding-id run with a control and checks result kind, objective, and proof status, so it is not vacuous for the original collision.
- Restore order is deterministic: genders are traversed in `problem.genders`, and removals are sorted by swimmer id (`gate.ts:193-203`). Each accepted restoration must leave the objective equal to the baseline, and later candidates are checked after the earlier restorations; this can conservatively skip a combination whose individual restorations change the objective, but does not itself make the result nondeterministic or admit an objective change.
- Restoring does not change entries, so it cannot newly violate entry caps or alter relay reconstruction (R71). The strict diver/team-size count is explicitly recalculated with strict semantics (`gate.ts:197-199`). Respect-mode load is the hard-rule gap described above.
- Goal seek is correctly excluded: the spec defines goal seek as minimizing the total change count subject to reaching the target (D5 §4.7); a post-solver restore changes that count and would invalidate the solver’s minimum-change claim. The solver already encodes the roster removal/addition change count.
- Test 12b is not vacuous: it constructs a selected column excluding `s2`, marks `s2` removed, calls the real gate, then asserts the tag is restored, the removal disappears, the entry remains, and change count is recalculated.

**Verdict: accept with fixes.**

