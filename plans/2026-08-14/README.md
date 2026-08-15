# Improvement plan — 2026-08-14

A findings-and-options review of the suite, written after a day of correctness
work on the scoring/roster core. Everything here is grounded in something
measured against the two live workspaces (`Blank Workspace 1`, `HSU 2026-27
Roster Plan`) or read out of the tree — not inferred from the docs.

## How this folder is organised

| File | Theme |
| ---- | ----- |
| [00-executive-summary.md](00-executive-summary.md) | What matters most, in order, with the one-line reason |
| [01-fabricated-values.md](01-fabricated-values.md) | Numbers shown to coaches that are not what their label claims |
| [02-data-quality-aliasing.md](02-data-quality-aliasing.md) | Split athletes, junk events, provenance gaps in the constants |
| [03-scoring-model-depth.md](03-scoring-model-depth.md) | Where the model is thinner than the UI implies |
| [04-architecture-complexity.md](04-architecture-complexity.md) | Files and seams that make the above expensive to fix |
| [05-ux-workflow.md](05-ux-workflow.md) | Flow, disclosure and the "uninitiated coach" problem |
| [06-testing-verification.md](06-testing-verification.md) | What the suite does and does not actually prove |
| [07-packaging-offline-ops.md](07-packaging-offline-ops.md) | Getting it onto someone else's machine and keeping it there |
| [08-docs-knowledge-debt.md](08-docs-knowledge-debt.md) | 18 root markdown files, several stale |

## Worklogs — findings taken to done

| Worklog | Finding | Status |
| ------- | ------- | ------ |
| [WORKLOG-01](WORKLOG-01-arbitrage-units.md) | Arbitrage "points" were seconds × 2 | done — shipped `f3355927` |

## Status legend used throughout

- **P0** — produces a wrong number a coach could act on. Fix before it is trusted.
- **P1** — real defect or real friction, not silently wrong.
- **P2** — worth doing, no correctness consequence.
- **Open question** — needs a decision from you, not an implementation.

## Scope

**Video analysis is deliberately excluded** (your instruction, 2026-08-14). The
suite's `VIDEO_ANALYSIS_MASTERPLAN.md` / `VIDEO_TAGGING_FRAMEWORK.md` workstreams
(E1 pose extraction, E2 `detected` provenance, E3 stroke classification) are not
assessed here. Note only that they remain gated on the same thing they were in
August: **no real race has been tagged by hand yet.**

## What was fixed on 2026-08-14, for context

These are already on `main` and are the reason some sections read "now" vs
"was". They are listed so this plan is not confused with them.

| Commit | What |
| ------ | ---- |
| `ad616e69` | IM conversion factor key mismatch (57 fabricated conversions); unknown-event conversion now raises; Manager steps 2–4 dead-end; layout clipping; 5 missing `aria-label`s |
| `7af56513` | Production launcher served 404 and seeded an empty DB from a fresh clone |
| `ea8ad61e` | The loaded meet now decides which events a swimmer can be entered in |
| `350a42a7` | Best events ranked by quality vs the published standard, not by raw elapsed seconds |
| `f3355927` | Arbitrage cards state real points, or state nothing — see [WORKLOG-01](WORKLOG-01-arbitrage-units.md) |

Current baseline: lint clean across 7 packages, `npm test` **47 passed / 0
failed / 3 skipped**, `npm run build` exit 0.
