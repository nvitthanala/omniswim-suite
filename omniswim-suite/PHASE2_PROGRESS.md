# Omni Swim Suite — Phase 2 Implementation Progress / Handoff

> Living document. Updated continuously during Phase 2 work so any agent (or human)
> can resume mid-stream. **Source of truth for the plan:** `c:\Users\nihar\.cursor\plans\omni_swim_phase_2_4df6b445.plan.md` (do NOT edit the plan file).

Last updated: 2026-06-19 (session 3). Phase 2 **fully complete** — all items DONE and verified via full production build + SQLite roundtrip test.

---

## How to resume (read this first)

1. Read this file top to bottom.
2. Check the **Todo status** table below for the next `pending`/`in_progress` item.
3. Re-run the verification commands in **Verification** to confirm the current build state.
4. Continue from **Next concrete steps**.

Working dir for all commands: `C:\Users\nihar\Desktop\omniswim suite\omniswim-suite`
Package manager: **npm** (workspaces). Node + Python (venv auto-created by server on first run).

---

## Todo status

| id | description | status |
|----|-------------|--------|
| p2a-server-io | Async write queue for meets.json, Zod validation on API, toast UI, unified `parse_meet.py` | **DONE** |
| p2a-client-perf | TanStack Query for workspace state; Web Worker for scoring | **DONE** |
| p2b-sqlite | `packages/db` **node:sqlite** (NOT better-sqlite3), WorkspaceService, migrate script, JSON backup, snapshots | **DONE** |
| p2c-swim-data | SwimCloud paste v2, iframe side-panel, CSV import, HyTek/SDIF export, versioned cutlines | **DONE** |
| p2c-metrics-local | Metrics IndexedDB sessions, video metadata, split vs workspace compare, report export | **DONE** |
| p2d-matrix-polish | PDF progress/cancel, meet diff view, batch optimizer, workspace snapshots UI | **DONE** |
| p2d-distribution | `Start-OmniSwim-Suite-Prod.bat`, `run-smoke-tests.bat`, optional Tauri exe | **DONE** (bats created; Tauri optional/skipped) |
| p2-cleanup | Disable `@google/genai` runtime paths, document `OMNI_AI_ENABLED=false`, paste-only history | **DONE** |

> **CURRENT CHECKPOINT (2026-06-19, session 3):** Phase 2 is **fully complete**. All 8 epics DONE and build-verified. Latest: `npm run -w @omniswim/shell build` exit 0, `npx tsx scripts/test_sqlite_roundtrip.mjs` PASSED.

> **HANDOFF (ready for next phase):** Phase 2 is fully complete. All epics DONE + build-verified. Tauri optional (skipped). See **Phase 2 summary** below for all implemented artifacts.

---

## Completed in this session (session 3)

### p2d-matrix-polish — Batch Optimizer UI + Workspace Snapshots UI (DONE)

**Batch Optimizer UI:**
- **`packages/manager/src/components/BatchOptimizerPanel.tsx`** (NEW): Modal panel with:
  - Optimization scope selector: Scorers Only / Events Only / Full (both)
  - "Run Optimizer" button with spinner/loading state
  - Results summary showing projected total, baseline total, and delta
  - Change detail showing scorer override count and event plan count
  - "Apply to Workspace" button that patches `scorerRosterOverrides`, `meetEntryPlans`, and `activeEntryIds`
  - Uses `optimizeRosterAllTeams` from `@omniswim/core/lib/rosterOptimizer`
- **`packages/manager/src/ManagerApp.tsx`** (EDITED): Added "Batch Optimizer" button in header toolbar, wired open/close state.

**Workspace Snapshots UI:**
- **`packages/core/src/api/snapshots.ts`** (NEW): Client API — `createSnapshot`, `listSnapshots`, `restoreSnapshot` with proper error handling.
- **`apps/shell/src/components/WorkspaceSidebar.tsx`** (EDITED): Added "Snapshots" section at bottom of sidebar:
  - Camera icon to toggle create-snapshot inline form
  - Label input + Save/Cancel buttons
  - Auto-loads snapshot list for active workspace
  - List of recent snapshots with timestamps and restore button (with spinner)
  - Graceful fallback when JSON backend returns error
  - Loading and empty states

### p2-cleanup (previously DONE, re-verified)
- `OMNI_AI_ENABLED` gating on AI image parsing paths (default false)
- `@google/genai` import is dynamic + try/catch guarded
- `README.md` documents both `OMNI_AI_ENABLED` and `OMNI_DB` runtime vars
- Dead `packages/metrics/src/App.tsx` deleted
- Verified: no remaining references to dead file

---

## Completed in earlier sessions

### p2a-server-io (DONE)
- **`apps/shell/lib/jsonStore.ts`** (NEW): `JsonStore<T>` class — async single-writer queue, atomic temp-file+rename writes, timestamped backups in `data/backups/` with pruning (keep 20). Methods: `init()`, `read()`, `mutate(fn)`, `backup(label)`.
- **`packages/core/src/schemas/workspace.ts`** (NEW): Zod schemas — `workspaceSchema`, `createWorkspaceSchema`, `updateWorkspaceSchema`, `parsePdfSchema`, `parseAthleteHistorySchema`, `importCsvSchema`. Permissive (`.passthrough()`).
- **`backend/parse_meet.py`** (NEW): single-process pipeline → `{ athletes, conference, officialTeamScores }`. Imports `pdf_parser.parse_pdf`, `point_calculator.calculate_points`, `team_rankings_parser.extract_team_rankings_from_pdf`.
- **`backend/pdf_parser.py`** (EDITED): `parse_pdf()` now **returns** results (was `print`); `__main__` prints. Keeps CLI working + lets `parse_meet.py` import it.
- **`apps/shell/server.ts`** (EDITED): workspace CRUD now uses `JsonStore` (async). Added Zod validation on POST/PUT/parse-pdf/parse-athlete-history. New `POST /api/workspaces/backup`. `/api/parse-pdf` now tries `parseMeetUnified()` (single process) and falls back to `parseMeetLegacy()` (3 processes). Extracted `mapAthleteRows()` helper.
- **`packages/ui/src/components/Toast.tsx`** (NEW): `ToastProvider`, `useToast()` (graceful console fallback if no provider), viewport bottom-right. Exported from `packages/ui/src/index.ts`.
- **`packages/ui/src/index.css`** (EDITED): added `.toast-viewport`, `.toast-item`, kind variants + animation.
- **`packages/matrix/src/components/OpsModule.tsx`** (EDITED): replaced `alert()` PDF error with `toast.push('error', ...)`, added catch block for network failure.

### p2a-client-perf (DONE)
- **`apps/shell/src/main.tsx`** (EDITED): wrapped app in `QueryClientProvider` (staleTime 30s, no refetchOnWindowFocus, retry 1) + `ToastProvider`.
- **`packages/core/src/store/SuiteWorkspaceProvider.tsx`** (REWRITTEN): now uses TanStack Query `useQuery(['workspaces'])` + `useMutation` for update. Optimistic edits via `queryClient.setQueryData`, 300ms debounce retained. **Public context surface UNCHANGED** (hard constraint). Added optional `onNotify?: (kind, message) => void` prop for toast wiring.
- **`apps/shell/src/App.tsx`** (EDITED): passes `onNotify={toast.push}` to provider.
- **`packages/core/src/lib/scoringEngine.ts`** (NEW): extracted pure `buildScoringBundle` + `buildScoringSnapshot` from `useWorkspaceScoring` so it runs on main thread OR in a worker.
- **`packages/core/src/workers/scoringWorker.ts`** (NEW): worker entry, message protocol `{ id, workspace, gender, removeSeniors }` → `{ id, ok, projected, baseline }`.

### Build fixes applied during verification
- **`apps/shell/vite.config.ts`**: added specific alias `@omniswim/ui/styles.css` → `packages/ui/src/index.css`. Added `shared-suite` manualChunk for `packages/core` + `packages/ui` to break an `applet-manager ↔ applet-matrix` circular chunk.
- **`packages/matrix/src/index.ts`** (NEW): barrel `export { default } from './MatrixApp'` so the directory-targeting alias `@omniswim/matrix` resolves the bare import.

### p2b-sqlite (DONE)
- **`packages/db/`** (NEW package `@omniswim/db`): `src/schema.ts` (DDL, WAL, FKs, child tables + `workspace_snapshots`), `src/WorkspaceService.ts` (assembles/persists full `Workspace`; CRUD + snapshots + `replaceAll`/`exportAll`), `src/index.ts`.
- **`apps/shell/lib/workspaceRepo.ts`** (NEW): `WorkspaceRepo` interface + `JsonRepo` (wraps JsonStore) + `SqliteRepo` (wraps WorkspaceService).
- **`apps/shell/server.ts`**: CRUD routes call `repo.*`. Snapshot routes: `POST/GET /api/workspaces/:id/snapshots`, `POST /api/snapshots/:snapshotId/restore`.
- **`scripts/migrate-json-to-sqlite.mjs`** + **`scripts/test_sqlite_roundtrip.mjs`**: migration and round-trip integrity test. **PASSES.**

### p2c-swim-data (DONE)
- **`packages/core/src/lib/csvImport.ts`** (NEW): `parseCsvHistory(csv, {team,gender})` → HistoricalSwim[].
- **`packages/core/src/lib/entryExport.ts`** (NEW): `exportEntriesCsv` + `exportEntriesHytek` + `selectActiveEntries`.
- **`packages/manager/src/components/RosterImportWizard.tsx`**: added Paste/CSV mode tabs, CSV file picker, SwimCloud reference `<iframe>` panel.
- **`packages/manager/src/ManagerApp.tsx`**: Export CSV + Export HyTek buttons.
- **Versioned cutlines**: server endpoints for cutline versions.

### p2c-metrics-local (DONE)
- IndexedDB session save, video metadata, split vs workspace comparison, CSV report export.

### p2d-distribution (DONE)
- `Start-OmniSwim-Suite-Prod.bat`, `scripts/run-smoke-tests.bat`. Root `package.json` has `start`, `migrate:sqlite`, `test:roundtrip`.

### p2-cleanup (DONE)
- `OMNI_AI_ENABLED` gating, `@google/genai` guarded, dead `App.tsx` deleted, `README.md` documented.

---

## Verification commands

```powershell
cd "C:\Users\nihar\Desktop\omniswim suite\omniswim-suite"
# Full production build
npm run -w @omniswim/shell build
# SQLite round-trip test
npx tsx scripts/test_sqlite_roundtrip.mjs
# Dev run
npm run dev   # or Start-OmniSwim-Suite.bat ; open http://localhost:3000
```

Manual smoke (after dev server up): Matrix PDF upload → charts; toggle what-if; Manager roster edits persist after refresh; trigger a bad PDF to see error toast; try batch optimizer in Manager; take/restore snapshots in sidebar.

---

## Architecture decisions / constraints (do not violate)

- **No external AI**: do not wire Gemini / cloud video / cloud OCR. `/api/analyze-video` stays 501. `parse-athlete-history` image branch only runs if `GEMINI_API_KEY` set — leave gated.
- **Applet API stability**: `SuiteWorkspaceProvider` context value shape is frozen. `useWorkspaceScoring` return shape is frozen.
- **Metrics is local-only** (`calculateMetricsLocal`, manual tagging).
- **Persistence default = SQLite** for p2b; PostgreSQL is a later optional adapter. Keep JSON backup export for portability.
- `core` must NOT import `@omniswim/ui` (avoid coupling) — use the `onNotify` callback pattern instead.

---

## Key file map

| Area | Path |
|------|------|
| Server | `apps/shell/server.ts` |
| JSON store | `apps/shell/lib/jsonStore.ts` |
| Zod schemas | `packages/core/src/schemas/workspace.ts` |
| Workspace store | `packages/core/src/store/SuiteWorkspaceProvider.tsx` |
| Scoring engine (pure) | `packages/core/src/lib/scoringEngine.ts` |
| Scoring worker | `packages/core/src/workers/scoringWorker.ts` |
| Scoring hook | `packages/core/src/lib/useWorkspaceScoring.ts` |
| Toasts | `packages/ui/src/components/Toast.tsx` |
| Python unified | `backend/parse_meet.py` |
| Providers root | `apps/shell/src/main.tsx` |
| DB layer | `packages/db/src/{schema,WorkspaceService,index}.ts` |
| Storage adapter | `apps/shell/lib/workspaceRepo.ts` |
| Metrics local libs | `packages/metrics/src/lib/{sessionStore,videoMeta,reportExport}.ts` |
| Import/export libs | `packages/core/src/lib/{csvImport,entryExport}.ts` |
| Batch optimizer | `packages/manager/src/components/BatchOptimizerPanel.tsx` |
| Snapshot API | `packages/core/src/api/snapshots.ts` |
| Launchers | `Start-OmniSwim-Suite.bat`, `Start-OmniSwim-Suite-Prod.bat`, `scripts/run-smoke-tests.bat` |

---

## Phase 2 artifacts summary

All files created or modified during Phase 2 are listed above. The monorepo structure is:

- `apps/shell` — SPA host, Express server, routing
- `packages/core` — types, scoring libs, workspace store, API client
- `packages/ui` — Matrix design tokens, Toast
- `packages/db` — SQLite backend (node:sqlite)
- `packages/{manager,matrix,metrics}` — lazy-loaded applets
- `backend/` — Python parse pipeline
- `scripts/` — migration, test, export utilities

## How to enable SQLite at runtime

PowerShell: `$env:OMNI_DB='sqlite'; npm run dev` (or use `Start-OmniSwim-Suite-Prod.bat` after `$env:OMNI_DB='sqlite'`). First migrate JSON→DB with `npm run migrate:sqlite`. JSON stays the default; SqliteRepo falls back to JSON if init fails.

## Pre-existing non-issue

Standalone `tsc` lint of `@omniswim/{ui,matrix,manager}` reports `Cannot find module '@omniswim/core/lib/*'` because those tsconfigs lack `paths`. Vite/esbuild resolve via aliases; full build is green. Do NOT chase these.