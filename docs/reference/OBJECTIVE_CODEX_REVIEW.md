# autoBuildObjective cross-provider review

Verdict: **accept with fixes**

## Ranked findings

### P1 — `meetsTarget` can disagree with the gate near a scaled boundary

[packages/engine/src/autobuilder/index.ts:265](/C:/Users/nihar/Documents/GitHub/omniswim-suite/packages/engine/src/autobuilder/index.ts:265) compares the unscaled metric with `target - 1e-9`. The solver and gate instead compare scaled integers using `ceil(target * D - 1e-9)` ([solve.ts:231-236](/C:/Users/nihar/Documents/GitHub/omniswim-suite/packages/engine/src/autobuilder/solve.ts:231), [gate.ts:363-366](/C:/Users/nihar/Documents/GitHub/omniswim-suite/packages/engine/src/autobuilder/gate.ts:363)). For example, if a lineup metric is 10 and the scale is `D = 100`, target `10.0000000005` yields `meetsTarget: true` here (`10 >= 9.9999999995`), but the gate requires `ceil(1000.00000005 - 1e-9) = 1001`, so that lineup does not meet the gate target. This is a genuine disagreement in the boundary band. Fix by sharing the gate's scaled target predicate (or exposing the scale and using its integer comparison); add a test with a target just above an exactly representable metric.

### P2 — The equality test does not prove proposal coverage in every mode or restore path

[tests/engineAutoBuildSwaps.test.ts:1517-1523, 1526-1560](/C:/Users/nihar/Documents/GitHub/omniswim-suite/tests/engineAutoBuildSwaps.test.ts:1517) returns zero for results without a proposal and aggregates all modes into `checked > 20`. `robustChecked > 0` likewise only proves one robust result had a proposal. No assertion establishes that the tested proposals include an A9 restored scorer, or even one proposal for each mode and roster setting. The existing `agrees` helper correctly compares a proposal whenever one exists, but these aggregate counters permit those paths to go untested. Fix by asserting per-case proposal coverage, and add a deterministic A9 restore fixture that verifies `autoBuildObjective(...proposal.lineup, proposal.tagsForScoring)` equals the final evaluation, including a restored swimmer with a robust pin.

## Answers

1. The implementation uses the same `scoreLineup` and `evaluationOfScored` path for the final gate candidate and exported evaluation ([gate.ts:205-239](/C:/Users/nihar/Documents/GitHub/omniswim-suite/packages/engine/src/autobuilder/gate.ts:205)). The current lineup also uses those helpers and supplies its already-computed results/load ([autobuilder/index.ts:66-70]). On inspection, tags preserve the roster information relevant to the final candidate: removed scorers lose their tags, joined scorers gain them, and restored scorers regain them. `onRoster` therefore agrees with the scorer-tag set for the proposal's roster, including restored scorers; their entries kept from the removed build are still the entries passed to both robust scorers. Held/frozen entries remain in the lineup passed to both paths. The closest rival is chosen by the same `metricOf` from the same results. So equality holds by construction for the lineup/tags the gate actually returns, subject to the target flag discrepancy above. The new aggregate test does not prove every named mode/restore path was exercised (P2).

2. The refactor appears behavior-preserving by inspection: the old candidate scoring calculations are moved into `scoreLineup`, candidate ownership still comes from `onRoster(problem, built, id)`, and the final evaluation fields still use the same values. The A9 restore loop, raw assignment check, and `model_mismatch` checks are not changed in the reviewed diff. I cannot claim golden outputs or the bench are unchanged: the requested scope supplied no before/after capture, and the task prohibited running Vitest or npm tests. The permitted engine typecheck passed. No runtime result comparison was performed.

3. Pending load settings are **not** skipped: `prepare` calls `checkLoadSettings` before `buildProblem`. The skipped candidate-dependent refusal is an unscheduled event with a candidate; `autoBuild` checks it from the `Space` callback, while `autoBuildObjective` scores the supplied lineup directly. Thus a direct call can score a lineup/request combination that `autoBuild` would refuse. For the dashboard Accept flow, a proposal produced by a successful `autoBuild` request already passed that callback, so this does not invalidate that proposal's re-score. It matters if callers use this export as a general preflight or score arbitrary candidates. The JSDoc at `index.ts:254` incorrectly groups pending settings with the skipped candidate-dependent checks; update it to say only the unscheduled-candidate check is skipped.

4. Yes. The boundary example in P1 demonstrates disagreement when `D > 1`. Ordinary point values well away from the boundary compare consistently, but the API promises a target boolean and must match the gate exactly.

5. Yes. The coverage counters in P2 are aggregate and allow a case/mode to produce no proposal without failing. In particular, the test does not prove that roster swaps with a restore occurred. Existing output comparisons are meaningful for cases that do return a proposal, but the test name overstates guaranteed coverage.

## Blocked on me

None. Golden and bench equivalence remain empirically unverified because this review was read-only and prohibited the test commands.

## Changed

Only this review file. No source or test files changed. `npx tsc --noEmit -p packages/engine/tsconfig.json` passed. Vitest and npm tests were not run.

## Found

P1 target-tolerance mismatch (`autobuilder/index.ts:265`); P2 vacuous aggregate coverage (`tests/engineAutoBuildSwaps.test.ts:1517-1560`). No other gate behavior change found by inspection.

