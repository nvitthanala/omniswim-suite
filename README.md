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
| Manager | Athlete history, roster planning (Athletes → Lineup → Relays → Optimize), compliance checklist, and exports |
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
6. [Back up and restore](#back-up-and-restore)
7. [Documentation](#documentation)
8. [Troubleshooting](#troubleshooting)

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

For a full first-day setup (Python environment, Playwright browsers, `pdftotext`, what the test gates expect), read [docs/ONBOARDING.md](docs/ONBOARDING.md).

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

# Run the script suite plus the Playwright e2e specs (scoring, persistence, chart-data, psych)
npm test

# Run the vitest unit suite (tests/**)
npm run test:unit

# Same suite with coverage
npm run test:coverage

# Run vitest, then fail if more tests skipped than tests/skip-budget.json allows
node scripts/check_skip_budget.mjs

# Run Playwright chart e2e only (starts dev server automatically)
npm run test:e2e

# Run the SwimCloud extension harness (real Chromium, fixture pages; a few minutes)
npm run test:harness

# Type-check all workspaces and the extension, then run ESLint
npm run lint

# Rebuild the SwimCloud companion extension bundles (crawler.js, background.js)
npm run build:extension

# Migrate JSON data to SQLite
npm run migrate:sqlite

# Verify SQLite round-trip behavior
npm run test:roundtrip

# Check that the SQLite and PostgreSQL services cover the same tables and columns (no database needed)
npm run test:parity

# Check that workspace routes refuse another tenant's ids (no database needed)
npm run test:scope

# Migrate JSON data to PostgreSQL (needs DATABASE_URL; --force replaces existing rows)
npm run migrate:postgres

# Verify the PostgreSQL round trip (needs PG_TEST_URL or DATABASE_URL; skips without one)
npm run test:roundtrip:pg
```

### Tests

- `npm test` runs the self-contained checks in [scripts](scripts) through the runner [scripts/run-tests.mjs](scripts/run-tests.mjs), then the Playwright e2e specs. Tests that depend on local-only fixtures are skipped automatically on a clean checkout, and the runner prints each skip beside the PASS.
- `npm run test:unit` runs the vitest suite in [tests](tests). It is the larger of the two suites.
- A skipped test is not a failure, so a suite can lose coverage and stay green. [scripts/check_skip_budget.mjs](scripts/check_skip_budget.mjs) runs vitest and fails when a file skips more tests than [tests/skip-budget.json](tests/skip-budget.json) allows. CI runs it. Lower a number when you fix a skip. Raise one only with a written reason.
- `scripts/probes/` holds manual probes. They are not part of any suite. Each file's first line says what it needs (a PDF and a running server, for example).
- CI (GitHub Actions) installs Python `pdfplumber` and Playwright Chromium, then runs the same suites.
- `OMNI_TEST_JOBS` sets how many scripts the runner starts at once. See the table below.



## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `OMNI_DB` | `sqlite` | Persistence backend: `sqlite` (default), `postgres`, or `json`. A fresh checkout with no `data/omniswim.db` seeds itself from the committed sample file `data/demo-seed.json`. `data/meets.json` is this machine's own untracked store; when it exists, SQLite migrates from it |
| `OMNI_HOST` | `127.0.0.1` | Bind address. Loopback by default — the suite ships with authentication off, so exposing it to the network is opt-in. Set `0.0.0.0` to serve other devices; startup then prints a warning |
| `OMNI_AI_ENABLED` | `false` | Keeps optional AI/OCR paths disabled unless explicitly enabled |
| `OMNI_PORT` / `PORT` | `3000` | HTTP port for `npm run dev` and `npm start` |
| `OMNI_DATA_DIR` | `<repo>/data` | Where workspaces, backups and presets live. The seed, migrate and re-extract scripts honour it, print the path before writing, and refuse to write while a server answers on the port (`--force` overrides). Point it at a copy when testing those scripts |

### Environment variables

These variables are read at server start (or, for `OMNI_TEST_JOBS`, by the test runner). An invalid value stops startup with a message instead of falling back silently.

| Variable | Default | Purpose |
|---|---|---|
| `OMNI_ALLOWED_HOSTS` | empty | Extra `Host` names the server accepts, separated by commas or spaces, each `name` or `name:port`. A bare name matches any port. `localhost`, `127.0.0.1` and `[::1]` are always allowed, and so is a specific non-loopback `OMNI_HOST`. Any other `Host` gets 421. Set it when `OMNI_HOST=0.0.0.0` and other machines connect. A malformed entry stops startup |
| `OMNI_INVITE_CODES` | empty | With authentication required (`OMNI_DB=postgres` or `OMNI_AUTH_REQUIRED=true`): comma-separated invite secrets, each at least 12 characters. A caller registers by sending one as `inviteCode`. A shorter code stops startup |
| `OMNI_ADMIN_EMAILS` | empty | With authentication required: comma-separated emails. A signed-in user on the list can register another account without a code. With this and `OMNI_INVITE_CODES` both empty, registration is closed |
| `OMNI_NO_AUTO_INSTALL` | unset | Set to `1` to forbid runtime installs. By default the server creates `venv/` and installs the `pdfplumber` version pinned in `backend/requirements.txt` on first start. With `1` it exits with a message instead when the environment is not as pinned |
| `OMNI_PARSE_PDF_MAX_MB` | `25` | Largest decoded PDF the parse endpoints accept, in megabytes. A larger file gets 413. A value that is not a positive number stops startup |
| `OMNI_BACKUP_KEEP` | `20` | How many backups of the "other" pool (`pre-delete`, `pre-shrink`, `startup`) to keep |
| `OMNI_BACKUP_KEEP_MANUAL` | `20` | How many `manual` backups ("Back up now") to keep. Each pool is trimmed on its own |
| `OMNI_BACKUP_KEEP_PRE_RESTORE` | `10` | How many `pre-restore` backups to keep |
| `OMNI_BACKUP_DIR` | unset | A folder that receives a copy of every backup, and on SQLite a `.db` copy of the live database. Use a folder a sync client watches. A failed copy is logged and never fails the save |
| `OMNI_TEST_JOBS` | `4` | How many scripts `npm test` runs at once. `1` restores the old one-at-a-time run |

A keep value below 1, or one that is not a whole number, is ignored and the default applies.

## Back up and restore

Every backup is a full export of the workspaces as one JSON array, `data/backups/meets-<label>-<UTC stamp>.json`. The app writes these labels:

| Label | Written |
|---|---|
| `manual` | When you press "Back up now" (`POST /api/workspaces/backup`) |
| `pre-restore` | Automatically, just before a restore replaces everything |
| `pre-delete` | Before every workspace delete |
| `pre-shrink` | Before a save that would remove most of a collection |
| `startup` | Once per server start |

**Retention.** Three pools, each trimmed to its newest N on its own: `manual` (`OMNI_BACKUP_KEEP_MANUAL`, default 20), `pre-restore` (`OMNI_BACKUP_KEEP_PRE_RESTORE`, default 10) and everything else (`OMNI_BACKUP_KEEP`, default 20). No number of automatic backups can evict a manual or pre-restore one. Retention only removes files this app wrote, so hand-made copies in `data/backups/` stay.

**Off-machine copy.** When `OMNI_BACKUP_DIR` names a folder, each backup is also copied there. On SQLite the folder also gets a standalone copy of the live database, `omniswim-<label>-<stamp>.db`, made with `VACUUM INTO`. The folder is pruned with the same pools. A failed copy is logged and never fails the backup or the save.

**Restore from the app's own folder.** Call `POST /api/workspaces/restore` with `{ "file": "<bare name>" }`. `GET /api/workspaces/backups` lists the names. The server writes a `pre-restore` backup first, then replaces every workspace of every user with the file's contents. It bumps each workspace's version, so a tab that still holds the old one gets a conflict, not an overwrite.

**Restore from `OMNI_BACKUP_DIR`.** Copy the `meets-*.json` file into `data/backups/`, then restore it by name as above. To go back to a whole database copy instead, stop the server, delete `data/omniswim.db`, `data/omniswim.db-wal` and `data/omniswim.db-shm`, copy the chosen `omniswim-*.db` file to `data/omniswim.db`, and start the server. Prefer the JSON restore: it keeps a `pre-restore` safety copy and works while the server runs.

Source of this section: the doc comment above `DEFAULT_BACKUP_KEEP` in [apps/shell/lib/workspaceRepo.ts](apps/shell/lib/workspaceRepo.ts).

## Documentation

- [docs/ONBOARDING.md](docs/ONBOARDING.md) — first-day setup: tools, environment, gates, baseline numbers
- [docs/README.md](docs/README.md) — full documentation index (reference, video, and historical archive)
- [docs/INVARIANTS.md](docs/INVARIANTS.md) — undocumented-but-true facts about this codebase
- [CHANGELOG.md](CHANGELOG.md) — user-visible behaviour changes, newest first
- [docs/archive/2026-06/PHASE2_PROGRESS.md](docs/archive/2026-06/PHASE2_PROGRESS.md) — Phase 2 handoff, prelims O/U, psych pipeline notes (historical)
- [docs/archive/2026-08/PHASE3_UI_PROGRESS.md](docs/archive/2026-08/PHASE3_UI_PROGRESS.md) — chart architecture, UI foundation, momentum/psych UI (historical)
- [docs/archive/2026-08/ROSTER_LINEUP_PROGRESS.md](docs/archive/2026-08/ROSTER_LINEUP_PROGRESS.md) — Manager Lineup/Relays workflow, compliance checklist, non-scorer relay vacate (historical)
- [docs/archive/2026-08/ROSTER_DATA_OVERHAUL_HANDOFF.md](docs/archive/2026-08/ROSTER_DATA_OVERHAUL_HANDOFF.md) — multi-athlete SwimCloud import, SCM/LCM→SCY conversion + distance remap, scoring-theory import, HSU 26-27 seed, UI token modernization (historical)
- [docs/archive/2026-06/CHART_BLANK_HANDOFF.md](docs/archive/2026-06/CHART_BLANK_HANDOFF.md) — blank-chart diagnostics and stale-bundle recovery (historical, resolved)
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

Charts use `ChartShell` → `ChartFrame` → Recharts with explicit pixel `width`/`height` and `responsive={false}` — never `ResponsiveContainer` at `%` sizing. If charts show a border and legend but no SVG after pulling changes, restart the dev server and hard-refresh; see [docs/archive/2026-06/CHART_BLANK_HANDOFF.md](docs/archive/2026-06/CHART_BLANK_HANDOFF.md). Matrix shows a stale-bundle banner when old cached JavaScript is detected (`ChartStaleBundleGuard`).

## Troubleshooting

- If the app does not start, confirm Node.js 20+ is installed and `npm install` completed successfully.
- **`EADDRINUSE` on port 3000** — another server is still running. Close the previous Omni Swim Suite terminal window, or run `netstat -ano | findstr :3000` to find the PID and stop it. Alternatively: `set OMNI_PORT=3001` then `npm run dev`.
- **WebSocket / port 24678 errors** — should not occur after the shared HTTP server fix; if you see them on an old checkout, pull latest and restart. Only one dev instance should run at a time.
- If PDF parsing fails, install Python 3 and retry. On first server start, `pdfplumber` is auto-installed into `venv/`. CI installs it globally via `pip install pdfplumber`.
- **Psych PDF parse errors** — restart the dev server after pulling API changes (`npm run dev`). An empty or 404 response usually means a stale server process.
- **Psych teams missing from momentum** — re-upload the psych PDF after team-alias updates, or confirm meet team names match conference abbreviations (see Team aliases above).
- **Charts blank after git pull** — kill port 3000, run `npm run dev` (clears Vite cache via `predev`), hard-refresh (Ctrl+Shift+R). Run `npm run test:e2e` to verify. See [docs/archive/2026-06/CHART_BLANK_HANDOFF.md](docs/archive/2026-06/CHART_BLANK_HANDOFF.md).
- **Login does not stick over plain HTTP.** With authentication on, the session cookie is `Secure` whenever the request is not loopback. A browser drops a `Secure` cookie over plain HTTP, so a login from another machine fails silently. Serve a non-loopback deployment over HTTPS.
- SQLite is the default backend. To use the JSON store instead, set `OMNI_DB=json`; for the shared multi-user backend, `OMNI_DB=postgres` with `DATABASE_URL` (this one requires authentication).
- **The server is only reachable from this machine by default.** If a phone or a second laptop cannot connect, that is `OMNI_HOST=127.0.0.1` doing its job — start with `OMNI_HOST=0.0.0.0` to serve the network, and read the warning it prints first.
- If charts appear blank after adding UI in a workspace package, ensure that package's `src` is registered as a Tailwind `@source` in [packages/ui/src/index.css](packages/ui/src/index.css); Tailwind v4 only auto-scans the Vite root.

## License

This project uses the same open-source approach as the surrounding swim tooling in this workspace. Please review repository-specific licensing details before redistribution or commercial use.
