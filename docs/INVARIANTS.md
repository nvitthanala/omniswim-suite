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
badge directly. Guarded by `tests/extractedSplitNeverBest.test.ts` and
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
"unknown." Guarded by `tests/naiaMeterCourseAsScm.test.ts`.

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
