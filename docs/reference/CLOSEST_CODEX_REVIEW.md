# Closest fallback review

## Findings

- **MEDIUM — `tests/fixtures/lp-baseline/lpBaseline.sh:20`.** The EXIT trap removes every `tests/_gold_*.test.ts`, not only copies created by this run. If a developer has an unrelated scratch test matching that pattern before running `check`, the script deletes it on both success and failure. Track the five generated paths and remove only those.

## Review checks

- `lp.ts` derives restricted `t` as the minimum of each lane's shifted constant plus its restricted terms. This is the greatest feasible `t` under all M rows; relaxed lane terms are excluded, and the relaxed model is not passed into fallback. If an unsupported variable reaches local search, `Search` refuses it with `model_mismatch`.
- Fallback proof stays below `proven_optimal`; the proposal gate scores via `scoreMeet`. The restricted LP objective is checked against that score, and the final found value is checked against any recorded upper bound with `model_mismatch`.
- Test 10b enumerates own entry sets and computes totals through whole-meet `scoreMeet`, independently of the LP/search implementation. Its literal floors (14 improvements and 10 brute-force bests) fail the former skip, which yields zero improvements.
- Baseline comparison hashes LP text and compares both hash and length line-for-line. EXIT cleanup runs on script exits; the glob scope is the finding above.

## Checks

- `npx vitest run tests/engineAutoBuildModes.test.ts` — passed (27 tests).
- `bash tests/fixtures/lp-baseline/lpBaseline.sh check` — passed under Git Bash; all five baselines were identical.

