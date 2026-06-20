# OMNI-SWIM · Suite

<p align="center">
  <img src="omniswim-suite/public/OMNISWIMLOGO.png" alt="Omni Swim Suite logo" width="180" />
</p>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white" alt="React" /></a>
  <a href="https://vite.dev/"><img src="https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://expressjs.com/"><img src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white" alt="Express" /></a>
</p>

Omni Swim Suite is a workspace for swim-meet operations, combining roster planning, scoring workflows, and reporting in one place. The repository is organized as a monorepo so the shell application, shared packages, and supporting utilities can evolve together.

## At a glance

| Area | Purpose |
|---|---|
| Manager | Athlete history, roster planning, event setup, and exports |
| Matrix | Meet scoring views, projections, and scenario review |
| Metrics | Local metrics and video/session analysis |
| Storage | JSON-first persistence with optional SQLite support |

---

## Table of contents

1. [Tech stack](#tech-stack)
2. [Repository layout](#repository-layout)
3. [Getting started](#getting-started)
4. [Development](#development)
5. [Documentation](#documentation)
6. [Troubleshooting](#troubleshooting)

---

## Tech stack

### Application

| Area | Stack |
|---|---|
| UI | React 19, TypeScript, Vite 6 |
| Styling | Tailwind CSS, custom design tokens, Lucide icons, motion |
| Charts | Recharts |
| Server | Express, dotenv, multer |
| Validation | Zod |
| Persistence | JSON files and SQLite (`node:sqlite`) |
| Parsing | Python utilities for meet PDF workflows |

### Supporting libraries

- `@tanstack/react-query` for workspace state and cache updates
- `uuid` for generated workspace identifiers
- `recharts` for charts and visual summaries
- `lucide-react` and `motion` for UI polish

## Repository layout

- [omniswim-suite](omniswim-suite) — main application and monorepo root for the suite
- [omniswim-suite/apps/shell](omniswim-suite/apps/shell) — shell app, routing, and Express server
- [omniswim-suite/packages/core](omniswim-suite/packages/core) — shared types, scoring logic, and workspace helpers
- [omniswim-suite/packages/ui](omniswim-suite/packages/ui) — shared UI primitives and styling
- [omniswim-suite/packages/manager](omniswim-suite/packages/manager) — roster and planning workflows
- [omniswim-suite/packages/matrix](omniswim-suite/packages/matrix) — scoring and results views
- [omniswim-suite/packages/metrics](omniswim-suite/packages/metrics) — local metrics workflows
- [omniswim-suite/packages/db](omniswim-suite/packages/db) — SQLite persistence layer
- [omniswim-suite/backend](omniswim-suite/backend) — Python parsing utilities
- [omniswim-suite/scripts](omniswim-suite/scripts) — migration and verification scripts
- [omniswim-suite/data](omniswim-suite/data) — sample data and configuration assets

## Getting started

### Prerequisites

- Node.js 20+
- npm
- Python 3 (recommended for PDF parsing workflows)

---

### Quick start

```bash
cd omniswim-suite
npm install
npm run dev
```

Then open http://localhost:3000.

### One-click startup on Windows

Double-click either:

- [omniswim-suite/Start-OmniSwim-Suite.bat](omniswim-suite/Start-OmniSwim-Suite.bat), or
- [Start-OmniSwim-Suite.bat](Start-OmniSwim-Suite.bat) from the repository root

The launcher checks for Node/Python, installs dependencies on first run, and opens the app in your browser.

## Development

### Common commands

```bash
# Start the development server
npm run dev

# Build the production bundle
npm run build

# Run the production server
npm run start

# Migrate JSON data to SQLite
npm run migrate:sqlite

# Verify SQLite round-trip behavior
npm run test:roundtrip
```

### Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `OMNI_DB` | `json` | Switches persistence to SQLite after migration |
| `OMNI_AI_ENABLED` | `false` | Keeps optional AI/OCR paths disabled unless explicitly enabled |

## Documentation

The repo includes a few practical references for day-to-day work:

- [omniswim-suite/README.md](omniswim-suite/README.md) — project-specific setup guidance for the main suite
- [omniswim-suite/PHASE2_PROGRESS.md](omniswim-suite/PHASE2_PROGRESS.md) — implementation notes and verification status
- [omniswim-suite/backend](omniswim-suite/backend) — parsing and scoring utilities
- [omniswim-suite/scripts](omniswim-suite/scripts) — automation and validation scripts

---

## Troubleshooting

- If the app does not start, confirm that Node.js 20+ is installed and that `npm install` completed successfully.
- If PDF parsing workflows fail, install Python 3 and retry the relevant steps.
- If you want to switch storage modes, set `OMNI_DB` appropriately and run the migration script first.

## License

This project uses the same open-source approach as the surrounding swim tooling in this workspace. Please review repository-specific licensing details before redistribution or commercial use.

