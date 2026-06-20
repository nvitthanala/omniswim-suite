# Omni Swim Suite

![Omni Swim Suite logo](omniswim-suite/public/OMNISWIMLOGO.png)

[![Node](https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
[![Express](https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white)](https://expressjs.com/)

Omni Swim Suite is a swim-meet operations workspace designed for roster planning, meet scoring, performance review, and reporting. The suite brings together three focused applets under one shell so coaches, meet managers, and analysts can move between planning and results without losing context.

## What the suite does

- **Manage entries and rosters** for athletes, relays, and scoring overrides.
- **Review meet results and scoring scenarios** with what-if analysis and batch optimization.
- **Import and export swim data** from SwimCloud paste, CSV, PDF, and HyTek-style formats.
- **Track local metrics sessions** for video and split-based analysis.
- **Persist workspaces** using JSON or SQLite-backed storage.

## Feature highlights

- **Manager** for roster configuration, athlete history imports, event planning, and exports.
- **Matrix** for meet scoring views, visual breakdowns, and projection tools.
- **Metrics** for local video/session analysis and reporting.
- **Snapshots** to save and restore workspace states.
- **Toast-based feedback** for import, export, and scoring actions.
- **Optional runtime toggles** for storage backend and AI-enabled paths.

## Tech stack

| Layer | Stack | Notes |
|---|---|---|
| Frontend | React 19, TypeScript, Vite | App shell and lazy-loaded applets |
| UI system | Tailwind CSS, custom design tokens, Lucide icons, motion | Shared styling and visual polish |
| Data fetching | TanStack React Query | Workspace state caching and mutation flow |
| Charts | Recharts | Scorecards and metrics charts |
| API/server | Express, dotenv, multer, UUID | File uploads, workspace endpoints, server-side routing |
| Validation | Zod | Request and data validation |
| Persistence | JSON files + SQLite (`node:sqlite`) | Configurable storage backend |
| Scripting | `tsx`, `esbuild`, Node scripts | Migrations, tests, and automation |
| Parsing | Python utilities | Meet PDF parsing pipeline for scoring workflows |

## Project layout

- `apps/shell` — main application shell, routing, Express server, and workspace UI.
- `packages/core` — shared types, scoring logic, workspace provider, API helpers, and data models.
- `packages/ui` — reusable UI primitives and shared styling.
- `packages/manager` — roster, imports, exports, and planning tools.
- `packages/matrix` — scoring and results-focused workflows.
- `packages/metrics` — local metrics and video/session review experience.
- `packages/db` — SQLite schema and workspace persistence service.
- `backend` — Python parsing utilities for meet documents.
- `scripts` — migration, verification, and utility scripts.
- `data` — workspace data and scoring configuration assets.

## Quick start

### Prerequisites

- Node.js 20 or newer
- npm (workspace-based install)
- Python 3 (recommended for PDF parsing workflows)

### Install and run

```bash
cd omniswim-suite
npm install
npm run dev
```

Then open http://localhost:3000

### One-click startup on Windows

Double-click either:

- `Start-OmniSwim-Suite.bat` in this folder, or
- `Start-OmniSwim-Suite.bat` in the parent project folder

The launcher checks for Node/Python, installs dependencies when needed, and opens the app in your browser.

## Common commands

```bash
# Start the dev server
npm run dev

# Build for production
npm run build

# Start the production server
npm run start

# Migrate JSON data to SQLite
npm run migrate:sqlite

# Run the SQLite round-trip verification script
npm run test:roundtrip
```

> Note: the default runtime storage is JSON unless `OMNI_DB=sqlite` is explicitly enabled.

## Runtime options

| Variable | Default | Purpose |
|---|---|---|
| `OMNI_DB` | `json` | Switches storage to SQLite after migration. |
| `OMNI_AI_ENABLED` | `false` | Keeps optional AI/OCR paths off unless intentionally enabled. |

## Functional notes by area

### Manager

- Import athlete history from pasted SwimCloud content or CSV files.
- Configure entries, event plans, and roster overrides.
- Export entries to CSV or HyTek-friendly formats.
- Run batch optimization for scoring scenarios.

### Matrix

- Upload meet PDFs and review scoring outputs.
- Inspect score breakdowns and meet summaries.
- Use what-if projections without permanently changing the workspace.
- Compare scenarios and visualize results.

### Metrics

- Work with local video/session analysis.
- Compare split times and workspace data.
- Export reports for review and sharing.

### Data and snapshots

- Save workspace snapshots for recovery and comparison.
- Keep JSON backups during data migrations.
- Use SQLite for smoother persistence when desired.

## Dependencies at a glance

### Runtime dependencies

- `@tanstack/react-query`
- `@vitejs/plugin-react`
- `dotenv`
- `express`
- `lucide-react`
- `motion`
- `multer`
- `react`
- `react-dom`
- `react-router-dom`
- `recharts`
- `uuid`
- `vite`
- `zod`

### Build / tooling dependencies

- `@types/express`
- `@types/multer`
- `@types/node`
- `@types/react`
- `@types/react-dom`
- `@types/uuid`
- `@tailwindcss/vite`
- `esbuild`
- `tailwindcss`
- `tsx`
- `typescript`

### Workspace packages

- `@omniswim/shell`
- `@omniswim/core`
- `@omniswim/ui`
- `@omniswim/manager`
- `@omniswim/matrix`
- `@omniswim/metrics`
- `@omniswim/db`

## Legacy and migration notes

The repository also contains legacy reference folders for prior swim tooling. These are retained for continuity and can be migrated into the main suite when needed.

## Troubleshooting

- If the app cannot start, confirm that Node.js 20+ is installed and that `npm install` completed successfully.
- If PDF parsing seems unavailable, install Python 3 and retry the relevant workflow.
- If you want to switch persistence modes, use the `OMNI_DB` runtime setting and run the migration script first.

## Repository status

This project is set up as a monorepo with shared packages and a unified shell experience. The build and runtime flow are intended to support both lightweight local use and more structured meet-management workflows.
