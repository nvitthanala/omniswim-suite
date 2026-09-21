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

## 8. `console.assert` does not fail a Node script

`console.assert(cond, msg)` logs to stderr on failure and then **returns
normally** — it does not throw, and the process still exits 0. Three test
scripts in this repo were decorative for exactly this reason: they "passed" in
CI while silently failing every assertion. Use `node:assert/strict` in new test
scripts. `scripts/run-tests.mjs` now also greps subprocess output for a tripped
`console.assert` and fails the run if it finds one, as a backstop for scripts
that still use it.
