# Omni Swim Suite

Unified monorepo hosting **Manager**, **Matrix**, and **Metrics** under one shell with shared workspace data.

## Quick start

```bash
cd omniswim-suite
npm install
npm run dev
```

Open http://localhost:3000

### One-click startup (Windows)

Double-click either:

- `Start-OmniSwim-Suite.bat` in this folder, or
- `Start-OmniSwim-Suite.bat` in the parent `omniswim suite` folder

The script checks Node, installs dependencies on first run, opens your browser, and starts the dev server.

## Applets

| Applet | Route | Purpose |
|--------|-------|---------|
| **Manager** | `/manager` | Roster, scorers, entry plans, SwimCloud paste import |
| **Matrix** | `/matrix` | Meet PDF upload, scoring charts, what-if simulation |
| **Metrics** | `/metrics` | Video swim analysis (local metrics engine) |

Workspace sidebar appears on Manager and Matrix. Data persists to `data/meets.json`.

## Runtime options

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNI_DB` | `json` | Set to `sqlite` to use `data/omniswim.db` after running `npm run migrate:sqlite`. |
| `OMNI_AI_ENABLED` | `false` | Keeps cloud AI/OCR paths disabled by default. Set to `true` with `GEMINI_API_KEY` only if you intentionally install/enable the optional provider. |

## Migrate from legacy apps

```bash
npm run migrate:legacy
```

Copies data from `../omniswim_-matrix` without modifying legacy folders.

## Tests

```bash
npx tsx scripts/test_athlete_history.mjs
npx tsx scripts/test_roster_optimizer.mjs
npx tsx scripts/test_entry_limits.mjs
```

## Structure

- `apps/shell` — SPA host, Express server, routing
- `packages/core` — types, scoring libs, workspace store
- `packages/ui` — Matrix design tokens
- `packages/{manager,matrix,metrics}` — lazy-loaded applets

Legacy folders `omniswim_-matrix` and `omniswim_-biomechanics` remain as reference until you confirm cutover.
