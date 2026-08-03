# Team Roster Catalog ΓÇö Architecture Notes

> Captures design decisions for the cross-workspace Team Roster Catalog
> (implementations live in `packages/db`, `packages/core/src/lib/rosterCatalog.ts`,
> `packages/core/src/api/rosterCatalog.ts`, and `apps/shell/server.ts`).

## Goals

1. Store teams ΓåÆ athletes ΓåÆ athlete ├ù event times **independently** of any
   workspace's loaded meet.
2. Survive workspace deletion, swap, or PDF re-parse cycles.
3. Support **course-aware** import: SCY, LCM, SCM times all persist alongside
   a canonical SCY companion used for cross-pool scoring.
4. Allow per-event eligibility toggling so a coach can "try" a swimmer in an
   event without committing historical data.
5. Provide a JSON import shape that any external roster (HyTek export,
   spreadsheet, etc.) can deserialize to.

## Storage model

The catalog follows two interchangeable backends:

- **JSON** (`data/roster_catalog.json`): default, zero-setup, async serialized
  writes via `JsonStore`. Mirror of the existing workspace JSON pipeline.
- **SQLite** (`data/omniswim.db`): when running with `OMNI_DB=sqlite`. The
  catalog tables (`teams`, `athletes`, `athlete_event_times`) live in the
  same SQLite file as the workspace data, sharing `node:sqlite`'s
  `databaseSync` instance. CASCADE deletes make removing a team clean up
  athletes and their times.

The choice is opaque at the API surface ΓÇö every server route reads/writes
through `RosterCatalogRepo`, which has matching methods on both
`JsonRosterCatalog` and `SqlRosterCatalog`.

## Course conversion

`buildStoredSwim()` in `packages/core/src/lib/rosterCatalog.ts` always
populates `timeSecondsScy`:

1. Convert the original `timeText + timeType` to raw seconds.
2. Call `convertToSCY()` ΓÇö returns the input unchanged when the input is SCY;
   uses the conversion factor table in `packages/core/src/constants.ts`
   otherwise.
3. Record both `time_seconds` (native course) and `time_seconds_scy`
   (SCY-normalized companion).

This satisfies the "Store original + computed SCY pair" requirement without
ever losing the original clock.

## Eligibility model

`is_eligible` is the canonical on/off flag for "does this time count toward
the scoring pool?". The on-disk column is `INTEGER NOT NULL DEFAULT 1`
(0/1) for SQLite friendliness and mirrors the boolean on the JSON side.

- Default is `1` (eligible) so first-time imports work without extra steps.
- Toggling is rate-cheap: one row update per swim.
- The roster UI (in `AthleteRosterRow`) and the Matrix catalog sub-pill
  both observe eligibility without needing to rewrite scoring logic.
- The existing `maxIndividualEntriesPerSwimmer` is **still enforced** in
  `buildCategorizedScoringInputs` ΓÇö only the top-N best events per athlete
  (by SCY) become eligible rows in the scoring pool even if all are flagged
  eligible.

## Scoring integration

The catalog never replaces PDF-meet data ΓÇö it *layers* on top:

- `useWorkspaceScoring` accepts an optional `rosterCatalog?: CatalogTeamRoster`.
- `buildScoringSnapshot` forwards to `buildScoringBundle`, which calls
  `buildCategorizedScoringInputs` to merge catalog rows with the existing
  what-if results.
- Each catalog row is normalized to a `SwimmerResult` with `isRecruit: true`
  and a rank-of-0 ΓÇö the same shape `prepareRecruitsForScoring` already feeds
  into the points ladder (`utils.ts:975`). This guarantees no scoring rules
  are re-forked; the recruit injection pathway is reused.

## Worker boundary

`scoringWorker.ts` accepts `rosterCatalog?` and forwards it to
`buildScoringSnapshot`. Because `rosterCatalog` is fully serializable (string
ids, plain numbers, no functions), it crosses the postMessage boundary
without bespoke transformation.

## JSON import format

See "`Team Roster Catalog ΓåÆ JSON import format`" in `README.md`. Validation
lives in `validateRosterCatalogJson()` and surfaces friendly issues if the
input leads to a 4xx at the API layer. Server side, `POST /api/roster/import-json`
walks the document, upserts the team (idempotent on `name + gender`),
upserts each athlete, and writes each time through `buildStoredSwim()` so
the same SCY conversion + cut check path runs as for paste flow.

## What we explicitly did NOT do

- **No cloud threads or worker calls from a browser to fetch SwimCloud.**
  Cloudflare blocks automation; paste is the only honest path.
- **No OMNI_AI_ENABLED side-effects.** All Gemini paths stay gated.
- **No regression on existing P1-3 work.** `Workspace`, `PlannedSwimEntry`,
  `HistoricalSwim`, `SuiteWorkspaceProvider` public shape are unchanged.
- **No separate `core ΓåÆ ui` import**. The catalog UI lives in
  `@omniswim/manager`, respecting the existing dependency direction.
