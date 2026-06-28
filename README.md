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
| Matrix | Meet scoring views, projections, prelims over/under, charts, and scenario review |
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

# Run the test suite (scoring, persistence, chart-data checks)
npm test

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

## Documentation

- [PHASE2_PROGRESS.md](PHASE2_PROGRESS.md) — implementation notes, status, and verification history
- [backend](backend) — parsing and scoring utilities
- [scripts](scripts) — automation and validation scripts

### Prelims projection (Matrix)

When a loaded meet includes prelims times, Matrix computes a **prelims projected score** by re-ranking each event on prelims clocks and assigning expected A/B final placements (distance and diving stay on prelim scoring rules). **Over/underperformance** is shown as:

- **Baseline vs prelims** — loaded meet score minus prelims projection (actual meet performance)
- **Projected vs prelims** — what-if score minus prelims projection (scenario vs prelims expectation)

Use the **Prelims** view in the Performance Matrix for a team diff table; team cards and the timeline tooltip show meet-total and per-event cumulative deltas when prelims data is present.

## Troubleshooting

- If the app does not start, confirm Node.js 20+ is installed and `npm install` completed successfully.
- If PDF parsing fails, install Python 3 and retry.
- To switch storage modes, set `OMNI_DB=sqlite` and run `npm run migrate:sqlite` first.
- If charts appear blank after adding UI in a workspace package, ensure that package's `src` is registered as a Tailwind `@source` in [packages/ui/src/index.css](packages/ui/src/index.css); Tailwind v4 only auto-scans the Vite root.

## License

This project uses the same open-source approach as the surrounding swim tooling in this workspace. Please review repository-specific licensing details before redistribution or commercial use.
