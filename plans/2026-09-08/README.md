# SwimCloud full-capture — design round, 2026-09-08

Goal: one click on a SwimCloud meet or team page captures the *entire*
relevant dataset — not just the page on screen — into a local capture store
that Matrix's "+ from SwimCloud" button reads from, replacing today's
one-page-at-a-time clipboard paste. This folder is the plan: the immediate
bug this closes, the three architecture decisions the user made directly on
2026-09-08, and the design to build against. No code has been written yet.

| # | File | What's in it |
| - | ---- | ------------- |
| 00 | [Executive summary](00-executive-summary.md) | The symptom, the actual state of the bug, why a parser fix isn't enough, what this round builds and doesn't |
| 01 | [Decisions](01-decisions.md) | The three decisions on record: auto-fetching extension, local capture store, asymmetric meet/team scope |
| 02 | [Capture store](02-capture-store.md) | On-disk layout, format, merge semantics, relationship to the existing filesystem cache |
| 03 | [Extension crawler](03-extension-crawler.md) | Request sequencing, pacing/politeness, error handling, progress/cancel, how bytes reach the store |
| 04 | [Parsers and fixtures](04-parsers-and-fixtures.md) | What's reused, what's new, what needs a real capture first, what gets retired |
| 05 | [Matrix import UI](05-matrix-import-ui.md) | The capture picker, what stays unchanged in the import pipeline |
| 06 | [Testing and verification](06-testing-and-verification.md) | Real fixtures needed, unit tests, manual verification checklist |
| 07 | [Phasing and delegation](07-phasing-and-delegation.md) | Who builds what, in what order, and the long-horizon state file |
| 08 | [Open questions](08-open-questions.md) | Eight questions, each blocking something, each answerable only by a real page capture |
| — | [WORKLOG-01](WORKLOG-01-phase1-capture-store-and-parsers.md) | **Phase 1 done, 2026-09-08.** Capture store, crawl planner, `parseMeetTeamsHtml`/`parseMeetTopTeamsHtml`, `clipboardPayload` v2 — built, verified, API surface reported. |

## What changed since 2026-09-06

That round shipped a working single-page "From clipboard" import. This round
was triggered by that mechanism failing at real scale: a full meet is dozens
of manual captures, and the one path that *did* route through a single
clipboard paste (`parseMeetResultsHtml`, reached via Manager's roster-import
wizard) turned out to target a page shape that doesn't exist on SwimCloud
(see [00](00-executive-summary.md)).

This round **amends two of that round's recorded decisions**, in place, per
[`plans/2026-08-16/README.md`](../2026-08-16/README.md) rule 5 ("corrections
are recorded in place"):

- [`2026-09-06/01-legal-and-access-strategy.md`](../2026-09-06/01-legal-and-access-strategy.md)
  §4 — the browser extension moves from Track A (zero network calls of its
  own) to **Track A′** (auto-fetches a whole subject after one click, still
  from the user's own session, still no headless automation). See
  [01](01-decisions.md) D1.
- [`2026-09-06/03-architecture.md`](../2026-09-06/03-architecture.md) §5 —
  the transport from extension to app moves from "undecided, clipboard used
  in practice" to a local HTTP route, because the open question that
  section left unresolved now has a real answer forced by volume. See
  [03](03-extension-crawler.md).

Everything 2026-09-06 verified working — the scoring pipeline, the
clipboard-paste path for a single page, `mergeSwimCloudResults`,
`parseTeamMeetSwimsHtml` — stays as it is. This round changes what feeds
that pipeline, not the pipeline itself.

## How this plan was produced

Briefed and read against the live working tree (branch
`nvitthanala/swimcloud-data-ingest`) covering: the exact current failure
(`packages/matrix/src/components/OpsModule.tsx`,
`packages/manager/src/components/RosterImportWizard.tsx`), every file under
`packages/swimcloud/src`, the existing `extensions/swimcloud-companion/`
extension, and the full `plans/2026-09-06/` record. One assumption in the
original brief was checked against the real fixture and found wrong — see
[08](08-open-questions.md) OQ-1 — which is exactly the kind of finding this
process exists to catch before something gets built on top of it, not after.
