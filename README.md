# OMNI-SWIM · Suite

<p align="center">
  <img src="public/OMNISWIMLOGO.png" alt="Omni Swim Suite logo" width="180" />
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://expressjs.com/"><img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" alt="Express" /></a>
</p>

Omni Swim Suite is a workspace for swim-meet operations, combining roster planning, scoring workflows, and reporting in one place. It is organized as an npm-workspaces monorepo so the shell application, shared packages, and supporting utilities can evolve together. The repository root is the monorepo root.

## At a glance

| Applet | Purpose |
|---|---|
| Manager | Athlete history, roster planning, event setup, and exports |
| Matrix | Meet scoring, psych sheet import, prelims/psych O/U, momentum charts, projections, and scenario review |
| Metrics | Local video/session metrics analysis (no cloud keys) |

Workspaces persist locally (JSON by default, optional SQLite). Manager and Matrix share live workspace data, so roster edits update Matrix charts without a reload.

---

## Table of contents

1. [Tech stack](#tech-stack)
2. [Repository layout](#repository-layout)
3. [Getting started](#getting-started)
4. [Development](#development)
5. [Runtime configuration](#runtime-configuration)
6. [Documentation](#documentation)
7. [Troubleshooting](#troubleshooting)

---

## Tech stack

| Area | Stack |
|---|---|
| UI | React 19, TypeScript, Vite 6 |
| Styling | Tailwind CSS v4, custom design tokens, Lucide icons, motion |
| Charts | Recharts 3 |
| Data/state | TanStack Query, Web Worker scoring |
| Server | Express, dotenv, multer |
| Validation | Zod |
| Persistence | JSON files and SQLite (`node:sqlite`) |
| Parsing | Python utilities for meet PDF workflows |

## Repository layout

- [apps/shell](apps/shell) — SPA host, routing, providers, and the Express server
- [packages/core](packages/core) — shared types, scoring engine/worker, workspace store, API client
- [packages/ui](packages/ui) — design tokens, shared primitives (Tailwind entry CSS lives here)
- [packages/manager](packages/manager) — roster and planning workflows
- [packages/matrix](packages/matrix) — scoring, charts, and results views
- [packages/metrics](packages/metrics) — local metrics workflows
- [packages/db](packages/db) — SQLite persistence layer
- [backend](backend) — Python PDF parsing/scoring utilities
- [scripts](scripts) — migration, test runner, and verification scripts
- [data](data) — workspace data (`meets.json`), scoring presets, cutlines
- [public](public) — static assets

## Getting started

### Prerequisites

- Node.js 20+
- npm
- Python 3 (recommended for PDF parsing workflows)

### Quick start

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

### One-click startup on Windows

Double-click [Start-OmniSwim-Suite.bat](Start-OmniSwim-Suite.bat) (dev) or [Start-OmniSwim-Suite-Prod.bat](Start-OmniSwim-Suite-Prod.bat) (production build). The launcher checks for Node/Python, installs dependencies on first run, and opens the app in your browser.

## Development

```bash
# Start the development server
npm run dev

# Build the production client + server bundle
npm run build

# Run the production server (after build)
npm run start

# Run the test suite (scoring, persistence, chart-data, psych, Playwright e2e)
npm test

# Run Playwright chart e2e only (starts dev server automatically)
npm run test:e2e

# Type-check all workspaces
npm run lint

# Migrate JSON data to SQLite
npm run migrate:sqlite

# Verify SQLite round-trip behavior
npm run test:roundtrip
```

`npm test` runs the self-contained checks in [scripts](scripts) via the runner [scripts/run-tests.mjs](scripts/run-tests.mjs). Tests that depend on local-only fixtures are skipped automatically on a clean checkout.

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `OMNI_DB` | `json` | Switches persistence to SQLite (run `npm run migrate:sqlite` first) |
| `OMNI_AI_ENABLED` | `false` | Keeps optional AI/OCR paths disabled unless explicitly enabled |
| `OMNI_PORT` / `PORT` | `3000` | HTTP port for `npm run dev` and `npm start` |

`npm test` runs the self-contained checks in [scripts](scripts) via the runner [scripts/run-tests.mjs](scripts/run-tests.mjs). Tests that depend on local-only fixtures are skipped automatically on a clean checkout. CI (GitHub Actions) installs Python `pdfplumber` and Playwright Chromium before running the same suite.

## Documentation

- [PHASE2_PROGRESS.md](PHASE2_PROGRESS.md) — Phase 2 handoff, prelims O/U, psych pipeline notes
- [PHASE3_UI_PROGRESS.md](PHASE3_UI_PROGRESS.md) — chart architecture, UI foundation, momentum/psych UI
- [CHART_BLANK_HANDOFF.md](CHART_BLANK_HANDOFF.md) — blank-chart diagnostics and stale-bundle recovery
- [backend](backend) — Python PDF parsing (`pdf_parser.py`, `psych_parser.py`)
- [scripts](scripts) — automation and validation scripts

### Prelims projection (Matrix)

When a loaded meet includes prelims times, Matrix computes a **prelims projected score** per swimmer from their **prelims placement** (scored as if that seed were their finals result). HyTek prelims rank is used when present; otherwise the field is ordered by prelims time. **Over/underperformance** is the difference between actual finals points and that prelims expectation:

- **Baseline vs prelims** — loaded meet score minus sum of prelims-placement expected points
- **Projected vs prelims** — what-if score minus the same prelims anchor

Example: 4th in prelims (15 pts expected) and 1st in finals (20 pts actual) → **+5 O/U**, even if the finals time was slower. Timed-finals distance events and time trials are excluded.

Use the **Prelims** view in the Performance Matrix for a team diff table; team cards and the timeline tooltip show meet-total and per-event cumulative deltas when prelims data is present.

### Psych sheet pipeline (Matrix)

Upload a HyTek psych PDF from Matrix **Operations** (same format selector as meet PDFs: auto / regular / divided). The server parses individual entries via TypeScript quality scoring with a Python fallback (`backend/psych_parser.py`).

- **Layout auto-detect** — tries `divided` (two-column) and `regular` (one-column) parses, scores row quality, and picks the best candidate. NSISC psych sheets are two-column; one-column meets prefer `regular` when divided rows are corrupt.
- **Psych projected score** — each psych entry is scored as if its psych placement were the finals result (`packages/core/src/lib/psychProjection.ts`).
- **Psych O/U** — difference between actual baseline finals points and psych-placement expected points (same placement logic as prelims).
- **Team alignment** — psych PDF team abbreviations (e.g. `HSU`) are resolved to meet team names (e.g. Henderson State University) via `packages/core/src/data/teamAliases.ts` on upload and during scoring.
- **Persistence** — workspaces store `psychMenResults`, `psychWomenResults`, and `loadedPsych` metadata (SQLite schema v3).

Use **vs Psych** on team cards and the meet momentum section when a psych sheet is linked to the loaded meet.

### Momentum charts (Matrix)

Cumulative over/under by event for meet-wide and per-team views (`MomentumChartCard`, `packages/core/src/lib/prelimsProjection.ts`):

- **vs Prelims** — event-aligned cumulative O/U from prelims placement expectations
- **vs Psych** — same timeline using psych placement expectations (requires aligned team names)

Timelines align to meet event order; empty psych momentum shows a guided message when team names on the psych sheet do not match meet results.

### Team aliases (NSISC and GLVC)

Conference abbreviations on psych sheets and HyTek PDFs map to canonical school names in `packages/core/src/data/teamAbbreviations.json` and `packages/core/src/data/teamAliases.ts`. Matching uses exact abbreviation lookup, acronym expansion, and fuzzy normalization. Extend the JSON map when onboarding a new conference.

### Charts (Matrix / Analytics / Metrics)

Charts use `ChartShell` → `ChartFrame` → Recharts with explicit pixel `width`/`height` and `responsive={false}` — never `ResponsiveContainer` at `%` sizing. If charts show a border and legend but no SVG after pulling changes, restart the dev server and hard-refresh; see [CHART_BLANK_HANDOFF.md](CHART_BLANK_HANDOFF.md). Matrix shows a stale-bundle banner when old cached JavaScript is detected (`ChartStaleBundleGuard`).

## Troubleshooting

- If the app does not start, confirm Node.js 20+ is installed and `npm install` completed successfully.
- **`EADDRINUSE` on port 3000** — another server is still running. Close the previous Omni Swim Suite terminal window, or run `netstat -ano | findstr :3000` to find the PID and stop it. Alternatively: `set OMNI_PORT=3001` then `npm run dev`.
- **WebSocket / port 24678 errors** — should not occur after the shared HTTP server fix; if you see them on an old checkout, pull latest and restart. Only one dev instance should run at a time.
- If PDF parsing fails, install Python 3 and retry. On first server start, `pdfplumber` is auto-installed into `venv/`. CI installs it globally via `pip install pdfplumber`.
- **Psych PDF parse errors** — restart the dev server after pulling API changes (`npm run dev`). An empty or 404 response usually means a stale server process.
- **Psych teams missing from momentum** — re-upload the psych PDF after team-alias updates, or confirm meet team names match conference abbreviations (see Team aliases above).
- **Charts blank after git pull** — kill port 3000, run `npm run dev` (clears Vite cache via `predev`), hard-refresh (Ctrl+Shift+R). Run `npm run test:e2e` to verify. See [CHART_BLANK_HANDOFF.md](CHART_BLANK_HANDOFF.md).
- To switch storage modes, set `OMNI_DB=sqlite` and run `npm run migrate:sqlite` first.
- If charts appear blank after adding UI in a workspace package, ensure that package's `src` is registered as a Tailwind `@source` in [packages/ui/src/index.css](packages/ui/src/index.css); Tailwind v4 only auto-scans the Vite root.

## License

This project uses the same open-source approach as the surrounding swim tooling in this workspace. Please review repository-specific licensing details before redistribution or commercial use.
