# E1 code review

## Findings

- **LOW — no objective change found** (`packages/engine/src/autobuilder/gate.ts:225`). `objectiveOfScored` preserves the prior evaluation expression `target === null ? value - penaltyPoints : value`; restore previously used `value - penaltyPoints` unconditionally. In goal-seek mode a candidate with a nonzero own-only penalty could therefore have been rejected during restore even though the MIP objective and gate target use the metric alone. The new helper fixes that path; this is a behavior change in goal-seek restore, not a purely structural merge. Regular, margin, closest, and robust modes still use metric minus penalty; goal seek uses metric alone. Gate check scaling and signs remain unchanged for those modes.
- **MEDIUM — time reserve is not a hard bound** (`packages/engine/src/autobuilder/explain.ts:70-73`). The clock is checked before each charge, then an entire `scoreMeet`, `sessionLoad`, or evaluator call runs. If one such call takes more than the remaining 100 ms, explanation can continue past the request limit before the next charge. The work-unit benchmark does not establish a wall-clock maximum for a single unit.

No silent explanation truncation or non-prefix output found in the work-limit path: the current item is buffered in `swimmerFacts` and appended only after it completes; `onLimit` counts the current and remaining whole items. `autoBuild` attaches the callback result to `explanationLimit`. The tests added for work limits, prefix order, omission counts, and time guard exercise behavior that the old unbounded implementation lacked and should fail against it; they were not run against a reverted tree.

## Checks

- `SKIP_BUDGET_ENV=local npx vitest run tests/engineAutoBuildExplain.test.ts tests/extensionSessionPlannerSubscribe.test.ts` — passed, 2 files / 46 tests.
- `bash tests/fixtures/lp-baseline/lpBaseline.sh check` — blocked: this Windows environment has no `/bin/bash` (`CreateProcessCommon: execvpe(/bin/bash) failed`).
