# AutoBuilder Accept wiring review

Run: `run_e6f71b7ad7bb`. Scope: the requested AutoBuilder protocol, worker, client, Accept wiring, and changed tests. No source changes made.

## Findings

### P2 — Fixed epsilon can reject a real strict improvement

[`autoBuilderAccept.ts`](../../apps/extension/src/dashboard/autoBuilderAccept.ts#L135) requires `proposed > current + 1e-9`. Equal values are correctly rejected; the epsilon cannot allow an equal objective through. It can, however, block a real positive gain smaller than `1e-9` in objective units. For example, a scaled integer comparison with `D = 2,000,000,000`, current `100`, and proposal `100 + 1 / D` represents a one-unit gain, but the fixed epsilon rejects it. The engine’s target rule compares rounded scaled integers in [`mode.ts`](../../packages/engine/src/autobuilder/mode.ts#L18), while gate validation uses the run scale in [`gate.ts`](../../packages/engine/src/autobuilder/gate.ts#L292). Fix by comparing at the agreed run scale with integerized values (and using the same scale for the re-scored current and proposal), or by applying the spec’s strict numeric `proposal > current` without an unrelated fixed epsilon. The tests cover exact equality and ordinary gains, but not a positive sub-epsilon gain.

### P2 — Accept’s refusal drops the engine error subject

The worker serializes `code` and `subject`, and `AutoBuildClient` reconstructs both in `AutoBuildRunError` ([`autobuilder.ts`](../../apps/extension/src/worker/autobuilder.ts#L67), [`autobuilderClient.ts`](../../apps/extension/src/dashboard/autobuilderClient.ts#L35)). But [`verifyProposal`](../../apps/extension/src/dashboard/autoBuilderAccept.ts#L123) formats only `code` and `message`; its caller receives no subject. Concrete sequence: a robust score raises `robust_no_spread` with subject `robust`; the client error has both fields, but Accept returns `The fresh score could not be computed (robust_no_spread): ...` without `robust`. Preserve the subject in the refusal reason (and assert it in the Accept test at `tests/extensionAutoBuilderAccept.test.ts`).

## Checks

1. **Objective units:** `AutoBuildScore.objective` is used directly for the current and proposal. That is the right run metric for max-own, margin/closest, robust, and `prefer` penalty; goal seek uses `after.meetsTarget`. `current_infeasible` deliberately skips the strict-improvement rule. The fixed epsilon issue above is the only comparison concern found.
2. **Fresh tags and request:** both score calls receive the same request object and the same re-suggested opponent tags. Own tags come from each lineup’s corresponding tag set, so proposal roster adds/removes are represented. `proposal.scaleD` is passed to the proposal score. That scale affects goal-seek target evaluation, matching `autoBuildObjective`’s contract; the non-goal-seek objective value itself is not quantized by that argument.
3. **Protocol and cancellation:** protocol engine imports are all type-only, and dashboard code does not import `autoBuildObjective`. The client allocates monotonically increasing IDs shared across run and score messages, routes score replies through the scoring map, and routes run replies through the active run ID. Cancelling an active run terminates the worker and rejects pending scores; a late reply from that worker is ignored by the worker-identity check. Worker error and messageerror reject pending requests. Engine errors retain code and subject on `AutoBuildRunError`; Accept currently drops subject as noted above. No pending-forever sequence was found for valid score requests.
4. **Write race:** the two input/snapshot checks, `changeRev()` read, tag revision planning, and atomic `putMany` remain after both scoring awaits ([`autoBuilderAccept.ts`](../../apps/extension/src/dashboard/autoBuilderAccept.ts#L120), [`autoBuilderAccept.ts`](../../apps/extension/src/dashboard/autoBuilderAccept.ts#L237)).
5. **Tests:** no vacuous assertion found. The new tests exercise objective modes, roster-add tags, scale propagation, engine refusal, worker response, and cancel behavior. Coverage gaps: no sub-epsilon gain test, no explicit late-`score-done` after cancel assertion, and no client assertion for error subject. The late reply is safely ignored by inspection.

TypeScript check: `npx tsc --noEmit -p apps/extension/tsconfig.json` passed. Per instruction, Vitest and npm tests were not run.

## Verdict

**Accept with fixes.** Address the strict comparison precision and preserve the engine subject in Accept refusals.

## Blocked on me

none

## Changed

[`WIRE_CODEX_REVIEW.md`](WIRE_CODEX_REVIEW.md) — added this review report only.

## Found

Two P2 findings: the fixed comparison epsilon can reject a representable real improvement, and Accept’s score-failure reason omits the engine subject. No other blocking defect found in the requested wiring.
