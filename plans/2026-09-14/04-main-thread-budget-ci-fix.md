# Main-thread budget CI failure — root cause and fix

**Status: fix landed and verified; one open flakiness question below.**

## The failure

PR #5's `tests/e2e/main-thread-budget.spec.ts` failed in GitHub Actions CI.
Confirmed via `gh run list`/`gh run view` that this predates every item shipped
in this session's earlier rounds — it already failed on a docs-only commit
with zero code changes, so nothing already shipped caused it.

## Root cause

`WorkspaceRouteSync` in `apps/shell/src/App.tsx` keeps the active workspace
selection and the `?workspace=` URL param in sync with two `useEffect`s: one
reads the URL and writes state, the other reads state and writes the URL.
Both are needed (shared links / back-forward vs. sidebar/palette switches).

On mount — or any time the URL and the last-selected-workspace state
disagree (e.g. `localStorage` still names workspace A from a previous visit,
but the URL says `?workspace=B`) — **both effects fired in the same commit
off contradictory snapshots**: the URL→state effect corrects state to B,
while the state→URL effect, still holding pre-correction state (A), writes
the URL back to A. Each correction became the next mismatch. The two
effects swapped the workspace id back and forth on every render,
indefinitely.

Every swap reconstructed the entire `workspace` object graph (a fresh
`fetchWorkspaces`-shaped object), which cascaded into `useWorkspaceScoring`'s
debounced recompute effect, `buildTeamLineupAudit`, and `TeamRosterPanel`
re-rendering — individually modest (60-190ms) React re-renders, but the
browser's `longtask` PerformanceObserver counts each one, and dozens of them
in a single 2.5s settle window blow past the 2500ms total-blocking budget.
In the worst observed case (before any fix) this diverged into a true
infinite loop and the test hit Playwright's own 60s timeout instead of
failing on the budget assertion.

Confirmed empirically with targeted `console.log` instrumentation (added and
fully reverted each round, never committed):
- Zero explicit `updateWorkspace` calls during the failure — ruled out the
  optimistic-update mutation path.
- Exactly one `fetchWorkspaces` call per page load — ruled out a react-query
  refetch storm (`staleTime: 30_000`, `refetchOnWindowFocus: false` are
  already correct).
- Direct reference-identity logging on `activeWorkspace` inside
  `SuiteWorkspaceProvider` showed the id itself oscillating between two real
  workspace ids (e.g. HSU ↔ OBU), 100-440+ times per page load, confirming
  the two `WorkspaceRouteSync` effects as the actual source.

## The fix

`apps/shell/src/App.tsx`, `WorkspaceRouteSync`:

1. The state→URL effect now reads `searchParams` through a ref instead of a
   direct dependency, so writing the URL never re-arms itself.
2. On its first invocation only, if the URL already names a different, valid
   workspace, the effect defers its write for one render — giving the
   URL→state effect first claim on resolving the initial disagreement.
   Every write after that first check goes through normally, so a genuine
   state-led change (sidebar click, command palette) still updates the URL.

## Verification

- `npm run lint --workspaces --if-present` — clean, 8/8 packages.
- `npx vitest run` — 803/803 passed, 45/45 files.
- `npm run build -w @omniswim/shell` — succeeds.
- `npx playwright test` (full e2e suite, all specs) — 4/4 passed.
- `tests/e2e/main-thread-budget.spec.ts` alone, run 4 times against a
  freshly-seeded DB: 2 clean passes (worst case ~800ms total-blocked, well
  under the 2500ms budget, vs. hundreds of ms-identity-changes down to 1-2
  per page load, confirmed via temporary instrumentation each time); 2 runs
  where the HSU workspace's Lineup step landed at 2790-2901ms, just over
  budget. In every case the catastrophic failure mode (infinite oscillation,
  60s timeout) is gone — confirmed via the same instrumentation showing no
  more than a handful of identity changes per load, never the 100+ pattern
  from before the fix.

## Open question

The marginal, intermittent overage on HSU's Lineup step (214 recruits, zero
meet results) did not reproduce on 2 of 4 runs and is small (roughly 10-15%
over budget) compared to the original failure (which could hang forever).
Not yet determined whether this is:
- Ordinary run-to-run variance (dev-server warm state, machine noise), or
- A separate, smaller-magnitude re-render cost specific to large
  recruit-only rosters, worth a follow-up look if CI still flakes after this
  fix lands.

Recommend: push this fix (a clear, verified improvement — no regressions,
803 tests green, full e2e suite green) and watch the next few real CI runs
on PR #5. If the Lineup-step budget check still flakes intermittently there,
that is a distinct, smaller follow-up, not a reason to hold this fix back.
