# Omni Swim Suite — Phase 3 Implementation Progress / Handoff

> Living document. **Source plan:** `.cursor/plans/omni_swim_phase_3_2b678aae.plan.md` (do not edit the plan file).

**Last updated:** 2026-06-29. Phase 3 **fully complete**. Post-Phase-3 work (charts, prelims O/U, psych pipeline, momentum charts, CI) is documented in:

- [PHASE3_UI_PROGRESS.md](PHASE3_UI_PROGRESS.md) — UI foundation, chart architecture, psych/momentum UI
- [PHASE2_PROGRESS.md](PHASE2_PROGRESS.md) — scoring/persistence handoff, prelims and psych algorithms
- [README.md](README.md) — user-facing feature overview and troubleshooting

Working dir: repository root (`omniswim-suite/`). Package manager: **npm** workspaces. Node 20+ and Python 3 (for PDF parsing).

---

## Phase 3 epics (all DONE)

| id | description |
|----|-------------|
| pg-adapter | PostgreSQL adapter, `OMNI_DB=postgres`, migrations |
| auth-multiuser | Auth, workspace sharing, login UI |
| sqlite-default | SQLite default, auto-import `meets.json` |
| ci-tests | GitHub Actions CI: lint, test (incl. Playwright + Python), build |
| tauri | Optional desktop shell (`src-tauri/`) |
| feature-analytics | Season analytics at `/analytics` |
| feature-video | Metrics lap/multi-session compare |
| feature-reporting | Printable reports + share links |
| ux-redesign | Home, layout, unified naming |
| docs-naming | README, handoff docs, product naming |

---

## Architecture

```
Clients (web / Tauri) → Express (apps/shell) → WorkspaceRepo
  OMNI_DB=sqlite   → SqliteRepo  (default, local)
  OMNI_DB=json     → JsonRepo    (legacy backup)
  OMNI_DB=postgres → PgRepo      (shared multi-user + auth)
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `OMNI_DB` | `sqlite` | `sqlite`, `json`, or `postgres` |
| `DATABASE_URL` | — | Required when `OMNI_DB=postgres` |
| `OMNI_AUTH_REQUIRED` | `true` when postgres | Force login for workspace routes |
| `OMNI_AI_ENABLED` | `false` | Gate Gemini image parsing |

---

## Verification (2026-06-29)

```powershell
npm run lint
npm test
npm run build
```

Result: **PASS** — 20 passed, 2 skipped (optional NSISC scoring fixtures). CI green on `main`.

---

## Constraints

- No external/cloud AI by default; `/api/analyze-video` stays 501 unless `OMNI_AI_ENABLED=true`.
- `packages/core` must not import `@omniswim/ui`.
- Chart rule: `ChartShell` → `ChartFrame` → Recharts with explicit pixels; no `%` `ResponsiveContainer`.

---

## Key paths

| Area | Path |
|------|------|
| Server | `apps/shell/server.ts` |
| Psych parse API | `POST /api/parse-psych-pdf` |
| Psych scoring | `packages/core/src/lib/psychProjection.ts` |
| Team aliases | `packages/core/src/data/teamAliases.ts` |
| Momentum charts | `packages/matrix/src/components/MomentumChartCard.tsx` |
| CI | `.github/workflows/ci.yml` |
| E2E | `tests/e2e/matrix-chart.spec.ts` |

Previous phase: [PHASE2_PROGRESS.md](PHASE2_PROGRESS.md). Next planning: [PHASE4_PLAN.md](PHASE4_PLAN.md).
