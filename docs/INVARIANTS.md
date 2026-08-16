# Invariants

True facts about this codebase that are not obvious from reading any single file,
each of which has already cost real debugging time. Each entry explains the
consequence of not knowing it, not just the fact itself.

## 1. `data/meets.json` is gitignored but tracked

`data/meets.json` appears in `.gitignore` (so routine edits from a running app
don't show up as diffs to commit) but the file itself is already tracked in git —
`git ls-files` includes it. `SqliteRepo.init()` in `apps/shell/lib/workspaceRepo.ts`
reads this exact file to seed `data/omniswim.db` the first time a fresh clone
runs with `OMNI_DB=sqlite` (the default) and finds zero workspaces in the
database; `JsonRepo` uses it directly as the JSON-mode store. Deleting it from
git to "clean up the gitignore" would silently remove all demo/seed data from
every new checkout — a fresh clone would boot to a single empty "Blank
Workspace 1" instead of the real seeded roster, with no error to say why.

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

## 7. `console.assert` does not fail a Node script

`console.assert(cond, msg)` logs to stderr on failure and then **returns
normally** — it does not throw, and the process still exits 0. Three test
scripts in this repo were decorative for exactly this reason: they "passed" in
CI while silently failing every assertion. Use `node:assert/strict` in new test
scripts. `scripts/run-tests.mjs` now also greps subprocess output for a tripped
`console.assert` and fails the run if it finds one, as a backstop for scripts
that still use it.
