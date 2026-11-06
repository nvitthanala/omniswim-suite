# A9 AutoBuilder round 2 review

## Blocked on me

none

## Changed

- `docs/reference/A9_CODEX_ROUND2_REVIEW.md` — read-only review of the A9 restore against the MIP rows. No source or test files were changed.
- Checks: source and diff inspection only. Vitest and npm tests were not run, as instructed. TypeScript was not run.

## Found

### Question: No

I found no restore accepted by `restoreIdleRemovals` that leaves the represented MIP assignment infeasible. Consequently, the restore cannot validly score above the MIP dual bound solely because it changes one swappable scorer's `z` from 0 to 1 while retaining the built entries. The raw assignment is first checked against `mipPoints`; post-restore checks govern the only hard constraints that may tighten when the scorer returns.

### Row map

- **`x <= ub*z` (`lp.ts:473`) — verified; it relaxes.** Turning the scorer's `z` to 1 cannot break this upper-link row for any existing `x` or `o` value.
- **Held split `x = z` (`lp.ts:475`) — verified; the entry is represented by `x=1`.** For a current held individual entry, `space.ts:174-181` records it as held, `space.ts:373-376` forces the swimmer into the event column, and `lp.ts:404-407` defines `x` from that column's membership. A removed scorer's held entry stays in the built lineup (`gate.ts:96-97, 110-132`); restoring the tag makes the row's `x=z=1`. Robust frozen current entries also enter `held` (`space.ts:194-204`); the swappable scorer is excluded from `frozenIn`, so its entry is represented by the forced column member and `x`, not an unmodeled fixed entry. Restoring therefore does not violate Z3.
- **Minimum scorer row (`lp.ts:483-488`) — verified; it relaxes.** The row is a lower bound on the relevant `z` sum. Increasing one `z` cannot break it.
- **C1-C3 entry caps (`lp.ts:493-510`) — verified.** Kept entries remain counted by the chosen columns' `x` values; fixed relay counts are constants in `k_R`. If the restored scorer newly exceeds an individual, relay, or total cap, `blockersOf` emits the roster-aware `entry_cap` blocker (`gate.ts:280-282`), and the restore is rejected because that blocker was absent from the raw removed-roster candidate.
- **L1-L2 load (`lp.ts:517-545`) — verified for respect mode, with matching race semantics.** Built event race coefficients come from `columnRaces`, which calls `sessionLoad` on that event's column (`evaluate.ts:350-354`, `load.ts:51-80`); fixed event races also come from `sessionLoad` (`load.ts:83-98`). Thus prelims-finals, split timed-final heat assignment, and other formats use the same race counter in the MIP and gate, rather than an independent approximation. Outside-relaxation certain-race terms are only a bound; their split timed-final treatment intentionally contributes no certain race (`load.ts:101-112`). If restoring the scorer creates a respect violation, the roster-aware `session_load` blocker rejects it (`gate.ts:282-283`). In prefer mode load is an objective penalty, and acceptance compares the re-scored objective.
- **D1-D3 diver indicator and T1 team size (`lp.ts:545-585`) — verified.** Restoring can only increase `z`; a diver indicator `d` may remain zero, or the team-size row can become tighter through the scorer spot. `rosterSpots(..., true)` recomputes the strict roster size before acceptance (`gate.ts:233-236`), including the diver weighting used by the scoring roster. Scoring-team-size blockers are also checked on the final candidate (`gate.ts:284-285, 337`). A restore that would need a different `d` and thereby exceed strict size is rejected by this check.
- **Change terms (`lp.ts:593-627`) — not a feasibility concern here.** They are used as the goal-seek objective, or as a tie-break constraint (`lp.ts:665-684`), not as a general max-changes limit. Goal seek is excluded from restore (`gate.ts:221`). The non-goal tie-break row requires at least the minimum points (equivalently, no more than the chosen change budget); restoring lowers the change count and satisfies that row. I found no separate `K_max` or maximum-changes hard row.

### Open cases resolved

- **Outside pair / relaxed `o`:** `o` is present only in the relaxed model (`lp.ts:411-422`) and its objective coefficient is a safe upper bound for that outside pair. In a non-relaxed model, a current pinned scorer entry is included in `currentColumn` even when it falls outside the top-K candidates (`space.ts:372-376`), so it has a normal `x`/column representation. A held but non-scorable pair is likewise included as forced. A removed scorer with no current entry has no kept entry for restore to score.
- **Relay squad column:** built relays are represented by chosen squad columns. Their `x` counts the swimmer's squads in the column, and `z` links those values (`lp.ts:399-407, 473`); restoring `z` leaves the chosen squads feasible. Outside relay `oR` and `w` columns exist only in the relaxed model (`lp.ts:424-457`) and supply bounds, not a new exact-model scoring entry.
- **Fixed relay:** classification deliberately excludes pinned scorers who appear in a fixed relay from `swap` (`space.ts:149-155`). Such a scorer cannot be the restored `z` under review.
- **Other `z`/`x` rows:** the team-size row is the only additional tightening row tied directly to `z`; it is covered by the strict `rosterSpots` guard. The diver constraints restrict `d` and diving/non-diving `x` combinations; they do not require a value change that makes the existing chosen column infeasible when the scorer returns. Event selection rows are unchanged, and `x` values remain the column-derived values already checked by the solver (`lp.ts:392-407, 789-798`).

### Findings ranked by severity

none. No unmirrored hard row or concrete failing input was found, so no additional restore acceptance check is indicated. Keep the `model_mismatch` guard in `withProposalBest`; it remains useful for detecting a true model/score disagreement.

**Verdict: accept.**
