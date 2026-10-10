# UI phase 3 report (2026-10-03)

Athletes step and shared team bar. Branch `nvitthanala/ui-simplification`.

## Changed
- Manager step "Source" is now "Athletes".
- New `Disclosure` primitive (`packages/ui`), new `WizardShell` `subheader` slot.
- Athletes step: one "Meet and rules" card; four tools under one collapsed "More tools".
- One team bar (`ManagerTeamBar`) replaces per-step team selects.
- "Inject recruit" is now "Add swim". Intro paragraphs and subtitle removed.
- One "Export entries" menu (CSV and HyTek).
- Copy-meet labels say what each path copies (Manager: scoring rules; Matrix: psych sheet).

## Checks
- vitest 138 files, 1862 passed. Types clean. Lint 0 errors (2 existing warnings).
- Playwright 8 passed on a data copy. `data/omniswim.db` hash unchanged.
- `test_scoring_preset_routes.mjs` fails on port 3209 (pre-existing since Phase 1).
- Deliberate breaks made tests fail, then were restored.

## Found, not fixed
- `WorkspaceRouteSync` (`apps/shell/src/App.tsx:34`) swaps workspace ids about 30 times a second on a cold `/manager?workspace=<id>` load. Reproduces on HEAD.
- Header "Recalculating..." never settles for the fixture workspace.
- Stale test workspaces (`ui-ia-*`, `ui-phase-2-*`) sit in the real db and slow `main-thread-budget`.
- Three `meets-startup-*` backups appeared in `data/backups` that this work cannot explain.
