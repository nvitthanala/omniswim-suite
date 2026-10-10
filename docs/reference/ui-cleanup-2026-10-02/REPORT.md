# UI cleanup report — 2026-10-02

## Scope and capture

The shell dev server started with `npm run dev` at `http://127.0.0.1:3000`. Playwright captured the home, manager, matrix, and metrics pages at 1440×1000 in Dark and Light themes before and after the source change. Captures use `domcontentloaded` plus a short render delay because the manager route did not reach `networkidle` within 30 seconds. No page copy or interaction logic changed.

## Changes

| File | Before / after | Change |
| --- | --- | --- |
| `packages/ui/src/components/WizardShell.tsx` | `before/metrics-dark.png`, `after/metrics-dark.png` (also Light equivalents) | Marks the shared workflow shell as a named inline-size container and uses the shared responsive step-grid class. The metrics sidebar now lays out steps in two columns with readable labels, while wider Manager and Matrix shells retain four columns. |
| `packages/ui/src/index.css` | same metrics captures | Adds the `wizard-step-grid` container-query rules: one column below 22rem, two from 22rem, and four from 56rem. Uses existing theme colors and does not alter the pure-black OLED preset. |

The Home, Manager, and Matrix captures are retained as visual checks for both themes; their layout did not change.

## Screenshot files

- Home: `before/home-dark.png`, `before/home-light.png`, `after/home-dark.png`, `after/home-light.png`
- Manager: `before/manager-dark.png`, `before/manager-light.png`, `after/manager-dark.png`, `after/manager-light.png`
- Matrix: `before/matrix-dark.png`, `before/matrix-light.png`, `after/matrix-dark.png`, `after/matrix-light.png`
- Metrics: `before/metrics-dark.png`, `before/metrics-light.png`, `after/metrics-dark.png`, `after/metrics-light.png`

## Checks

- `npx vitest run` — passed: 127 files, 1,815 tests passed, 11 skipped.
- `npm run lint:types` — passed across shell, core, db, manager, matrix, and metrics workspaces.
- `node scripts/run-tests.mjs` — passed: all scripts passed, including Playwright E2E (84 passed, 0 failed, 1 skipped); PostgreSQL round-trip skipped because `PG_TEST_URL` is unset.
- ESLint on `packages/ui/src/components/WizardShell.tsx` — passed. The CSS file is ignored by ESLint because no CSS config is supplied.

