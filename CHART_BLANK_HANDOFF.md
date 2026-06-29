# Handoff: Blank Matrix Charts (Border + Legend, No SVG)

Last updated: 2026-06-29  
Status: **RESOLVED** — root cause was stale dev server on port 3000 serving pre–eighth-pass bundles  
Latest verified commit: `6090023f` (CI green: lint, 20 tests, build)

Do not edit plan files in `.cursor/plans/`. This document is the operational handoff for the next engineer.

---

## Symptom (confirmed by user, multiple sessions)

After loading a meet PDF in Matrix (e.g. NSISC):

| Renders | Does not render |
|---------|-----------------|
| Chart **border** (ChartShell container) | Grid, axes, or lines inside the border |
| HTML **legend** below timeline (team colors/names) | SVG chart data |
| Scoring numbers / standings | `.recharts-wrapper` content (often) |

**Console error (user-reported, persists after eighth pass):**

```
The width(-1) and height(-1) of chart should be greater than 0,
please check the style of container, or the props width(100%) and height(100%),
or add a minWidth(0) or minHeight(undefined) or use aspect(undefined) to control the
height and width.
```

Source: Recharts 3 `ResponsiveContainer` → `SizeDetectorContainer` (`node_modules/recharts/lib/component/ResponsiveContainer.js` ~line 144). This warning means something in the runtime tree is still using **ResponsiveContainer with default `width="100%" height="100%"`**, not the intended `StaticDiv` path (numeric `width`/`height` + `responsive={false}` on `LineChart`/`BarChart`/`AreaChart`).

User also reported ~12 warnings in one session (count uncertain — may correlate with expanded TeamCards or StrictMode double-mount).

---

## What is NOT the problem

- **Empty scoring data** — legend uses same `timelineData` / `teamsWithLineStyles` as the chart; `scripts/test_chart_data.mjs` passes.
- **Missing commits** — fixes through eighth pass are on `main` and pushed.
- **Prod stale `dist/` in dev** — `apps/shell/server.ts` uses Vite middleware in dev (`Start-OmniSwim-Suite.bat` → `npm run dev`).
- **Unit/DOM regression tests** — `npm test` passes (12 passed), including `scripts/test_chart_render.mjs` full-stack happy-dom test.

The gap is: **tests pass in happy-dom; a stale process on port 3000 still served old chart code in the real browser.**

### Resolution (2026-06-28)

Playwright E2E against a **fresh** dev server confirms eighth-pass charts render correctly:

| Check | Result (fresh server) |
|-------|----------------------|
| `data-chart-live-ready` | `"true"` |
| `data-chart-w` / `data-chart-h` | 963 × 230 |
| `.recharts-responsive-container` | **null** |
| `svg.recharts-surface` | 963 × 230, grid + lines present |
| Console `width(-1)` warnings | **0** |

**Stale server (same machine, old PID on port 3000):** `.chart-shell` missing, 2× `.recharts-responsive-container`, 4× `-1` warnings — matches user reports.

**Fix for users:** Kill port 3000 (`Start-OmniSwim-Suite.bat` → Kill stale process), restart dev server, Ctrl+Shift+R.

**Regression coverage added:**

- `tests/e2e/matrix-chart.spec.ts` — Playwright against real Vite dev server (wired into `npm test` and CI)
- `scripts/test_chart_bundle.mjs` — no ResponsiveContainer/SizedChart in source; single recharts version
- `scripts/chart_browser_diagnostic.mjs` — manual Phase 0 checklist runner
- `packages/matrix/src/components/ChartStaleBundleGuard.tsx` — in-app banner when stale cached JS is detected; offers reload
- `scripts/clear-vite-cache.mjs` + `scripts/free-port.mjs` — run on `npm run dev` via `predev`
- `apps/shell/vite.config.ts` — `Cache-Control: no-store` for dev assets

---

## Current architecture (eighth pass — `dfa378cb`)

### Integration pattern (all chart call sites)

```
ChartShell (measure + ready gate)
  └─ ChartFrame (pixel div: chart-shell__chart)
       └─ LineChart | BarChart | AreaChart
            width={Math.floor(width)}
            height={Math.floor(height)}
            responsive={false}
```

**Call sites:**

| File | Charts |
|------|--------|
| `packages/matrix/src/components/MeetOperationsView.tsx` | Timeline `LineChart`, meet momentum `MomentumChartCard` |
| `packages/matrix/src/components/TeamCard.tsx` | Event `LineChart`, class `BarChart`, team momentum `MomentumChartCard` |
| `apps/shell/src/pages/AnalyticsPage.tsx` | Season trends `LineChart` |
| `packages/metrics/src/components/MetricsDashboard.tsx` | Velocity `AreaChart` |

**No `ResponsiveContainer` or `SizedChart` in source** (SizedChart deleted in seventh pass). Grep the repo to confirm before changing.

### Key UI primitives

| Component | Path | Role |
|-----------|------|------|
| `ChartShell` | `packages/ui/src/components/ChartShell.tsx` | ResizeObserver on viewport + shell; **live-only** `ready` gate; diagnostics `data-chart-ready`, `data-chart-live-ready`, `data-chart-w`, `data-chart-h` |
| `ChartFrame` | `packages/ui/src/components/ChartFrame.tsx` | Fixed pixel wrapper div; returns null if w/h ≤ 8 |
| CSS | `packages/ui/src/index.css` | `.chart-shell--{sm,md,lg,fluid}`, `.chart-shell__viewport` (absolute inset 0), `.chart-shell__chart` |

### Vite / monorepo

- Root: `apps/shell/vite.config.ts`
- Aliases: `@omniswim/ui` → `packages/ui/src`, `@omniswim/matrix` → `packages/matrix/src`
- `resolve.dedupe: ['react', 'react-dom', 'recharts']`
- `resolve.alias.recharts` → `node_modules/recharts`
- `optimizeDeps.include: ['recharts', 'react', 'react-dom']`
- Manual chunks: recharts → `vendor-charts`; ui/core → `shared-suite`; matrix → `applet-matrix`

Monorepo flatten merge: `0efe7932`. Tailwind `@source` in `packages/ui/src/index.css` scans all package src dirs.

### Recharts version

- `recharts@^3.8.1` in `apps/shell`, `packages/matrix`, `packages/metrics`
- Default cartesian `responsive: false` in Recharts 3
- SVG renders only when Redux layout width/height > 0 (`ReportChartSize` in `useEffect` — one frame late)
- `MainChartSurface` returns `null` until positive dimensions in Redux

---

## Fix history (passes 1–8)

| Pass | Commit | Approach | Browser result |
|------|--------|----------|----------------|
| 1 | `aa08df10` | Pixel props on charts | Blank |
| 2 | `86e1b6ed` | Bypass ResponsiveContainer | Blank |
| 3 | `49736cdf` | Absolute viewport CSS | Blank |
| 4 | `a31e2125` | ChartShell hardening | Blank |
| 5 | `76ff5d8b` | SizedChart + numeric ResponsiveContainer | Blank |
| 6 | `c9786fbc` | SizedChart cloneElement + rAF | Blank |
| 7 | `e1f9a75d` | Explicit width/height on charts, delete SizedChart | Blank + `-1` warning |
| 8 | `dfa378cb` | Live-ready gate, ChartFrame, Vite recharts alias | **Still blank + `-1` warning (user)** |

Detailed notes per pass: `PHASE3_UI_PROGRESS.md` § Chart Robustness Update.

---

## Diagnostic checklist (run in browser first)

Load Matrix with PDF, open DevTools on the **timeline** `.chart-shell`:

| Check | Command / element | Healthy | If broken → likely cause |
|-------|-------------------|---------|---------------------------|
| Shell ready | `data-chart-ready` | `"true"` | ChartShell never gates in — CSS/measure |
| Live ready | `data-chart-live-ready` | `"true"` | Viewport/shell rect 0 — layout |
| Dimensions | `data-chart-w`, `data-chart-h` | both > 100 | ChartFrame returns null |
| ResponsiveContainer | `document.querySelector('.recharts-responsive-container')` | **null** | Old code path or hidden wrapper — **matches `-1` warning** |
| Recharts wrapper | `.recharts-wrapper` | exists, size > 100 | Chart not mounting |
| SVG | `svg.recharts-surface` | exists, w/h > 100 | Redux bootstrap stuck |
| Grid/lines | `.recharts-cartesian-grid`, `.recharts-line` | present | Plot area zero / margins |
| React props | React DevTools → `LineChart` | numeric width/height, `responsive: false` | Props not reaching Recharts |
| Stale server | Port 3000 | Fresh process after pull | `Start-OmniSwim-Suite.bat` stale-PID flow |
| Hard refresh | Ctrl+Shift+R | Required after code changes | HMR serving old matrix chunk |

**Critical:** If `.recharts-responsive-container` exists while source has no `ResponsiveContainer`, suspect **stale bundle**, **duplicate recharts instance**, or **code path not matching repo** (verify `git log -1` and Network tab chunk hashes).

---

## Hypotheses not yet proven in browser

1. **Stale dev/HMR** — Matrix applet chunk (`applet-matrix-*.js`) or `vendor-charts-*.js` cached; user sees pre–seventh-pass ResponsiveContainer code despite `main` at `dfa378cb`.

2. **Duplicate Recharts/React** — Despite dedupe + alias, dev prebundle or manualChunks may still load two Recharts copies; context defaults `{ width: -1, height: -1 }` interact badly with props.

3. **ChartShell live-ready never true in real layout** — User sees border (CSS height on shell) but `data-chart-live-ready="false"` → charts never mount OR mount only after fallback path (should not happen in eighth pass).

4. **ChartShell live-ready true but props undefined** — Render prop receives dimensions but Recharts child does not (StrictMode remount race, memo on TeamCard).

5. **Absolute viewport + flex parent** — `.chart-shell__viewport` is `position: absolute; inset: 0` inside flex layouts (`TeamCard`, `OpsModule` motion wrappers); live measure may differ from happy-dom.

6. **Recharts 3.8.1 + React 19 + StrictMode** — `ReportChartSize` in `useEffect` + Strict double mount may leave Redux layout at 0 permanently if chart remounts before effect commits (see plan mermaid in `.cursor/plans/deep_dive_blank_charts_*.plan.md`).

7. **Wrong integration entirely** — May need to abandon Recharts for Matrix charts (visx, plain SVG, or Chart.js) if bootstrap cannot be stabilized.

---

## Test coverage (passes; may give false confidence)

| Script | What it checks |
|--------|----------------|
| `scripts/test_chart_data.mjs` | Scoring/timeline data shape |
| `scripts/test_chart_shell.mjs` | Readiness helpers, content-box math |
| `scripts/test_chart_render.mjs` | ChartShell → ChartFrame → LineChart; no `.recharts-responsive-container`; mocks `getBoundingClientRect` for happy-dom |
| `scripts/test_theme_css.mjs` | Production CSS includes `.chart-shell*`, `.chart-shell__chart` |
| `tests/e2e/matrix-chart.spec.ts` | Real Chromium via Playwright; asserts live-ready shell, SVG dimensions, no `-1` console warnings |
| `npm test` (CI) | Full suite on Ubuntu: Python `pdfplumber`, Playwright `--with-deps chromium`, then lint/test/build |

**Gap (closed 2026-06-29):** Playwright e2e is now in `npm test` and GitHub Actions CI.

---

## Files to read before changing anything

```
packages/ui/src/components/ChartShell.tsx
packages/ui/src/components/ChartFrame.tsx
packages/ui/src/index.css                    # .chart-shell* rules
packages/matrix/src/components/MeetOperationsView.tsx
packages/matrix/src/components/TeamCard.tsx
apps/shell/vite.config.ts
apps/shell/server.ts                         # Vite middleware
apps/shell/src/main.tsx                      # StrictMode
packages/core/src/lib/scoringEngine.ts       # timelineData
scripts/test_chart_render.mjs
PHASE3_UI_PROGRESS.md                        # pass history
Start-OmniSwim-Suite.bat                     # dev startup + port 3000
```

Recharts internals (for debugging):

```
node_modules/recharts/lib/component/ResponsiveContainer.js   # -1 warning source
node_modules/recharts/lib/chart/RechartsWrapper.js           # StaticDiv vs ResponsiveDiv
node_modules/recharts/lib/container/RootSurface.js           # SVG gate
node_modules/recharts/lib/context/chartLayoutContext.js      # ReportChartSize
```

---

## Recommended next steps (for implementer)

### Step 0 — Confirm runtime matches repo (30 min)

1. `git pull` → verify `HEAD` is `dfa378cb` or later.
2. Kill port 3000; run `Start-OmniSwim-Suite.bat`; Ctrl+Shift+R.
3. Run diagnostic checklist above; **record** `data-chart-*`, whether `.recharts-responsive-container` exists, React DevTools `LineChart` props.
4. In Network tab, confirm loaded `applet-matrix-*.js` / `vendor-charts-*.js` match fresh build (disable cache).

If `.recharts-responsive-container` exists → **stop** and find why ResponsiveContainer mounts (stale code or duplicate package).

### Step 1 — Real browser regression test ✅

Playwright test added and running in CI:

- `tests/e2e/matrix-chart.spec.ts` — fixture workspace via API, Matrix timeline chart assertions
- `playwright.config.ts` — starts `npm run dev` on CI; `npx playwright install --with-deps chromium` in `.github/workflows/ci.yml`
- Run locally: `npm run test:e2e` or full `npm test`

### Step 2 — If ResponsiveContainer still mounts despite source clean

- `npm ls recharts` — single version?
- Temporarily add `console.trace` in a Vite plugin or patch-package on ResponsiveContainer render to get stack trace in browser.
- Try removing `manualChunks` split for recharts (single bundle) to rule out duplicate instance.
- Try `ssr.noExternal: ['recharts']` if applicable.

### Step 3 — If ResponsiveContainer absent but SVG still blank

- Force Redux bootstrap: experiment with Recharts `compact` mode or dispatching size synchronously (may require fork/patch).
- Defer chart mount until **second** `requestAnimationFrame` after `data-chart-live-ready` (imperative gate in ChartShell callback ref).
- Remove React `StrictMode` in `apps/shell/src/main.tsx` temporarily to test double-mount theory.

### Step 4 — Nuclear options

- Replace Recharts on Matrix timeline with minimal SVG polylines (data already in `timelineData`).
- Pin Recharts 2.x (different sizing model) — high migration cost.
- Use `@visx/xychart` or similar with explicit dimensions.

---

## How to run / verify

```bat
Start-OmniSwim-Suite.bat
REM Kill stale port 3000 when prompted
REM Browser: http://localhost:3000/matrix
REM Ctrl+Shift+R after every pull
```

```bash
npm test          # 20 passed expected (+ 2 skipped optional fixtures)
npm run test:e2e  # Playwright only
npm run build     # production bundle
```

---

## Related plan files (reference only — do not edit)

- `.cursor/plans/deep_dive_blank_charts_7f92a4f4.plan.md` — layers 1–6 analysis
- `.cursor/plans/fix_blank_charts_v6_ae9f8549.plan.md` — seventh pass
- `.cursor/plans/fix_charts_post-reorg_dde9284d.plan.md` — seventh pass duplicate
- `.cursor/plans/fix_recharts_-1_warning_83757cb6.plan.md` — eighth pass

---

## Summary for next agent

**User-visible:** Matrix charts show border + legend but no SVG; console shows Recharts `width(-1) height(-1)` / `width(100%)` warning.

**Code state:** Eighth pass on `main` uses `ChartShell` → `ChartFrame` → explicit numeric Recharts props; no ResponsiveContainer in source; tests pass in happy-dom, Playwright E2E, and CI.

**Root cause (confirmed):** Stale dev server on port 3000 serving pre–eighth-pass JavaScript with ResponsiveContainer. Fresh restart + hard refresh fixes charts. `ChartStaleBundleGuard` surfaces this in the Matrix UI during dev.

**First action:** Kill stale port 3000, restart server (`npm run dev` clears Vite cache), hard refresh. Run `npm run test:e2e` or `node scripts/chart_browser_diagnostic.mjs` to verify.
