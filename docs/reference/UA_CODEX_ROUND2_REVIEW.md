# U-a dashboard shell: round two delta review

- **a. No defect after `onDisconnect`; LOW race before its callback** — `apps/extension/src/dashboard/panelPort.ts:55`; `apps/extension/src/dashboard/main.tsx:260`. An old port's callback cannot clear a newer port because main checks identity. Once disconnect has been handled, posts use `null`; before that callback runs, a send can still target the disconnected port and may throw. The panel-port test checks close notification, not this send race or main's identity guard.
- **b. LOW: in-flight refresh can update state after unmount** — `apps/extension/src/dashboard/tabHost.tsx:204-206`. Cleanup unsubscribes, including the async watch setup race in the test wiring, so the subscription does not persist. But if a settings notice starts `refresh()` and the view unmounts while `repo.list`/reads are pending, its promise still calls `setMeets`/`setTheme` (or `setMessage`). Test checks listener cleanup, not this in-flight case.
- **c. LOW: singleton run is invisible** — `apps/extension/src/dashboard/ScoreChart.tsx:157-170`. A team first present only at the final step, or with a gap at step 0 and just one later total, gets a one-coordinate polyline; SVG strokes do not render a lone point. Later appearances and step-0 gaps are otherwise included/split correctly.
- **d. No defect** — `apps/extension/src/dashboard/ScoreChart.tsx:123,189,208`. Missing final totals become “total missing” in the aria label and “missing” in legend/table; no `0` fallback remains there.
- **e. Yes, with coverage limits** — the new port-close, cross-context settings, missing-chart, and label-budget assertions exercise behavior absent before the fixes and should fail on the pre-fix code. They do not cover the post race, in-flight unmount, or singleton-polyline edge case above.

## Blocked on me

None.

## Changed

Added this review only. Focused Vitest: 3 files, 40 tests passed. PowerShell required `$env:SKIP_BUDGET_ENV='local'` to set the requested environment.

## Found

Two remaining edge cases: in-flight settings refresh after unmount and invisible one-point chart runs. No unrelated files edited.
