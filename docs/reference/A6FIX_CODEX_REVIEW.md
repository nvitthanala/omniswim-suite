# A6 AutoBuilder review

## Verdict: accept with fixes

## Blocked on me

None. Review was read-only; no test commands were run.

## Changed

Created this review only: `docs/reference/A6FIX_CODEX_REVIEW.md`.

## Found

### High — pruning can remove the only strict-team-size-feasible column

**Location:** `packages/engine/src/autobuilder/space.ts:450` (predicate), with strict diver semantics documented in `plans/2026-10-25/D5-AUTOBUILDER.md:264` and enforced by `packages/engine/src/model/results.ts:1002-1005`.

The pigeonhole argument establishes equivalent scoring only. It does not establish equivalent strict diver weight. Example: a rostered swimmer has a current diving entry, a numeric diving cap of 1 with `removed-from-consideration`, and adding a second faster diver makes the current diver over-cap. If the current diver's column member is pruned, the solver can drop that diving entry, so that rostered swimmer is no longer counted as a diver by the strict rule. The swimmer's weight rises from the diver fraction to a full spot and can breach the team-size limit; the retained column with the non-scoring diving entry could be the only feasible optimum. This is a concrete class of failure even when the entry is removed from places: `teamSizeViolations` counts the diving entry independently of its score/place.

**Fix:** do not apply this prune to diving columns when strict diver weight is active, or prove the removed member cannot change `divers` classification (including its relay-entry condition) before pruning. Keep the current column as today.

Other scrutinized cases: removed-from-consideration entries are deleted before event ranking (`model/results.ts:1073-1079`), so they cannot continue to bump an opponent's place; a relay leg elsewhere remains because the column change does not change roster membership; current entries, held/frozen members, and all split-format events are excluded from the prune count/path. Session load's respect constraints only improve when a removable non-split race is omitted; prefer uses load as a penalty and likewise cannot be worsened by fewer races. The cap admission is by rank and deterministic, so among more than `cap` counted members at least one is in fact removed, including at a tie boundary.

### Medium — fallback test 4 manufactures its bound from the local-search answer

**Location:** `tests/engineAutoBuildFallback.test.ts:461-474`.

The revised test probes the implementation, derives `found` from that run's local-search output, and injects that exact number as the relaxed solve's dual bound. This verifies the particular status behavior for an equal number, but it no longer exercises the prior fixed fixture's independently determined relationship between local-search result and bound; the test is coupled to the implementation and could follow a regression that changes the answer. It is not strictly vacuous: it still asserts `gap === 0` and status `gap` when only a local-search proposal is available.

**Fix:** choose a deterministic fixture and a fixed, independently computed dual bound strictly equal to its expected local-search objective (or preserve a separately asserted oracle value); assert the probe's objective against that value before using it. Confirm that treating this local-search result as an incumbent is intentionally distinct from a verified MIP incumbent under the proof spec.

### Low — other test edits

**Locations:** `tests/engineAutoBuildFallback.test.ts:380-388`, `tests/engineAutoBuildRobust.test.ts:324-332, 521-530`, `tests/engineAutoBuildSwaps.test.ts:823-830, 875-912`, `tests/engineAutoBuild.test.ts:416-420`, `tests/engineAutoBuildModes.test.ts:800-807`.

The 400-to-20,000 seed draw increase strengthens the random-seed coverage and does not weaken an assertion. Robust test 5's `ownPoints: 20` matches the documented normal-seed scoring while robust objective remains 16; removing the old `ownPoints < current.ownPoints` expectation corrects an invalid assertion, and the new one-change assertion is useful. The 2b control's retained F entry plus G and one change matches the cap semantics and intended tie-break. Swap and brute-force tests now require equality on the fewest-change oracle; these strengthen coverage. No other changed assertion appears weakened.

### Proof status

For ordinary individual events, the prune's score and change-count dominance argument is sound. The strict diver feasibility hole above means `proven_optimal` can still overstate optimality when that restriction binds: the optimized columns may omit a feasible, better lineup. The `types.ts` comment at `packages/engine/src/autobuilder/types.ts:213-216` therefore overclaims that this prune loses no optimal lineup until the diving case is excluded or handled. I did not identify another false-proof case in the requested modes from the reviewed code. No typecheck or tests were run, per the task constraints.
