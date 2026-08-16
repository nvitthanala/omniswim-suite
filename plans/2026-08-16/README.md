# Execution round — 2026-08-16

Working through [`plans/2026-08-14/11-sequencing.md`](../2026-08-14/11-sequencing.md).
That folder is the **review** — what is wrong and why. This folder is the
**execution** — what was done about it, including the parts that turned out
differently than the review predicted.

Work is divided across agents on strictly disjoint file scopes and integrated in
one place, so a failure is attributable to one scope rather than to a merge.

## Rounds

| Round | Theme | Status |
| ----- | ----- | ------ |
| [Round 1](ROUND-1-stop-the-bleeding.md) | Network exposure, unmapped-division cuts, tests that could not fail | shipped `2559e429` |
| [Round 2](ROUND-2-inputs-and-structure.md) | Alias resolution in scoring, parse plausibility, the 2,255-line split, docs | in progress |

## Standing rules for this run

1. **Disjoint scopes.** No two agents may edit the same file. The integrator owns
   `scripts/run-tests.mjs` and all cross-scope wiring.
2. **Evidence over assertion.** Anything that changes a number on screen must
   carry a before/after measurement, captured from the live workspaces.
3. **A guard is not trusted until it has been seen to fail.** Every new test gets
   a deliberate mutation to prove it bites, then the mutation is reverted.
4. **Report, do not fix, outside scope.** Latent bugs found while working land in
   the review folder as findings, not in the current changeset.
5. **Corrections are recorded in place**, not quietly edited away — see
   [2026-08-14/02 §2](../2026-08-14/02-data-quality-aliasing.md), where the
   original finding was wrong and the correction is more important than the
   finding was.

## Verification baseline

Every round ends green or does not ship:

```
npm run lint     # clean, 7 packages
npm test         # 52 passed / 0 failed / 3 skipped as of round 1
npm run build    # exit 0
```
