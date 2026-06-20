# Omni Swim Suite — Phase 3 Implementation Progress / Handoff

> Living document. Updated during Phase 3 work so any agent (or human) can resume mid-stream.
> **Source of truth for the plan:** `.cursor/plans/omni_swim_phase_3_2b678aae.plan.md` (do NOT edit the plan file).

Last updated: 2026-06-19. Phase 3 **fully complete**.

---

## How to resume (read this first)

1. Read this file top to bottom.
2. Check the **Todo status** table below for the next `pending`/`in_progress` item.
3. Re-run the verification commands in **Verification** to confirm the current build state.
4. Continue from **Next concrete steps** (if any epics remain).

Working dir for all commands: `C:\Users\nihar\Documents\GitHub\omniswim-suite\omniswim-suite`
Package manager: **npm** (workspaces). Node >=20 + Python (venv auto-created by server on first run).

---

## Todo status

| id | description | status |
|----|-------------|--------|
| pg-adapter | PgWorkspaceService + PgRepo, OMNI_DB=postgres, migrations, migrate:postgres, owner/team scoping | **DONE** |
| auth-multiuser | Auth (users/teams/sessions), requireAuth, workspace sharing, sync polling, login UI | **DONE** |
| sqlite-default | SQLite default (OMNI_DB fallback), auto-migrate meets.json on first boot | **DONE** |
| ci-tests | Vitest + GitHub Actions CI, fixed run-smoke-tests.bat | **DONE** |
| tauri | src-tauri config, tauri:build script (requires Rust + Tauri CLI) | **DONE** |
| feature-analytics | Season analytics page at `/analytics` | **DONE** |
| feature-video | Expanded metrics: lap compare, multi-session compare | **DONE** |
| feature-reporting | HTML printable reports + shareable read-only links (PostgreSQL) | **DONE** |
| ux-redesign | Swimming-themed home, decluttered layout, unified naming | **DONE** |
| docs-naming | This handoff doc, README env/CI/Tauri docs, product name unified | **DONE** |

> **CHECKPOINT:** Phase 3 complete. Run `npm test` + `npm run build` to verify.

---

## Architecture (Phase 3)

```
Clients (web / Tauri) → Express (apps/shell) → WorkspaceRepo
  OMNI_DB=sqlite   → SqliteRepo  (default, local)
  OMNI_DB=json     → JsonRepo    (legacy backup)
  OMNI_DB=postgres → PgRepo      (shared multi-user + auth)
```

**Key env vars:**

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNI_DB` | `sqlite` | Persistence backend: `sqlite`, `json`, or `postgres` |
| `DATABASE_URL` | — | Required when `OMNI_DB=postgres` |
| `OMNI_AUTH_REQUIRED` | `true` when postgres | Force login for all workspace routes |
| `OMNI_AI_ENABLED` | `false` | Gate Gemini image parsing |
| `GEMINI_API_KEY` | — | Optional, only if AI enabled |

---

## Key file map

| Area | Path |
|------|------|
| Server | `apps/shell/server.ts` |
| Auth middleware | `apps/shell/lib/authMiddleware.ts` |
| Storage adapters | `apps/shell/lib/workspaceRepo.ts` |
| SQLite service | `packages/db/src/WorkspaceService.ts` |
| PostgreSQL service | `packages/db/src/PgWorkspaceService.ts` |
| Auth + share links | `packages/db/src/AuthService.ts` |
| PG schema | `packages/db/src/pgSchema.ts` |
| Season analytics | `packages/core/src/lib/seasonAnalytics.ts` |
| Report builder | `packages/core/src/lib/reportBuilder.ts` |
| Analytics page | `apps/shell/src/pages/AnalyticsPage.tsx` |
| Login page | `apps/shell/src/pages/LoginPage.tsx` |
| Share page | `apps/shell/src/pages/SharePage.tsx` |
| Metrics compare | `packages/metrics/src/components/SessionComparePanel.tsx` |
| Tauri | `src-tauri/` |
| Vitest tests | `tests/*.test.ts` |
| CI | `.github/workflows/ci.yml` |

---

## Verification commands

```powershell
cd "C:\Users\nihar\Documents\GitHub\omniswim-suite\omniswim-suite"
npm install
npm run lint
npm test
npm run -w @omniswim/shell build
npx tsx scripts/test_sqlite_roundtrip.mjs
```

**PostgreSQL (optional):**
```powershell
$env:DATABASE_URL='postgres://user:pass@localhost:5432/omniswim'
npm run migrate:postgres
$env:OMNI_DB='postgres'
npm run dev
```

**Tauri desktop (optional, requires Rust):**
```powershell
npm run tauri:build
```

Manual smoke: home page pool hero → Matrix PDF → Manager roster → `/analytics` trends → Metrics video + session compare → (postgres) login + share link.

---

## Constraints (do not violate)

- No external/cloud AI by default; `/api/analyze-video` stays 501.
- `SuiteWorkspaceProvider` context shape and `useWorkspaceScoring` return shape are frozen.
- `packages/core` must NOT import `@omniswim/ui`.

---

## Phase 2 handoff

Previous progress: `PHASE2_PROGRESS.md` (archived — Phase 2 complete).
