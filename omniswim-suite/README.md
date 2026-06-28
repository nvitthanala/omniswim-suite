# Omni Swim Suite

Meet operations, roster management, and local video metrics — unified in one coach-friendly suite.

## Quick start

```powershell
cd omniswim-suite
npm install
npm run dev
# open http://localhost:3000
```

Or double-click `Start-OmniSwim-Suite.bat` (dev) / `Start-OmniSwim-Suite-Prod.bat` (production build).

## Persistence

| `OMNI_DB` | Backend | Use case |
|-----------|---------|----------|
| `sqlite` (default) | `data/omniswim.db` | Local single-user |
| `json` | `data/meets.json` | Legacy / portable backup |
| `postgres` | `DATABASE_URL` | Shared multi-user hosting |

On first SQLite boot, existing `data/meets.json` is auto-imported if the DB is empty.

```powershell
npm run migrate:sqlite      # JSON → SQLite (manual)
npm run migrate:postgres    # JSON → PostgreSQL (requires DATABASE_URL)
```

## Shared hosting (PostgreSQL + auth)

```powershell
$env:DATABASE_URL='postgres://user:pass@localhost:5432/omniswim'
$env:OMNI_DB='postgres'
npm run migrate:postgres
npm run dev
```

Register at `/login`. Workspaces are scoped to your team. Share read-only links via `POST /api/workspaces/:id/share`.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OMNI_DB` | `sqlite` | `sqlite`, `json`, or `postgres` |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `OMNI_AUTH_REQUIRED` | `true` when postgres | Require login for workspace API |
| `OMNI_AI_ENABLED` | `false` | Enable Gemini image parsing |
| `GEMINI_API_KEY` | — | Required only if AI enabled |
| `NODE_ENV` | — | `production` for static SPA serving |

## Testing & CI

```powershell
npm test                    # Vitest unit tests
npm run test:roundtrip      # SQLite integrity test
scripts\run-smoke-tests.bat # Full smoke suite (Windows)
```

GitHub Actions CI runs lint, test, and build on push/PR.

## Tauri desktop (optional)

Requires [Rust](https://rustup.rs/) and the Tauri CLI (installed via `npm install`).

```powershell
npm run tauri:dev
npm run tauri:build   # produces Windows .exe in src-tauri/target/release/
```

PDF parsing still requires Python + `pdfplumber` (auto-installed into `venv/` on first server start).

## Applets

- **Matrix** — HyTek PDF upload, scoring, standings, what-if
- **Manager** — Roster, entries, SwimCloud import, batch optimizer
- **Metrics** — Local video tagging, splits, session compare
- **Analytics** (`/analytics`) — Season trends across workspaces

## Monorepo layout

- `apps/shell` — SPA host + Express API
- `packages/{core,ui,db,manager,matrix,metrics}` — shared libraries + applets
- `backend/` — Python PDF pipeline
- `scripts/` — migrations and smoke tests
- `src-tauri/` — optional desktop shell

See `PHASE3_PROGRESS.md` for implementation handoff details.
