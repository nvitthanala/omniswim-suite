# Phasing and delegation

Uses the repo's actual contract: `.claude/agents/{orchestrator,executor,worker,finisher}.md`,
and `CLAUDE.md`'s "land core green before UI, briefed against a reported
API."

| Phase | Owner | Scope | Depends on |
| --- | --- | --- | --- |
| **0** | **Human** | Capture F1–F5, archive with finding headers. **F1 and F1b done (2026-09-08) — the two that blocked Phase 1.** F2–F5 remain open, non-blocking. | — |
| **0b** | `executor` | Re-point `RosterImportWizard.handleClipboardMeetResults` off `parseMeetResultsHtml`; mark it deprecated. The standalone bug fix. | — (runs in parallel with 0) |
| **1** | ✅ **Done 2026-09-08** (direct execution, no subagent) | `packages/swimcloud`: `captureStore.ts`, `crawlPlan.ts`, `parseMeetTeamsHtml`, `parseMeetTopTeamsHtml`, new `meetTopTeams` resource kind, additive `SwimCloudCacheEntry` fields, `clipboardPayload` v2. Verified: lint clean across all 8 workspaces, 363/363 tests pass, production build succeeds. API surface reported in `WORKLOG-01-phase1-capture-store-and-parsers.md`. Uncommitted — no git ops, per standing rule. | — |
| **2** | `executor` (opus) | `apps/shell/server.ts`: capture routes, pairing token, loopback guard, path-traversal guard, sha256 on write. Security-critical → executor, not worker. | 1 |
| **3** | `worker` (sonnet) | `extensions/swimcloud-companion`: esbuild bundle step, **content-script crawl loop** (not the service worker — see 03-extension-crawler.md's 2026-09-08 correction), a thin background relay-to-server + `chrome.downloads` fallback, progress/cancel panel, options page, README rewrite Track A → Track A′, `manifest.json` additions (`background.service_worker`, `permissions: ["downloads"]`, `host_permissions: ["http://127.0.0.1/*"]`). Executes a plan from Phase 1; makes no crawl decisions. | 1 + 2 |
| **4** | `worker` (sonnet) | `packages/matrix`: `SwimCloudCapturePicker.tsx`, the `OpsModule` menu, `applySwimCloudRows` extraction. Bridge and merge untouched. | 1 + 2 |
| **5** | `executor` (opus) | **Team subject.** Rewrite `parseTeamRosterHtml` / `parseSwimmerProfileHtml` against real markup; new `parseTeamResultsHtml`; season definition; extend `crawlPlan`. | **F6, F7, F8 — gated, may not start without them** |
| **6** | `finisher` (haiku) | Lint, typecheck, full suite across `packages/swimcloud`, `packages/matrix`, `apps/shell`, `extensions/`, plus `npm run build`. Edge cases. No design decisions. | 3 + 4 |
| **7** | **Human** | The [06](06-testing-and-verification.md) manual checklist and screenshots. Then write `WORKLOG-01` and the in-place amendments to `plans/2026-09-06/` and `plans/STATE.md`. | 6 |

**Parallelism.** 3 and 4 are disjoint (`extensions/` vs `packages/matrix`)
and may run concurrently once 1 and 2 are green and 1's API is reported. 1
and 2 are serial — 2 consumes 1's store API. 0b is disjoint from everything
(`packages/manager`).

**Fleet.** Per `CLAUDE.md`'s cross-provider section, Phase 1 is
data-provenance-shaped work over a parser boundary; sending the same brief
to Claude and to Codex and comparing is explicitly the recommended
treatment for this class. Worth doing for the capture-store schema
specifically, where disagreement is the finding.

## Long-horizon state tracking — yes, and in a new file

This warrants the `execution-state` skill. It is eight phases, at least
four agent dispatches, a blocking human step in the middle, and a second
blocking human gate before Phase 5. `CLAUDE.md`'s "Long-horizon task state"
section says this branch has already lost a subagent's results once to an
improvised scratchpad and a resume.

Use **`docs/reference/SWIMCLOUD_CAPTURE_STATE.json`** — a new file, **not**
an addition to `docs/reference/PHASE_STATE.json`. That file tracks a
different sweep (`"sweep": "phase-2-core-complexity"`) with a `targets[]`
schema of refactor targets and `rawCC` values. Folding a phased feature
build into it would misattribute results across two unrelated efforts,
which is the exact failure mode that section warns about.

Schema:

```json
{
  "initiative": "swimcloud-full-capture",
  "phases": [
    { "id": "0", "owner": "human", "status": "not-started", "blockedBy": [], "acceptance": "F1-F5 archived under tests/fixtures/", "verifiedBy": [], "commit": null }
  ],
  "fixtures": [
    { "id": "F1", "path": null, "status": "not-captured" }
  ],
  "openQuestions": [
    { "id": "OQ-1", "status": "open" }
  ]
}
```

Every brief to a resumed or fresh subagent points at its phase's entry,
never at "continue where you left off."
