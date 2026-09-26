# Invariants

True facts about this codebase that are not obvious from reading any single file,
each of which has already cost real debugging time. Each entry explains the
consequence of not knowing it, not just the fact itself.

## 1. `data/meets.json` is local only; the seed is `data/demo-seed.json`

**Changed 2026-09-21. This entry used to say the opposite** — that `meets.json`
was gitignored *but tracked*, and that deleting it from git would strip the seed
data from every new checkout. That was true, and it was the problem: a clone
handed you somebody else's real roster as your starting data. Roughly 170 named
athletes, 1,900 history entries and 500 recruits, in a 3 MB file, in a public
repository.

The two roles are now separate files:

- **`data/meets.json`** — this machine's live working store. Untracked and
  gitignored. Nothing distributes it.
- **`data/demo-seed.json`** — what a fresh install starts from. Committed,
  ~29 KB, and entirely invented: two made-up schools, sixteen made-up swimmers,
  and a workspace named "Demo meet (sample data — not real results)" so nobody
  can mistake a row for a result. Regenerate with
  `node scripts/build-demo-seed.mjs`.

`seedWorkspaces()` in `apps/shell/server.ts` reads the demo file, regenerating
every workspace id per install so two installs never collide, and falls back to
a single blank workspace if the file is missing or unreadable. `SqliteRepo` still
migrates from a local `meets.json` when one exists, so an existing install keeps
its own data and sees no change.

`tests/demoSeed.test.ts` fails if `meets.json` is ever tracked again, if the seed
grows past 200 KB, if its workspace name stops declaring itself a sample, or if
any name or team in it also appears in the live store.

`DATA_DIR` is overridable with `OMNI_DATA_DIR`, which is how the fresh-install
path is exercised without moving real data aside.

## 2. Dev and prod resolve the project root from different depths

The dev entry point is `apps/shell/server.ts`; the production bundle is
`apps/shell/dist/server.js`, one directory level deeper. A fixed `../..` offset
was correct for the former and wrong for the latter, and served a 404 on every
page once deployed. The root is now found by walking up from `__dirname` for a
directory that contains both `package.json` and `packages/` (see
`apps/shell/server.ts`, around the `hasWorkspaces` / `hasManifest` check) rather
than by a hardcoded relative path. If you ever see "works in `npm run dev`,
404s in production," this is the first thing to check.

## 3. Meet result rows carry HyTek labels, not canonical event names

A row's `event` field reads `"Event 22 Men 500 Yard Freestyle"`, not `"500
Freestyle"`. Nearly every cross-referencing bug in this codebase traces back to
forgetting this and comparing a HyTek label directly against a canonical event
name. `canonicalProgramEvent` and `buildMeetEventLabelIndex` in
`packages/core/src/lib/eventIdentity.ts` bridge the two — any new code that
matches events between a loaded meet and roster/scoring data should go through
these rather than string-comparing `event` fields directly.

## 4. Playwright can assert against a stale bundle, not the code you just changed

`npm test` (`scripts/run-tests.mjs`) runs Playwright, whose `webServer` config
(`playwright.config.ts`) is `npm run dev` with `reuseExistingServer: true`
outside CI. If a production server built from an old `dist/` is already bound
to port 3000 when you run `npm test`, Playwright attaches to that stale process
instead of starting a fresh dev server — so e2e can pass (or fail) against code
that predates your change, with no indication that happened. Kill anything on
port 3000, or run `npm run build` first, before trusting a green `npm test`.

## 5. `calculatePoints` lives in `utils.ts`, not `scoringEngine.ts`

The single most important function in the product — the one that turns a swim
result into competition points — is exported from
`packages/core/src/lib/utils.ts`, not from the file named for scoring.
`scoringEngine.ts` imports it. Searching only `scoringEngine.ts` for "where do
points get computed" will not find it.

## 6. The alias resolver is opt-in

`buildAliasResolver(...)` (`packages/core/src/lib/athleteAliases.ts`) must be
passed explicitly to functions that need it — `athleteHistory.ts`,
`historyImportRoster.ts`, and `scoringEngine.ts` all take it as an optional
parameter with an un-resolved fallback. Any function that accepts a resolver
argument but is called without one treats two spellings of the same athlete
("Alan Gonzalez" / "Alan Alejan Gonzalez Mujica") as two different people —
double-counting them in totals and roster limits. This has already caused a
live defect; treat a missing resolver argument as a bug, not an oversight, when
reviewing new call sites.

## 7. `@omniswim/swimcloud`'s package root is not safe for a UI package to import

Importing anything from bare `@omniswim/swimcloud` pulls in `cache.ts`,
`fetcher.ts`, and `playwrightFetcher.ts` too — the package root re-exports
everything — which means `node:fs/promises` and `playwright-core` end up in
the TypeScript compilation graph, and would end up in a bundle, of whatever
imported it. `packages/manager` hit this directly: a bridge module that only
needed two pure types from `@omniswim/swimcloud` failed `tsc` with
`Cannot find module 'node:fs/promises'` the moment it imported from the
package root, because `packages/manager/tsconfig.json` has `"types": []` and
suddenly needed Node's ambient types transitively. The fix was importing
from `@omniswim/swimcloud/parser` (or `/entities`, `/urlClassifier`,
`/clipboardPayload`) instead — all four subpaths are pure, string/regex-only,
no Node, no DOM. Any future UI-facing import of `packages/swimcloud` should
use a specific subpath, never the bare package name; a `tsc` pass alone
won't always catch a UI package doing this wrong (it depends on which
ambient types that package's own `tsconfig.json` happens to include), so a
real `npm run build` of `apps/shell` is the check that actually proves a
Node built-in didn't leak into the browser bundle.

## 8. `isRankableSwim` is the only gate for a best time

A swim SwimCloud extracted from a longer swim's splits (`X`), or one a
swimmer typed in themselves (`U`), is not a result. Neither may ever become a
best time, a cut badge, an entry, or a projection. Before 2026-09-24 each
reader of best times carried its own copy of this rule, and the copies
drifted: `categorizeBestEvents` excluded extracted splits while the import
path, the theory-plan history, the cross-course arbitrage table, and the
history merge did not. One workspace's plan carried 75 extracted and 22
self-reported rows ranked as bests before the fix.

`isRankableSwim` (`packages/core/src/lib/bestTimeEligibility.ts`) is now the
one test. It reads both places the fact can live: the flags the SwimCloud
JSON bridge sets (`isExtractedSplit`, `isUserInputted`) and the
`swimcloudBadge` a pasted row carries, because every workspace stored before
2026-09-24 holds pasted rows with the badge and no flag. Any new reader of
best times must call it rather than re-deriving eligibility from a flag or a
badge directly. Given the swim's `event` and `timeType`, it also refuses an
event its course does not swim (see #16). Guarded by
`tests/extractedSplitNeverBest.test.ts` and
`tests/athleteEntriesPastePreviewGuard.test.ts`.

The same module's `swimEventIdentity` is the one key for "is this the same
event," folding `'50 Free SCY'` (SwimCloud JSON), `'50 Freestyle'` (paste,
CSV, theory) and a HyTek label to one identity — keying a best on the raw
label instead gave one swimmer two bests for one event.

## 9. An altitude-adjusted SwimCloud time is never adjusted again

SwimCloud's `profile_fastest_times` response publishes only the
already-adjusted time for a swim it flags `A` ("Altitude Adjusted") —
confirmed by comparing a captured JSON row (4:07.11) against that same swim's
real meet-results page (4:12.11 swum, adjustment 5.00s, exactly the NCAA
class-II 400m value). The unadjusted time is not available from this
endpoint. Applying the NCAA altitude table to an `isAltitudeAdjusted: true`
swim would subtract the adjustment a second time.

`adjustSwimForAltitude` (`packages/core/src/lib/altitude.ts`) refuses to run
on a swim with `isAltitudeAdjusted: true`. The NCAA altitude table is only
for a source that states the swim's elevation and gives the actual time on
the clock — never for a SwimCloud `A` swim, and never for a swim whose
elevation is unknown (no elevation is ever guessed from a meet name, team,
or city). Guarded by `tests/altitudeAdjustment.test.ts`.

## 10. NCAA short-course-meters conversion truncates and uses the team's own division table

The NCAA's published SCM-to-SCY procedure is explicit: "drop, without
rounding, all units smaller than a hundredth of a second." A converted time
is truncated, never rounded.

There are two published NCAA factor tables, and which one applies depends on
the swimming team's division, never a fixed default: Division I's own
sheet publishes its own factors (`ncaa-d1-2025-26`), and the NCAA Rules Book
Appendix A-2 table (`ncaa-rules-book-a2-2026-27`) is the default for D2, D3,
NAIA, and any team whose division cannot be resolved. Before this fix,
`both_scm` in `CONVERSION_FACTORS` (`packages/core/src/constants.ts`) held
only the D1 factor and was applied to every team regardless of division.
`NCAA_SCM_CONVERSION_TABLES` and `scmConversionTableFor` in the same file now
carry both tables; `convertSwimToSCYDetailed` picks by division and reports
which table it used, so a caller can cite it (see `ProvenanceBadge`'s
conversion tooltip). Guarded by `tests/courseConversionDivision.test.ts` and
`tests/scmAllOtherEventsConversion.test.ts`.

## 11. A cutline table's course must match the swim's own course

`cutlineTableCourseForSwim` (`packages/core/src/lib/cutlineUtils.ts`) decides
which published table a swim is judged against, and a metric swim is judged
against a metric table only when that table exists and applies to that swim
directly (currently: an NAIA short-course-meters swim against the NAIA
sheet, per `NAIA_2026_27_METERS_AS_SCM`). Every other metric swim goes to the
yards table as a `converted_estimate`, never a direct verdict. Feeding a
swim's own course into a table lookup instead of the resolved table course
was a live bug: `AthleteLineupEditorPanel` once fed an LCM swim's course
straight into the table parameter, rendering every LCM history row
"unknown." The stored `computedCut` badge follows the same rule through
`computedCutInOwnCourse`, and its tooltip through `computedCutTooltip`: both
read the table in the swim's own course. Guarded by
`tests/naiaMeterCourseAsScm.test.ts` and `tests/naiaScmComputedCut.test.ts`.

## 12. A robots.txt exemption is an exact path shape, not a pattern

SwimCloud's `robots.txt` forbids `/api/` generally. This app carries a
narrow, named, user-approved exemption for one path shape at a time —
currently only `/api/swimmers/{id}/profile_fastest_times/`
(`SWIMCLOUD_ROBOTS_USER_EXEMPTIONS`,
`packages/swimcloud/src/urlClassifier.ts`). Every other `/api/` path stays
forbidden. A new exemption is a new user decision and a new entry in that
list, never a broadened pattern match on an existing one. Guarded by
`tests/swimcloudUrlClassifier.test.ts` and `tests/swimmerFastestTimes.test.ts`.

## 13. A relay leg matches an individual swim by exact canonical event, never substring

`relayLegMatching.ts` used to test whether one event name contained another,
so `"1000"` matched `"100"` and `"500"` matched `"50"`. On real NSISC data a
departed swimmer's 1000 Free stood in for a 100-yard relay leg, producing
relay times such as -373.17 seconds. Legs are now matched on the canonical
event name (via `normalizeEventForCutline`), so HyTek labels, SwimCloud
labels, and short display labels for the same event all still match, but a
1000 Free can never satisfy a 100-yard leg. `simulateRoster` and the swap
clock-hold logic share one departed-swimmer lookup so the fix cannot drift
between the two call sites. Guarded by `tests/relayLegEventMatching.test.ts`.

## 14. A replace reimport never touches manual or PDF data; the caller backs up first

`importHistoryToRoster(..., { mode: 'replace' })` deletes before it
imports. For one team and gender it removes SwimCloud history (`source`
`'swimcloud'` or `'paste'` — the SwimCloud paste parsers are the only
writers of `'paste'`), recruit rows whose `source` is one of those,
`'swimcloud'` plans, and source-less recruit rows and `'optimizer'` plans
whose athlete, event and time trace to a removed history row (tracing also
recognises SCM times converted before 2026-09-22). It never removes
`'pdf'`, `'manual'`, `'csv'` or `'ocr'` history, `'manual'` or `'pdf'`
plans, or recruit rows with a non-SwimCloud source; a traced row that also
matches kept data stays.

The core does not back up: the caller shows `previewSwimCloudReplace` and
calls `POST /api/workspaces/backup` first. Enforced in
`packages/core/src/lib/swimCloudReplace.ts`; guarded by
`tests/swimCloudReplaceImport.test.ts` and `tests/swimCloudReplaceFlow.test.ts`.

## 15. `console.assert` does not fail a Node script

`console.assert(cond, msg)` logs to stderr on failure and then **returns
normally** — it does not throw, and the process still exits 0. Three test
scripts in this repo were decorative for exactly this reason: they "passed" in
CI while silently failing every assertion. Use `node:assert/strict` in new test
scripts. `scripts/run-tests.mjs` now also greps subprocess output for a tripped
`console.assert` and fails the run if it finds one, as a backstop for scripts
that still use it.

## 16. An event its course does not swim is never converted or ranked

Yards and short-course meters swim different distances for three freestyle
events: the yards 500, 1000 and 1650 against the SCM 400, 800 and 1500. So a
500, 1000 or 1650 Freestyle recorded SCM, or a 400, 800 or 1500 Freestyle
recorded SCY, names an event that course does not swim. User decision
(2026-09-24): "there is no such event, the 1000 is never swum in SCM." Before
2026-09-25 an SCM "1000 Freestyle" took the NCAA "800 meters to 1000 yards"
factor, which the NCAA prints for an 800 m swim, and ranked like a real yards
time.

Such a swim is kept and flagged. It is never converted, ranked, cut-tagged or
entered. `convertToSCY`, `convertSwimToSCY` and `convertSwimToSCYDetailed`
throw `EventNotSwumInCourseError`; `scyConversionOutcome` returns
`status: 'event_not_swum_in_course'`; `isRankableSwim` returns false; the cut
tag state is `event_not_swum_in_course`. A stored recruit row or plan like it
is left out of the what-if projection and named on the lineup checklist.

The pairs live in `COURSE_DISTANCE_PAIRS`
(`packages/core/src/lib/courseEvents.ts`), each cited to archived PDFs: the
NCAA "Short-Course Conversion Factors" rows (`ncaa-d2-men-2026-27` and
`ncaa-d2-women-2026-27` page 2, `ncaa-d1-2025-26` page 3), and the NAIA
"500/400 FREESTYLE" and "1650/1500 FREESTYLE" labels (`naia-2026-27`, and
`naia-2020-21-course-evidence`, which heads the column "SCM"). Two cases are
never flagged. A swim whose course nobody recorded (no `timeType`, a label
that states no course, or "meters" with no pool length) is not flagged: the
SCY default is an assumption, not a record. An LCM swim is not flagged: no
archived source lists the long-course events. Add a pair or a course only
with an archived source that states it. Guarded by
`tests/courseEventMismatch.test.ts`.

## 17. Every entry suggestion ranks events with `rankEventsByStrength`

A swimmer's events are ranked strongest first by three rules, each one
breaking the ties of the one before it (user decision, 2026-09-24):

1. With a meet loaded, the place the time would take in that meet's
   results for the event and gender. The swimmer's own rows are left out.
2. The distance to the team's division cut (`swim / cut`, one tier for the
   whole profile). With no meet loaded this is the first rule.
3. Raw seconds, only as the last resort.

Raw seconds alone measure event length: a 50 beats a 1650 for every swimmer.
Before 2026-09-25 the catalog scoring path still ranked that way, and on the
HSU roster it entered a distance swimmer in the 50 Free, 50 Fly and 100 Free,
and entered swimmers in 25s and 50s of stroke that no championship contests.

`rankEventsByStrength` (`packages/core/src/lib/eventStrength.ts`) is the one
ranking. `categorizeBestEvents`, `getAthleteProfile`,
`buildEventProfileFromCatalog`, the import's entry budget and
`buildCategorizedScoringInputs` all use it. The place is the scoring
engine's own placement of an injected row (`buildMeetPlaceField` in
`utils.ts`, built on `recruitComparators` and `placeFieldByTime`), read
from the frozen source results. No place is invented for an event the meet
did not contest, and no cut for an event the division does not publish:
each event records which rule placed it (`EventStrength.basis`).

`utils.ts` sits below the cut lookup, so `buildCategorizedScoringInputs`
takes the order as its `eventOrder` argument. Without it the order is raw
seconds, so every caller must pass `catalogEventOrderByStrength(...)`.
Guarded by `tests/eventStrengthRanking.test.ts` (including a scan that fails
on any caller without `eventOrder`) and `scripts/test_event_quality_ranking.mjs`.

## 18. A relay's distance is read from its own distance token, never guessed

`parseRelayDistanceYardsOrNull` (`packages/core/src/lib/relaySplits.ts`)
reads the number directly before `Freestyle Relay` / `Medley Relay` in the
canonical event name, after `normalizeEventForCutline` has stripped the
HyTek entry number and gender word and folded `4x50` to `200`. A total that
does not divide by four is not a relay distance. A label that names none
returns `null`; `parseRelayDistanceYards` throws
`RelayDistanceUnreadableError` for it.

The parser this replaced took the first 3-4 digit number, so
`Event 102 Women 200 Yard Medley Relay` was a 102-yard relay, and it returned
200 when it found no number, so an unreadable label silently took 50-yard
legs. A `null` distance matches no swim (`isRelayLegEvent`): no candidate,
no departed swim, no fill. The lineup audit names the label
(`relay_distance_unreadable`). Never add a fallback distance.

Individual events follow the same rule: `individualEventDistanceStroke`
(`relayLegMatching.ts`) reads the event's own distance token, never the
entry number. Guarded by `tests/relayFollowUpsR1.test.ts`.

## 19. Who may fill a relay leg

A swim fills a leg only when all of these hold (R1, plans/2026-09-24):

1. It is the leg's exact event (invariant 13).
2. The swimmer is of the relay's gender (`isRelayCandidateOfGender`). A
   Mixed-event row records the gender of the results it was filed under,
   not the swimmer's, so it counts only for the one gender the swimmer's
   other rows record. None recorded: it fills no leg.
3. The swimmer holds no other leg of the same relay. `simulateRoster`
   collects every leg holder who stays before it resolves any override.
4. A history swim reaches a leg only through `relayLegHistoryCandidates`
   (`relayLegHistoryCandidates.ts`): a swimmer the pool already holds,
   `isRankableSwim`, a recorded course, the leg's exact event, and never
   where the pool holds a meet or recruit swim at that event. The row is
   marked `relayLegHistory` and is never an individual entry.
   `simulateRoster` takes such rows only as `relayLegOnlyPool`.

The departed swimmer's swim comes from the relay's own team
(`findDepartedLegSwim`'s `team`). Guarded by
`tests/relayFollowUpsR1.test.ts`.
