# Omni Swim Suite - Phase 3 UI Foundation Handoff

> Living document for the blocking Phase 3 foundation work. Source plan:
> `C:\Users\nihar\.cursor\plans\omniswim_improvement_brainstorm_bbb2a9d7.plan.md`.
> Do not edit the plan file.

Last updated: 2026-06-28.

## Scope Status

| id | status | notes |
|----|--------|-------|
| settings-foundation | DONE | Added core `SuitePreferencesProvider`, localStorage persistence, DOM preference application, and `/settings` route. |
| theme-system | DONE | Added curated preset token blocks, custom accent variable, accent-derived focus/toast/button colors, and preset metadata. |
| text-scale | DONE | Added Compact / Default / Comfortable / Large text scale through `--text-scale` on `<html>`. |
| settings-ui | DONE | Built permanent Settings page with Appearance and Accessibility tabs, live preview, preset swatches, color picker, base mode toggle, and reset. |
| header-settings-link | DONE | Added a persistent header gear link to `/settings`; kept the quick theme toggle as a dark/light flip. |
| typography-audit | DONE (focused) | Removed fixed 7-12px text utilities from shell, `TeamRosterPanel`, `TeamCard`, and Metrics workflow components touched in this pass; older non-hotspot applet panels still have legacy fixed-size labels for a later sweep. |
| component-primitives | DONE | Added lean `@omniswim/ui` primitives: `Button`, `Badge`, `EmptyState`, `SettingsSection`, `SegmentedControl`, plus `AppletSkeleton` for loading states. |
| rewarding-feedback | DONE | Added success feedback for workspace create/rename/delete/restore, scoring settings save, optimizer apply, video open, and Metrics session delete; existing roster import/save/export toasts remain. |
| react-perf | DONE | Added targeted memoization for heavy Matrix/Metrics chart data and simple windowing for large Manager roster tables. |
| empty-states | DONE | Added guided empty states for Manager, Matrix, and Metrics no-video onboarding without adding AI UI. |
| css-regression | DONE | Added a production CSS regression script and wired it into `npm test`. |
| defer-ai | DONE | Confirmed no AI UI/routes were added in Phase 3 shell routes and `/api/analyze-video` still returns 501 while `OMNI_AI_ENABLED` defaults to `false`. |

## Constraints Preserved

- No new AI UI surfaces or AI routes were added. Existing AI-gated behavior remains deferred.
- `packages/core` does not import `@omniswim/ui`.
- `SuiteWorkspaceProvider` public shape was not changed.
- `useWorkspaceScoring` public shape was not changed.

## Files Changed

- `packages/core/src/preferences/types.ts` - preference types, defaults, preset metadata, text-scale values.
- `packages/core/src/preferences/SuitePreferencesProvider.tsx` - core provider, hook, persistence, legacy theme migration, DOM application.
- `packages/core/src/index.ts` and `packages/core/package.json` - exports for preferences.
- `packages/core/src/lib/useThemeColors.ts` - watches preference attributes and returns accent/high-contrast state for charts.
- `packages/ui/src/index.css` - preset tokens, custom accent support, text scale, high contrast, enhanced focus, reduced motion, accent-derived effects.
- `packages/ui/src/components/Button.tsx` - shared token-driven button primitive.
- `packages/ui/src/components/Badge.tsx` - shared status badge primitive.
- `packages/ui/src/components/EmptyState.tsx` - guided empty-state primitive with optional CTA.
- `packages/ui/src/components/SettingsSection.tsx` - reusable settings section wrapper.
- `packages/ui/src/components/SegmentedControl.tsx` - shared segmented control for tabs/text scale controls.
- `packages/ui/src/components/AppletSkeleton.tsx` - per-applet loading skeletons for Manager, Matrix, Metrics, and suite load.
- `packages/ui/src/index.ts` - exports for new UI primitives.
- `apps/shell/index.html` - anti-FOUC bootstrap for stored preferences.
- `apps/shell/src/App.tsx` - provider wiring, `/settings` route, reduced-motion route transition, per-route skeleton fallbacks, scoring settings save toast.
- `apps/shell/src/pages/SettingsPage.tsx` - new permanent settings page, now using shared UI primitives.
- `apps/shell/src/components/SuiteHeader.tsx` - settings gear link and quick theme toggle wiring.
- `apps/shell/src/components/AppletNav.tsx` - shell nav text token cleanup.
- `apps/shell/src/components/WorkspaceSidebar.tsx` - shell typography cleanup and workspace/snapshot feedback polish.
- `packages/manager/src/ManagerApp.tsx` - guided empty state and optimizer apply toast.
- `packages/manager/src/components/TeamRosterPanel.tsx` - lightweight roster row windowing for teams above 80 athletes and semantic text scale cleanup.
- `packages/matrix/src/MatrixApp.tsx` - guided empty state for no active workspace.
- `packages/matrix/src/components/TeamCard.tsx` - memoized TeamCard, stabilized grouped chart/table data, and semantic text scale cleanup.
- `packages/metrics/src/MetricsApp.tsx` - guided no-video empty state and extra session/video feedback.
- `packages/metrics/src/components/VideoPlayer.tsx` - semantic text scale cleanup for manual tracking controls.
- `packages/metrics/src/components/RaceSetupForm.tsx` - semantic text scale cleanup for setup labels.
- `packages/metrics/src/components/MetricsDashboard.tsx` - memoized dashboard/card rendering, stabilized split chart data, and semantic text scale cleanup.
- `scripts/test_theme_css.mjs` - new production CSS regression check for chart heights, theme presets, accent tokens, and text-scale tokens.
- `scripts/run-tests.mjs` - added `test_theme_css.mjs` to the main test runner.
- `PHASE3_UI_PROGRESS.md` - this handoff.

## Verification

Completed:

```powershell
npm test
```

Result: PASS on 2026-06-28 (final integration verification). 10 passed, 0 failed, 2 skipped for optional local NSISC fixtures.

```powershell
npm run build
```

Result: PASS on 2026-06-28 (final integration verification). Vite production build and bundled shell server completed successfully.

```powershell
npm run lint -w @omniswim/ui
```

Result: PASS on 2026-06-28.

```powershell
npm run lint -w @omniswim/metrics
```

Result: PASS on 2026-06-28.

```powershell
node scripts/test_theme_css.mjs
```

Result: PASS on 2026-06-28. The script builds production assets and verified `.h-64`, `.h-72`, `.text-ui-micro`, `[data-theme-preset]`, `[data-text-scale]`, `--text-scale`, `--text-ui-micro`, and `--custom-accent` in emitted CSS.

Attempted:

```powershell
npm run lint
```

Result: FAIL. Existing workspace TypeScript resolution issues remain, including missing `@google/genai` in `apps/shell/server.ts` and unresolved `@omniswim/core/lib/*` imports from package-local `tsconfig` runs. Production build and `npm test` still pass.

```powershell
npm run lint -w @omniswim/manager
npm run lint -w @omniswim/matrix
```

Result: FAIL on 2026-06-28. Same package-local TypeScript path resolution limitations remain for `@omniswim/core/lib/*` imports; the production shell build still resolves these paths and passes.

Integration spot-checks:

- Plan todo parity check: `PHASE3_UI_PROGRESS.md` now reflects all current plan todos, including `defer-ai`.
- Key worker-touched file checks passed for route/provider/header/app shell wiring (`apps/shell/src/App.tsx`, `apps/shell/src/pages/SettingsPage.tsx`, `apps/shell/src/components/SuiteHeader.tsx`, `packages/core/src/preferences/SuitePreferencesProvider.tsx`, `packages/core/src/lib/useThemeColors.ts`, and applet entry files in Manager/Matrix/Metrics).
- AI deferral remains intact: no `/ai` shell route introduced; server still gates AI parsing behind `OMNI_AI_ENABLED` and returns 501 for `/api/analyze-video`.

## Handoff Notes

- React performance changes are intentionally scoped: no state manager rewrite, no scoring engine rewrite, lazy applet chunks and scoring worker remain intact.
- Manager roster windowing only activates for selected-team rosters above 80 rows; smaller rosters keep the original full table render.
- The CSS regression test runs a production build inside `npm test`, so test runtime is slightly longer but now guards the Tailwind `@source` chart-height/token regression directly.
- Core still does not import `@omniswim/ui`; all new primitives live in `packages/ui` and are consumed from shell/applets only.
- This pass cleaned the shell and requested applet hotspots. A repository-wide search still shows legacy fixed-size labels in lower-priority applet panels such as scoring settings, meet operations, recruit forms, and relay management.
- Cross-worker consistency note: the branch still contains large pre-existing tree-move churn (`omniswim-suite/*` renames/deletions and generated artifact churn). This verification pass did not rewrite that history, but build/test outcomes indicate Phase 3 UI integration remains healthy in the current root layout.

## Next Steps

- If time allows in later Phase 3 work, continue the broader typography sweep across the remaining lower-priority Matrix/Manager panels listed in the handoff notes.
- Browser/CSS regression remains assigned to the separate worker; this pass intentionally used focused TypeScript/build verification only.
