# Improvement plan (2026-10-10)

This plan lists every known improvement for the suite, with enough detail
to start in a new session. It replaces
`docs/reference/IMPROVEMENTS_BACKLOG_2026-10-09.md` as the place to look
for open work. Every open item from that backlog is carried forward here.

Progress lives in `docs/reference/IMPROVEMENT_PLAN_2026-10-10_STATE.json`.
Update the state file, not this plan, as items move.

## How to start a new session on this plan

1. Read the Obsidian vault first: `00-INDEX.md`, then
   `04-Known-Issues-and-Current-State.md` and `08-Open-Decisions-For-You.md`.
2. Read `docs/reference/IMPROVEMENT_PLAN_2026-10-10_STATE.json`. Its
   `resumeOrder` names the next item. Its `userDecisions` list holds the
   answers the user has given.
3. Check the tree: `git status`, `git log --oneline -5`, and the open PRs
   (`gh pr list`).
4. Run the gates before you change anything (see "Gates" below). Record
   the baseline in the state file.
5. Take the next item in `resumeOrder`. Brief agents from the item's
   entry below. Briefs must stand alone: give file paths, the API the agent
   may rely on, the acceptance test, and the scope boundary.
6. After each item, rerun the gates. Update the state file. Commit with
   the repo's commit style (CLAUDE.md). Update the vault.

### Gates

| Gate | Command | Baseline on 2026-10-10 |
|---|---|---|
| Lint, all type checks | `npm run lint` | 0 errors, 2 complexity warnings (`swimCloudMeetImportBridge.ts:207,1010`) |
| Unit tests | `npx vitest run` | 199 files, 3030 passed, 15 skipped |
| Skip budget | `node scripts/check_skip_budget.mjs` | local 15, CI 46 |
| Script suite and e2e | `node scripts/run-tests.mjs` | 85 passed, 1 skipped (PostgreSQL round trip without `PG_TEST_URL`) |
| Extension harness | `npm run test:harness` | 7 passed, 1 fixme |
| CI | GitHub Actions `build-and-test` | green on `84fa6323` (run 38018611118) |

### Rules that bind every item

- Never fabricate, interpolate or estimate competition data. Absent is not
  empty. Unknown division is not D1. Parsers fail loudly. (CLAUDE.md, "Data
  provenance".)
- No agent contacts swimcloud.com. The user runs live crawls and captures.
- Subagents do no git operations. The orchestrator commits.
- Never commit `data/meets.json`, `data/swimcloud-captures/`, the pairing
  token, or the paste-cache captures in `~/.claude/paste-cache/`.
- A diff that changes scoring or lineup output needs a before and after on
  a real workspace, and a test that fails when the fix is reverted.
- Run the root `npm run lint` before every commit. It includes the shell
  type check that a package-only `tsc` misses.
- Port 3000 may hold the user's own server. Do not kill it. Playwright
  reuses a server only when `PLAYWRIGHT_REUSE_SERVER=1`.

### Item format

Each item has an ID, a size (S under an hour, M a few hours, L a day or
more), a flag for whether the user must decide first (**User**), the
evidence, the change, and the acceptance test. "Route" names the agent
from the CLAUDE.md table.

## Priority order

Work top to bottom. Items marked **User** wait until the user answers.
Skip them and take the next one.

| Order | Items | Why first |
|---|---|---|
| 0 | M1 to M3 | Land PR #6 and clean up after it |
| 1 | U1 to U12 | User decisions block other items; ask them in one batch |
| 2 | S1 to S4 | Local security holes on the default no-auth server |
| 3 | C1 to C8 | Wrong numbers a coach could act on |
| 4 | P1 to P7 | Persistence and API correctness |
| 5 | T1 to T12 | Test and CI gaps that hide regressions |
| 6 | X1 to X12 | UX and accessibility |
| 7 | F1 to F10 | New features |
| 8 | R1 to R12 | Refactors and code health |
| 9 | D1 to D10 | Data upkeep and provenance |
| 10 | H1 to H10 | Docs and repo hygiene |

## 0. Merge and branch cleanup

**M1 Merge PR #6.** Done in this session when CI was green (see the
state file). If it is still open, merge with a merge commit (the repo
convention, see PR #5), then pull `main` in the main clone at
`C:\Users\nihar\Documents\GitHub\omniswim-suite`.

**M2 Delete merged remote branches (User).** `origin/cloud/c1-team-names-harness`
is fully contained in PR #6 (0 commits not in it). `origin/fix-scoring-roster-integrity`,
`origin/fix/scoring-roster-integrity`, `origin/feat/roster-management-overhaul`,
`origin/nvitthanala/swimcloud-data-ingest` and
`origin/nvitthanala/production-readiness` are 0 commits ahead of `main`.
`origin/backup/pre-cleanup-2026-06-19` is 3 ahead and 285 behind: keep it
or tag it before deleting. Ask the user once. Then delete with
`git push origin --delete <branch>`.

**M3 Untracked nested data in the main clone.** The main clone has an
untracked `omniswim-suite/data/` directory. Look at it with the user
before deleting anything. Pair with H4 (remove the nested
`omniswim-suite/` directory).

## 1. Decisions only the user can make

Ask these together, with a recommendation each. Record each answer in
the state file's `userDecisions`. The items they unblock are listed.

| ID | Question | Recommendation | Unblocks |
|---|---|---|---|
| U1 | Tied relays get full place points each; tied individual swims split. Split relays too? (`utils.ts` `scoreRelaysInEvent` ~2298-2337; two relays tied 1st get 40+40, not 37+37) | Split, matching NCAA rule and the individual path | C1 |
| U2 | `presetIdForConference` matches by substring ("Sectional" picks a preset through "SEC") (`scoringDefaults.ts:508-518`). Whole words or an explicit map? | Explicit map with whole-word fallback | C2 |
| U3 | Delete the 39 "UI …" test workspaces in the oyster `data/omniswim.db` (backup first) and stop the old port-3000 server (PID 44244, since 2026-10-04)? | Yes, after a backup | B9 closes |
| U4 | Relay programs for conferences other than NSISC: add sourced programs, or keep relays absent? Make the "relays before individual events" order a visible choice? | Add programs only from a published source; show the order | F6 |
| U5 | Place-point tables seed `[0]` and pad with 0 when they grow. Keep, or seed empty and require a value? | Seed empty; a blank cell blocks save | C6 |
| U6 | Restore one-click "All teams" apply? Keep Delete/Backspace as the only lineup remove? | User preference | X10 |
| U7 | Season "Team score trends" sums every team's points in the meet. Which team should it show? | The workspace's own team, with a picker | C3 |
| U8 | Three roster `.txt` files with swimmer names and times are tracked at the root of this public repo. Move to `data/rosters/`, or untrack? | Untrack; keep a local copy | H5 |
| U9 | `src-tauri/` is stale since June: wrong `frontendDist`, no icons, CSP off. Delete or revive? | Delete unless a desktop build is planned | R10 |
| U10 | Save-sequence numbers live in memory; a server restart resets them. Persist them, or rely on version checks (P3)? | Rely on P3 version checks | P3, old A8 |
| U11 | Open account registration with a 6-character password minimum. Make it invite-only when auth is on? | Invite-only, 12-character minimum | S4 |
| U12 | Live work only the user can run: capture the NSISC `/teams/` page; run one multi-team crawl; re-crawl meet 356467; capture a `/times/` page to verify the relay-leg id join | Do them in that order | D2, D3, T4 |

Older open questions still unanswered (vault `08-Open-Decisions`): the
second user of the app (sets how much the UI must explain), the
"Afonso"/"Alfonso" Campanico spelling, whether the desktop-copy launcher is
still real, whether `data/meets.json` should be a curated demo set, whether
anything backs up `data/omniswim.db` (see P6), Git LFS for video, and
whether time trials may fill relay legs.

## 2. Security (local server)

**S1 Host and Origin checks on `/api/*`.** Size M. Route executor.
- Evidence: `apps/shell/server.ts` binds to loopback (`:48`) but accepts any
  `Host` header and never checks `Origin`. With auth off (the default), a
  web page can send simple cross-site POSTs to `127.0.0.1:3000`. A DNS
  rebinding page becomes same-origin and can read responses, including
  the pairing token route (`server.ts:400-415`), whose safety comment
  assumes same-origin means this app.
- Change: middleware before every route. Allow `Host` in
  {`localhost`, `127.0.0.1`, `[::1]`} with the configured port, plus any
  host in an `OMNI_ALLOWED_HOSTS` env list. On non-GET requests, require
  `Origin` to match the allowed hosts, or `Sec-Fetch-Site: same-origin|none`.
  Keep the extension working: its capture POSTs come from a
  `chrome-extension://` origin with the pairing token. Allow that origin
  on the capture routes only.
- Acceptance: a test sends `Host: evil.example` and gets 421 or 403. A POST
  with `Origin: https://evil.example` gets 403. The e2e suite, the
  extension harness and Vite dev HMR still pass.

**S2 Pin Python dependencies.** Size S. Route worker.
- Evidence: `apps/shell/server.ts:207` runs `pip install pdfplumber`
  unpinned at first start. CI does the same. There is no
  `backend/requirements.txt`.
- Change: add `backend/requirements.txt` with an exact `pdfplumber` version
  (read the installed one from `venv`). Install from it in `server.ts` and
  in CI. Fail with a clear message rather than install at runtime when
  `OMNI_NO_AUTO_INSTALL=1`.
- Acceptance: CI installs from the file. A fresh venv starts the server.

**S3 Scope every workspace route.** Size M. Route executor.
- Evidence: `repo.setScope` mutates shared state on one repo object
  (`workspaceRoutes.ts:49-52`). `GET /api/workspaces/backups` (`:218`)
  and `GET /api/share/:token` (`~:341`) never call `applyRepoScope`, so
  in authenticated Postgres mode they run under whatever scope the last
  request set. `restoreBackup` replaces every workspace for every user
  (`workspaceRepo.ts:280-287`).
- Change: pass the scope per call (`repo.list(scope)`), not through a
  setter. Scope the backups route. Refuse a global restore when
  `AUTH_REQUIRED` unless the user is an admin.
- Acceptance: a Postgres test with two users shows that neither can list
  or restore the other's data. Runs in CI (PostgreSQL service exists).

**S4 Auth hardening (User U11).** Size S. Route worker.
- Evidence: `authRoutes.ts:25` allows 6-character passwords. Registration
  is open. A duplicate email returns a distinct 409. There is no rate
  limit on login. The session cookie has no `Secure` flag
  (`authMiddleware.ts:19-23`).
- Change: per the U11 answer. Add a small in-memory login rate limit, a
  generic "could not register" message, and `Secure` when not on loopback.
- Acceptance: route tests for each rule.

Also confirm: no `npm audit` runs in CI. Add `npm audit --omit=dev` as a
report-only step (T11).

## 3. Correctness: numbers a coach acts on

**C1 Split tied relay points (User U1).** Size S. Route executor.
- Evidence: `packages/core/src/lib/utils.ts` `scoreRelaysInEvent`
  (~2298-2337). Individual ties split points through the tie-group path.
- Change: per U1. Reuse the individual tie-split helper.
- Acceptance: a test with two relays tied for 1st gets (40+34)/2 each with
  the NSISC table, not 40 each. Run the score golden tests and record
  every changed total in the commit body.

**C2 Conference preset matching (User U2).** Size S. Route executor.
- Evidence: `packages/core/src/lib/scoringDefaults.ts:508-518` uses
  `u.includes(binding.match)`.
- Change: per U2. Add a test for "Sectional Championships", "SEC
  Championships" and "Southeastern Conference".

**C3 Season team-score trend sums every team (User U7).** Size S. Route
executor.
- Evidence: `packages/core/src/lib/seasonAnalytics.ts:143-156` sums
  `Object.values(officialTeamScores.men)` — all teams in the meet. The
  fallback sums every result row. `AnalyticsPage.tsx` plots it as the
  team's trend.
- Change: take the chosen team's score. When the team is absent from a
  meet, emit no point for it (absent, not 0).
- Acceptance: a test with a three-team meet returns only the chosen team.

**C4 Python bad times sort as 9999.99.** Size M. Route executor.
- Evidence: `backend/point_calculator.py:739-783` `time_to_sec` returns
  9999.99 for empty, NT or unreadable times, which can then score as the
  last place.
- Change: return `None`. Callers skip the row and record a warning.
  Match the TypeScript parser's behavior (`parsingPipeline.ts`
  `ParsedRowError`).
- Acceptance: a pytest (see T2) and a Node script test show that an NT row
  earns no place.

**C5 Silent fallbacks in the parse pipeline.** Size S. Route executor.
- Evidence: `apps/shell/lib/routes/parsingRoutes.ts:68-79` falls back to
  `parseMeetLegacy` for untagged errors with no flag in the response.
  `backend/pdf_parser.py:897` and `:1119` fall back to legacy relay splits
  silently.
- Change: add `pipeline: 'legacy'` and a warning to the response, and
  `relay_split_source: 'legacy'` to the payload. Show the warning in the
  import UI.
- Acceptance: tests force each fallback and check the flag.

**C6 Place-point tables (User U5).** Size S. Route worker.
- Evidence: enabling a relay or diving table seeds `[0]`; growing the
  place count pads with 0. `utils.ts:1285,1308` returns 0 points past the
  end of a table, so a short table reads as "no points".
- Change: per U5. In core, return `null` past the table end and make the
  caller decide.

**C7 Projections read "no actual" as 0.** Size M. Route executor.
- Evidence: `psychProjection.ts:119,216,218`, `prelimsProjection.ts:263,399,418`
  use `?? 0` on actual and cumulative points.
  `eventStrength.ts:129` sorts a missing time as fastest.
  `seasonAnalytics.ts:152,155` counts unreadable points as 0.
- Change: nullable actual values with a visible "no actual" marker. Sort
  missing times last. Skip and count unreadable rows.
- Acceptance: one test for each site.

**C8 Unnamed SwimCloud meet reads as empty.** Size S. Route executor.
- Evidence: `packages/swimcloud/src/parser.ts:1378,4104` set
  `name: meetName ?? ''`, while format, ruleset and course become
  `'unknown'`.
- Change: add a `meet-name-missing` warning, matching the other fields.

Carried from the old backlog:
- **A7** Saved theoretical relay rows hold estimated times in
  `relayLegSplit`. Needs an architect decision: tag the field as an
  estimate, or keep estimates out of stored rows. Route architect, then
  executor.
- **A12** The `/times/` id join for relay credits is not verified on a
  live page. Waits on U12.

## 4. Persistence and API

**P1 Validate workspace writes.** Size M. Route executor.
- Evidence: `packages/core/src/schemas/workspace.ts:63-71`:
  `updateWorkspaceSchema = z.object({}).passthrough()`. A PUT can set `id`,
  `version`, `createdAt`, or a results array of the wrong shape.
  `JsonRepo.update` spreads the patch (`workspaceRepo.ts:249-256`).
- Change: an allowlist schema for the patch. Strip `id`, `version` and
  `createdAt`. Validate array fields as arrays of objects.
- Acceptance: tests that a bad patch gets 400 and an id change is ignored.
  Run the e2e suite: the client must still save every field it sends.

**P2 Refuse a duplicate workspace id.** Size S. Route executor.
- Evidence: `workspaceRoutes.ts:95-105` takes a client id;
  `JsonRepo.create` (`workspaceRepo.ts:245`) appends with no duplicate
  check.
- Acceptance: a second create with the same id gets 409 in all three
  stores.

**P3 Send the workspace version (User U10).** Size M. Route executor.
- Evidence: SQLite and Postgres check `expectedVersion`
  (`WorkspaceService.ts:152`, `workspaceRoutes.ts:121`), but the client
  never sends `version` (`packages/core/src/api/workspaces.ts`,
  `SuiteWorkspaceProvider.tsx`). `JsonRepo` ignores it. Two tabs are
  last-writer-wins. The save sequencer (`adecdba7`) covers one tab only.
- Change: the client sends the version the server last returned. On 409
  `VERSION_CONFLICT`, refetch and show "This workspace changed in another
  tab" with Reload. Add the check to `JsonRepo`.
- Acceptance: an e2e with two pages: the second stale save shows the
  conflict and loses nothing.

**P4 Save failures reach the caller.** Size S. Route worker.
- Evidence: `SuiteWorkspaceProvider.tsx:238` ends `flushUpdate` with
  `.catch(() => undefined)`. `MetricsApp.tsx:134,194` swallow IndexedDB and
  metadata failures.
- Change: return a result or rethrow. Show a toast for the metrics cases.

**P5 One API error shape.** Size S. Route worker.
- Evidence: routes return `{error, details: String(err)}`; `authRoutes.ts:30`
  returns raw `err.message`.
- Change: an `apiError(res, status, code, message)` helper. Send details
  only when `NODE_ENV !== 'production'`.

**P6 Backups that survive.** Size M. Route executor.
- Evidence: one pool of 20 backups (`DEFAULT_BACKUP_KEEP`) holds
  `pre-shrink`, `pre-delete`, `pre-restore`, `startup` and `manual`.
  Heavy editing can push out the only manual backup. Nothing copies
  `data/omniswim.db` off the machine (open user question).
- Change: separate quotas for manual and pre-restore. Add an optional
  `OMNI_BACKUP_DIR` copy (for example a synced folder). Document restore.

**P7 Refuse a newer database schema.** Size S. Route executor.
- Evidence: `packages/db` schema v8 migrates forward with `IF NOT EXISTS`.
  An older build opens a newer database with no warning.
- Change: compare `meta.schema_version` with `SCHEMA_VERSION` at open.
  Refuse when the stored one is greater.

Also: limit `/api/parse-pdf` size and check the `%PDF-` magic after
decoding (`server.ts:284` sets a global 50 MB JSON limit).

## 5. Tests and CI

**T1 Type-check tests and scripts.** Size M. Route finisher, then worker.
- Evidence: no tsconfig covers `tests/` (210 vitest files, Playwright
  specs) or `scripts/` (88 `.mjs`).
- Change: add `tests/tsconfig.json` and wire it into `lint:types`. Fix
  errors file by file. Add typed fixture builders to replace the 109
  `as unknown as` casts in tests.

**T2 Python tests and lint.** Size L. Route executor.
- Evidence: `backend/` has about 3,600 lines with no pytest, ruff or mypy.
  It feeds every PDF meet score.
- Change: `backend/pyproject.toml` with ruff. pytest with small committed
  PDF fixtures (public meet results only). CI runs both.

**T3 Unlisted test scripts.** Size S. Route finisher.
- Evidence: `scripts/test_acc_post.mjs`, `test_post.mjs` and
  `test_conference_pdfs.mjs` are not in `scripts/run-tests.mjs` `TESTS`.
  The first two read PDFs from the working directory that are not in the
  repo, so they are manual probes.
- Change: delete the two probes or move them to `scripts/probes/`. List
  `test_conference_pdfs.mjs` if it can run. Make the runner fail when a
  `scripts/test_*.mjs` is neither listed nor excluded.

**T4 Commit redacted capture fixtures (old B3, needs U12).** Size M.
Route executor.
- Evidence: 46 tests skip in CI. `eventFirstImport.test.ts` skips 14 even
  locally because stored pages drifted. Also `divingEventImport`,
  `meetEventIndex`, `relayLegsHiddenList`, `swimCloudMeetImportBridge`,
  `theoreticalMeetGolden`.
- Change: after the user re-crawls meet 356467, cut minimal pages, strip
  account data (email, uid, CSRF token) as in `cba3e21f`, and commit them
  under `tests/fixtures/swimcloud/`. Lower the CI skip budget.

**T5 Coverage report.** Size S. Route finisher.
- Change: `@vitest/coverage-v8` on `packages/**/src`. Print a summary in
  CI. Report only; set no threshold yet.

**T6 Mutation testing on core scoring.** Size L. Route executor.
- Change: Stryker on `packages/core/src/lib/utils.ts` scoring functions
  and the optimizers, run nightly or by hand. `docs/reference/PHASE_STATE.json`
  holds the earlier mutation work.

**T7 PDF tests in CI.** Size S. Route finisher.
- Evidence: 10 tests skip in CI because poppler's `pdftotext` lacks
  xpdf's `-table` flag.
- Change: install xpdf tools in CI, or commit the extracted text next to
  each source PDF in `data/cutlines/sources/` with its sha256.

**T8 Local-data tests on the demo seed.** Size S. Route finisher.
- Evidence: `optimizerActivePlansAcrossTeams.test.ts:10` and
  `rosterEmptyState.test.ts:83` need local data.
- Change: run them on `data/demo-seed.json`.

**T9 Script runner speed.** Size S. Route finisher.
- Change: run scripts in a pool of 4 in `scripts/run-tests.mjs`, keeping
  the e2e step serial.

**T10 Narrow-width e2e.** Size S. Route worker.
- Change: extend `ui-ia.spec.ts` to 390px for Lineup and Relays.

**T11 Dependency audit in CI.** Size S. Route finisher.
- Change: `npm audit --omit=dev` as a report-only step.

**T12 Lint ratchets.** Size S. Route finisher.
- Change: `--max-warnings 2` on `lint:eslint` so complexity warnings
  cannot grow. Require a reason on every `eslint-disable` (22
  `react-hooks/exhaustive-deps` suppressions, 2 have one). Add
  `@typescript-eslint/no-floating-promises` on `apps/shell/lib/**`. Turn
  `no-explicit-any` to warn in `packages/matrix` and `packages/metrics`.

Carried: **B4** harness redirect test stays `test.fixme`
(`569a40c8`); revisit when Playwright fixes redirect interception.
**B11** the two complexity warnings: see R6.

## 6. UX and accessibility

**X1 Error boundary.** Size S. Route worker.
- Evidence: no `ErrorBoundary` in the shell or packages. A render error
  blanks the app.
- Change: a boundary per route and around each applet with "Reload" and
  "Restore last backup".

**X2 FloatingWindow keyboard support.** Size S. Route worker.
- Evidence: `packages/ui/src/components/FloatingWindow.tsx` has
  `role="dialog"` but no focus move, no Escape and no focus return. Move
  and resize are pointer-only.
- Change: reuse the `Modal.tsx` focus logic. Add arrow-key move and resize.

**X3 Error toasts announce.** Size S. `Toast.tsx:156` uses `role="status"`
for every kind. Use `role="alert"` for errors. Same for the error text in
`LoginPage.tsx` and `SharePage.tsx`.

**X4 NumberField everywhere.** Size S. Route worker.
- Evidence: `packages/matrix/src/components/ScoringOptionalTablesFields.tsx:95,148`
  (`parseInt(...) || 1`) and `:164,212` (`|| undefined`). UI plan phase 1
  fixed the same defect elsewhere.

**X5 Tiny text.** Size S. About 36 `text-[8px|9px|10px]` classes ignore the
text-size setting. Use the `text-ui-*` tokens. Add a ratchet test like the
hex-color one.

**X6 Icon buttons have names.** Size M. 182 `title=` attributes without
`aria-label`. Audit icon-only buttons first.

**X7 Charts do not rely on color.** Size S. `AnalyticsPage.tsx` men and
women lines differ only by hue. Add a legend and a dash pattern.

**X8 Analytics empty state.** Size S. Add guidance and a link to Matrix.

**X9 Mobile pass.** Size M. Manager Lineup and Relays at 390px (with T10).

**X10 Lineup remove and "All teams" apply (User U6).** Size S.

**X11 Motion audit.** Size S. Run the `review-animations` skill on the
UI packages. Never touch `packages/core` or the scoring path.

**X12 Sentence case and copy pass.** Size S. Finish the copy pass on screens
the UI branch did not touch.

## 7. Features

**F1 Printable lineup and relay cards.** Size M. Route worker after a core
API from executor.
- Evidence: no `@media print` and no `window.print` in manager or matrix.
  `reportBuilder.ts` prints season trends only.
- Change: a print view of entries per event, relay cards with leg order
  and seed times, and the projected score. Use `validateEntriesForExport`
  as the gate.

**F2 Meet-day deck view.** Size M. A large-type, read-only, high-contrast
view of the current lineup and relays for a phone on deck.

**F3 Compare any two snapshots.** Size M. `computeScenarioDiff` compares a
snapshot with the current lineup only. Let it take two snapshots, and add
an A/B/C scenario compare.

**F4 Opponent scouting.** Size L. A "Scout team X" view built on the
theoretical-meet seeds (`theoreticalMeetSeeds.ts`) against the coach's
lineup: where we win, where we lose, swing events.

**F5 Season progression chart.** Size M. `buildSeasonTrends` already builds
per-swimmer progressions. Plot them and mark the drop from the first swim
to the best. Show only measured times, no forecast.

**F6 Relay programs beyond NSISC (User U4).** Size M per conference.
Only from a published conference document, archived like the cutline
sources.

**F7 Record removed events in a theoretical meet (old C3).** Size S. The
built workspace does not store which events the preview removed; the
banner only says events may have been removed. Store the list and show it.

**F8 Shareable report without Postgres.** Size M. Share and report routes
return 503 without Postgres auth (`workspaceRoutes.ts:321-325`). Export a
static HTML report and lineup instead.

**F9 Crawled-team import UI polish.** Size M. After the user's first live
multi-team crawl (U12), fix what the run shows.

**F10 Video analysis.** Size L. `docs/video/VIDEO_ANALYSIS_MASTERPLAN.md`
says no implementation started (2026-08-02), but the metrics app has video
upload and tagging. Reconcile the plan with the code before any new work.

## 8. Refactors and code health

Do these only with the gates green before and after, one module at a
time, with re-exports from the old path so callers do not change.

**R1 Split `packages/swimcloud/src/parser.ts`** (6,733 lines) by page kind:
meet, event, roster, swimmer, relay. Size L. Route executor.

**R2 Split `packages/core/src/lib/utils.ts`** (3,709 lines) into names,
time, scoring and relays. Size L. Route executor. Run the score golden
tests before and after.

**R3 One identity module.** Size M. About 20 name and event normalizers
(`utils.ts:295,308,979`, `relayLegMatching.ts:11`, `athleteHistory.ts:449`,
`cutlineEventNames.ts:81`, `eventIdentity.ts:40`). Consolidate them, with a
test that pins agreement. The vault's "branded `CanonicalEvent`" idea is
the long form of this.

**R4 Optimizers off the main thread.** Size M. Route executor.
`RosterOptimizeStep.tsx:393-407` and `optimizeRosterAllTeams`
(`rosterOptimizer.ts:827`) run synchronously. Add an `optimize` op to
`scoringWorker.ts` with progress and cancel.

**R5 Type the chart payloads.** Size M. About 39 of matrix's 42 `any` are
recharts payloads in `TeamCard*.tsx`.

**R6 Complexity warnings (old B11).** Size S. Apply the
`cyclomatic-complexity` skill to `swimCloudMeetImportBridge.ts:207` and
`:1010`.

**R7 Large components.** Size M each. `SwimCloudCaptureBrowser.tsx` (~720
lines in one component), `RosterImportWizard.tsx`, `OpsModule.tsx`,
`multiTeamDriver.ts` `runMultiTeamCrawl` (~560 lines),
`swimcloudCaptureRoutes.ts` `createSwimCloudCaptureRouter` (~370 lines).

**R8 One time formatter.** Size S. `packages/metrics/src/lib/utils.ts:8`
`formatTime` truncates and returns "0.00" for null, unlike core's
`formatSecondsToTime`. Use core's, or document the difference.

**R9 Dependency upgrades.** Size M each, one per PR: Vite 6 to current,
Vitest 3 to current, Express 4 to 5, `eslint-plugin-react-hooks` 5 to
current, Zod 3 to 4. Hoist `typescript` and `react-dom` to the root. Make
`react` and `@tanstack/react-query` peer dependencies of `packages/core`.
Align `@playwright/test` and `playwright-core`.

**R10 Tauri (User U9).** Size S to delete; M to revive.

**R11 Stricter TypeScript.** Size M. Add `noFallthroughCasesInSwitch`
repo-wide. Add `noUncheckedIndexedAccess` to `packages/swimcloud` and
`packages/db` first.

**R12 Alias config in one place.** Size S. Aliases are repeated in
`apps/shell/vite.config.ts`, `vitest.config.ts`, `tsconfig.base.json` and
`apps/shell/tsconfig.json`. Derive them from the tsconfig paths.

## 9. Data upkeep and provenance

**D1 2026-27 Division I standards.** Size S. Route executor.
`data/cutlines/sources/manifest.json` has D1 for 2025-26 only; D2, D3 and
NAIA have 2026-27. When the NCAA publishes the D1 2026-27 standards PDF,
archive it with `{url, sha256, retrievedAt}` and extract it with
`scripts/extract-cutlines.py`. Until then D1 2026-27 stays absent.

**D2 NSISC team list (needs U12).** Parse the user's `/teams/` capture with
`conferencePage.ts`.

**D3 Re-crawl meet 356467 (needs U12).** Restores the regression guard and
stores the Event 8 exhibition flag.

**D4 Team divisions for 2026-27.** Size M. Check every `teamDivisions.ts`
entry for program changes this season (cuts, division moves). Each change
needs a source.

**D5 One abbreviation source.** Size M. `backend/pdf_parser.py:62`
(`ABBREV_TEAMS`) and the TypeScript `TEAM_ABBREVIATIONS` are separate,
held together only by a parity test. Generate one from the other.

**D6 GLVC divided format.** Blocked on the source PDF (`format_type='divided'`).

**D7 Official score mismatch.** The Delta State men −21 residual is still
open (vault 04). It needs the meet results PDF committed.

**D8 Rank collapse on roster-only workspaces.** Verify the fix noted at
`utils.ts:1476,2135` covers the 281-way tie from
`plans/2026-08-14/12-optimizer-destroys-score.md` §2. Close it or reopen
it with a test.

**D9 Time trials and relay legs.** Open user question (g): may a time-trial
swim fill a relay leg?

**D10 Conversion factors.** NCAA SCM factors are sourced; LCM uses CTS and
is labelled an estimate. Recheck when the 2026-27 NCAA PDFs are archived.

## 10. Docs and repo hygiene

**H1 Rewrite `plans/STATE.md` as one page.** The body below the 2026-10-09
header is history from 2026-08-16 ("219 tests", "Start here"). Move that
history to `docs/archive/` and keep a one-page current state.

**H2 Archive finished state files.** About 147 tracked files in `plans/`
and `docs/reference/`. Move finished `*_STATE.json`, `OVERNIGHT_PROGRESS.json`,
`SESSION_*` and dated plans to `docs/archive/2026-09/` and
`docs/archive/2026-10/`. Keep links working.

**H3 README.** `README.md:21` lists "Source → Lineup → Relays → Optimize";
the step is now Athletes. Add the missing commands (`test:unit`,
`test:harness`, `test:parity`, `test:scope`, `migrate:postgres`,
`test:roundtrip:pg`, `build:extension`). Remove the duplicate test section
(`:117`, `:129`). Mention the vitest suite and the skip budget.

**H4 Remove the nested `omniswim-suite/` directory** (one README) and its
ignore entry in `eslint.config.mjs:36`.

**H5 Root roster files (User U8).** `hsuroster26-27.txt`,
`oburoster202627.txt`, `possible_hsu_scoringteam2627.txt`.

**H6 Line endings.** `core.autocrlf=true` and no rule for source files.
Add `* text=auto eol=lf` to `.gitattributes`, then
`git add --renormalize .` in its own commit. Check that
`data/training/checksums.txt` keeps its rule.

**H7 One skill location.** `.agents/skills/` and `.claude/skills/` hold
near-duplicate copies (41 tracked files). Keep one and link the other.

**H8 Onboarding page.** `docs/ONBOARDING.md`: Node, Python venv, Playwright
browsers, `pdftotext`, which tests need `data/meets.json`, how to run the
gates, and the port-3000 rule.

**H9 Stale "fleet" mentions.** Add a "historical" banner to
`plans/2026-09-08/01-decisions.md`, `plans/2026-09-08/07-phasing-and-delegation.md`
and `plans/2026-09-20/README.md`. Fix `.claude/skills/provider-routing/SKILL.md`.

**H10 CLAUDE.md "Known Bugs 2026-07-19" section.** All three are fixed.
Move the section to `docs/archive/` and leave a one-line pointer.

**H11 Stray JSX spaces.** The eight files reformatted on 2026-10-10 keep
the spaces that the line-break stripping put between tags, now written
as `{' '}`. Remove the ones between block elements after a visual check.
Inside a flex container they render nothing.

Also tidy: `docs/reference/golden-after-F1.json` (243 KB) belongs in
`tests/fixtures/` if a test reads it; otherwise archive it.

## Done in this session (2026-10-10)

- Two core files held raw NUL bytes, so grep and git treated them as
  binary: `athleteAliases.ts` (`SCOPE_SEP`) and `rosterOptimizer.ts` (a key
  separator). They now use the `\u0000` escape. The runtime value is the
  same. Both files are stored as LF now.
- Eight files had every line break stripped (one line each). They are
  reformatted with Prettier 3.3.3 (whitespace only; a token
  comparison against HEAD matches, apart from explicit `{' '}` for spaces
  the flattening had already put between JSX tags): `SwimCloudWindow.tsx`, `AuthContext.tsx`,
  `LoginPage.tsx`, `SharePage.tsx`, `core/src/api/auth.ts`,
  `reportBuilder.ts`, `FloatingWindow.tsx`, `SectionHeader.tsx`.
- Mojibake removed from text users see: `AthleteRosterRow.tsx` ("┬╖" in
  the relay count), the report title, the share and login pages, and two
  doc comments.
- The CHANGELOG has entries for PR #6.
- The 2026-10-09 backlog statuses are corrected.
