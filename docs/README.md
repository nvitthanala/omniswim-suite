# Documentation index

Root-level docs (`README.md`, `CLAUDE.md`, `SUITE_ROADMAP.md`, `CHANGELOG.md`) stay
in the repository root. Everything else lives here.

## Reference — current

Living documents that describe how a part of the system works today.

| Doc | Covers |
| --- | --- |
| [reference/CUTLINE_TAGS_PLAN.md](reference/CUTLINE_TAGS_PLAN.md) | The cutline-tag provenance rebuild — four verified NCAA/NAIA sources, the tag taxonomy, and the finding that the original `cutlines.ts` mislabeled D2 data as D1. |
| [reference/PERFORMANCE_NOTES.md](reference/PERFORMANCE_NOTES.md) | The optimisation pass that memoised `convertTimeToSeconds`, stabilised `TeamRosterPanel` references, and added transitions to the import panel. |
| [reference/ROSTER_CATALOG_NOTES.md](reference/ROSTER_CATALOG_NOTES.md) | The cross-workspace team roster catalog: course-aware eligibility, how it's queried. |

## Video — current

| Doc | Covers |
| --- | --- |
| [video/VIDEO_ANALYSIS_MASTERPLAN.md](video/VIDEO_ANALYSIS_MASTERPLAN.md) | The full video-analysis suite plan: local metrics, biomechanics scope, staged rollout. |
| [video/VIDEO_TAGGING_FRAMEWORK.md](video/VIDEO_TAGGING_FRAMEWORK.md) | The tagging schema and workflow for annotating swim video sessions. |

## Archive — historical

Kept for the reasoning they record. Each carries an "Archived" header; treat the
described *behaviour* as possibly stale even where the *reasoning* still holds.

### 2026-06 — pre-Phase-4, all superseded by later work

| Doc | Covers |
| --- | --- |
| [archive/2026-06/PHASE2_PROGRESS.md](archive/2026-06/PHASE2_PROGRESS.md) | Phase 2 handoff: prelims O/U, psych pipeline notes. |
| [archive/2026-06/PHASE3_PROGRESS.md](archive/2026-06/PHASE3_PROGRESS.md) | Phase 3 handoff, marked fully complete as of 2026-06-29. |
| [archive/2026-06/PHASE4_PLAN.md](archive/2026-06/PHASE4_PLAN.md) | The Phase 4 epic proposal (biomechanics, analytics v2, collaboration, reporting, recruiting, desktop polish). Proposal only — check `SUITE_ROADMAP.md` for what actually shipped. |
| [archive/2026-06/CHART_BLANK_HANDOFF.md](archive/2026-06/CHART_BLANK_HANDOFF.md) | Diagnostics for a blank-Matrix-chart bug. Marked resolved in the doc itself; root cause was a stale dev server. |

### 2026-08 — roster/lineup and matrix rescore rounds

| Doc | Covers |
| --- | --- |
| [archive/2026-08/PHASE3_UI_PROGRESS.md](archive/2026-08/PHASE3_UI_PROGRESS.md) | Phase 3 UI foundation handoff: chart architecture, momentum/psych UI. |
| [archive/2026-08/MATRIX_RESCORE_OVERHAUL_HANDOFF.md](archive/2026-08/MATRIX_RESCORE_OVERHAUL_HANDOFF.md) | Round 2: event-identity unification between imported roster data and loaded meet PDFs, merged/PDF-only scoring toggle, swim editor. |
| [archive/2026-08/ROSTER_DATA_OVERHAUL_HANDOFF.md](archive/2026-08/ROSTER_DATA_OVERHAUL_HANDOFF.md) | Round 1: multi-athlete SwimCloud import, SCM/LCM→SCY conversion + distance remap, scoring-theory import, HSU 26-27 seed, UI token modernization. |
| [archive/2026-08/ROSTER_ALIAS_DECLUTTER_HANDOFF.md](archive/2026-08/ROSTER_ALIAS_DECLUTTER_HANDOFF.md) | Round 3: athlete name aliasing, roster/lineup bug-fix wave, drawer declutter. |
| [archive/2026-08/ROSTER_LINEUP_BUGS_DEEPDIVE.md](archive/2026-08/ROSTER_LINEUP_BUGS_DEEPDIVE.md) | Root-cause report behind the round-3 bug fixes. The reasoning here is why several current invariants exist — see `docs/INVARIANTS.md`. |
| [archive/2026-08/ROSTER_LINEUP_PROGRESS.md](archive/2026-08/ROSTER_LINEUP_PROGRESS.md) | Manager Lineup/Relays workflow handoff: compliance checklist, non-scorer relay vacate. |

## See also

- [INVARIANTS.md](INVARIANTS.md) — true-but-undocumented facts about this codebase, each with the consequence of not knowing it.
- [../CHANGELOG.md](../CHANGELOG.md) — user-visible behaviour changes, newest first.
- [../SUITE_ROADMAP.md](../SUITE_ROADMAP.md) — the live plan.
