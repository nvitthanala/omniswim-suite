# Current state: one page

**Updated 2026-10-25.** The project pivots to a Chrome extension on the SwimCloud meet simulator. Start with [plans/2026-10-25/README.md](2026-10-25/README.md) and the state file [docs/reference/REDESIGN_2026-10-25_STATE.json](../docs/reference/REDESIGN_2026-10-25_STATE.json). Active branch: `nvitthanala/extension-redesign`, based on `main@d7d5c976` (PR #7 merged). The standalone suite moves to `legacy/`. The 2026-10-13 notes below are history.

**Updated 2026-10-13.** This page says where the work stands and where to look next. The long history that used to sit here is in [docs/archive/2026-10/STATE_HISTORY_2026-08.md](../docs/archive/2026-10/STATE_HISTORY_2026-08.md).

## Branch and base

- Active branch: `nvitthanala/improvement-plan-2026-10-10`.
- Base: `main@74fe0748`.
- Plan: [docs/reference/IMPROVEMENT_PLAN_2026-10-10.md](../docs/reference/IMPROVEMENT_PLAN_2026-10-10.md). It carries every open item, with a priority order.
- State file: [docs/reference/IMPROVEMENT_PLAN_2026-10-10_STATE.json](../docs/reference/IMPROVEMENT_PLAN_2026-10-10_STATE.json). Read it before you resume. `resumeOrder` names the next item, `onResume` lists what to check first, and `nextBatches` lists the waves still to run.

## Gate baselines

Measured on a quiet tree after wave 2 (`gatesAfterWave2` in the state file).

| Gate | Command | Baseline |
|---|---|---|
| Lint | `npm run lint` | 0 errors, 2 baseline complexity warnings |
| Unit tests | `npx vitest run` | 220 files, 3362 passed, 23 skipped, exit 0 |
| Skip budget | `node scripts/check_skip_budget.mjs` | 23 skipped, budget 23 |
| Script suite and e2e | `npm test` | 86 passed, 0 failed, 1 skipped |
| Extension harness | `npm run test:harness` | 7 passed, 1 skipped (a known `fixme`) |

## Start a session

1. Read the Obsidian vault index, `omniswim-suite/00-INDEX.md`, if it exists on this machine. The repo wins when the two disagree.
2. Set up the machine once: [docs/ONBOARDING.md](../docs/ONBOARDING.md).
3. Read the state file above. Take the next item in `resumeOrder`.
4. Run `git status` and `git log --oneline -5`. The tree is the truth, not a report.
5. Run the gates before you change anything.
6. After each item, rerun the gates, update the state file, and update the vault.

## Open decisions

User decisions U1 to U12 are in section 1 of the plan. The answers already given are in `userDecisions` in the state file. Questions waiting for the user are in `userQuestionsAtEnd`.

## How this work runs

1. **Disjoint scopes.** No two agents edit the same file. The integrator owns
   `scripts/run-tests.mjs` and all cross-scope wiring.
2. **Evidence over assertion.** Anything that moves a number carries a before/after
   from the live workspaces.
3. **A guard is not trusted until it has been seen to fail.** Every new test gets a
   deliberate mutation, then the mutation is reverted.
4. **Report, don't fix, outside scope.** Latent bugs become findings, not diffs.
5. **Corrections are recorded in place.** Six review claims have been wrong so far;
   each is struck through with the measurement that disproved it, because the
   correction is usually more informative than the original.
6. **Assess partial work, never trust it.** Three agents died mid-edit on 2026-08-16;
   one left the tree uncompilable. Only compiling them told the good from the bad.

## The live SwimCloud site

Touching the live site is "a deliberate human-present action, never an automated one". Code comments in `extensions/swimcloud-companion` cite this rule. Decision U12 in the plan sets the one exception: the user authorizes an agent to capture only the named pages through the Claude in Chrome extension, in its own tab group, with the user's own sign-in, at a human pace, and never to commit a capture.

## Where history lives

- [docs/archive/2026-10/STATE_HISTORY_2026-08.md](../docs/archive/2026-10/STATE_HISTORY_2026-08.md): the old body of this file (2026-08-16 to 2026-10-09).
- `plans/2026-*/`: dated plans, reviews and work logs.
- [docs/INVARIANTS.md](../docs/INVARIANTS.md): things true of this codebase that are written nowhere else.
- [CHANGELOG.md](../CHANGELOG.md): user-visible behaviour changes.
