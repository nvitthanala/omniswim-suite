# WORKLOG 08 — team-roster parser, crawl-plan extension, and the live hang fix

**2026-09-09, two `executor` agents, disjoint scope, in parallel.** Both were
killed mid-flight by a 5-hour quota reset immediately after finishing their
real work — verified independently afterward: 538/538 tests, lint clean
across all 8 workspaces, both the shell and extension builds succeed. This
file is the report neither agent got to write.

## 1. `parseTeamRosterHtml` + `planMeetTeamRosters` (`packages/swimcloud/`)

Built against the two real roster captures from this session
(`tests/fixtures/swimcloud-real-team-roster-58-gender-{m,f}.html`, 35 men +
16 women — resolves OQ-3). `real-capture-verified` confidence.

**Deliberately excluded from the parser's output, each stated as a decision
rather than a gap:**
- The power-index number and its link — a computed rating, not a roster
  fact, with no stated use.
- The row's rank number — a sort-order artifact (`?sort=name` vs `?sort=perf`),
  not a swimmer property.
- A `season_id` — the real id-to-label table is visible in both captures,
  but nothing proves the numbering is stable or site-wide, so no id is ever
  stored, computed, or reversed out of a label. Fetching omits `season_id`
  entirely and lets the server serve its own current season, matching what
  both real captures already do by default.

`planMeetTeamRosters(input): readonly SwimCloudCrawlStep[]` extends the
meet-crawl plan with one `/team/{teamId}/roster/?gender={M|F}` step per
discovered team, both genders, ordered to match `planMeetTeamSwims` (team by
team, men then women) so a resumed crawl reproduces the same sequence. No
`page` parameter either — neither real capture shows pagination, and
guessing a page range would fetch URLs nothing has proven exist; left as an
explicit open question rather than guessed.

## 2. The live crawl hang — root cause and fix (`extensions/swimcloud-companion/`)

**Root cause, confirmed from the code, not guessed:** a Manifest V3
background message listener returns `true`, promising the sender an
asynchronous response. If that listener's handler then rejects before
`sendResponse` is called on the rejection path, the sender's callback is
simply never invoked — `chrome.runtime.lastError` is not set, nothing
rejects, nothing times out. The `await` in the content script's crawl loop
waits for the life of the tab. This is exactly what happened right after
team-list confirmation, when the crawl's new resume-check and
corrected-page-count messages (from the prior fix round) started firing.

**Fix:** `extensions/swimcloud-companion/src/backgroundRoundTrip.ts` (new) —
`sendWithTimeout(send, timeoutMs, timers)` wraps every background round trip
so it *always* settles: `{kind: 'ok', value}`, `{kind: 'timeout', timeoutMs}`,
or `{kind: 'error', message}`, never a promise that hangs forever. Distinct
timeouts by how much work a message carries: `BACKGROUND_ROUND_TRIP_TIMEOUT_MS`
(10s, bookkeeping messages), `RELAY_ROUND_TRIP_TIMEOUT_MS` (30s, a full page
of HTML plus a localhost POST), `PAGE_FETCH_TIMEOUT_MS` (30s, via
`createFetchDeadline`'s `AbortSignal`). `classifyRelayFailureStreak` stops
the crawl after `RELAY_FAILURE_STOP_THRESHOLD` (3) consecutive relay
failures with a retryable verdict, rather than silently dropping pages
forever. `roundTripFailureText` turns any of these into the one sentence the
progress panel shows, including a pairing-token hint on a timeout (the most
likely real cause: an unpaired or not-running app).

**Test discipline, stated in the test file's own header:** the first test
passes a `send` that never settles — exactly the broken worker's behavior —
and asserts the call still resolves. Fake, controllable timers (no real
clock) make a "10 second timeout" test free. What's still NOT covered, by
the same honest boundary every prior worklog in this initiative states: the
real `chrome.runtime` glue itself — whether a real Manifest V3 service
worker's listener actually calls `sendResponse` on every path in practice
stays a manual-verification line, not an automated assertion, since no
`chrome.*` shim exists in this repo.

## Verified (independently re-run after both agents were cut off)

- `npx vitest run`: **538 passed, 0 failed**, 30 files.
- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npx tsc --noEmit -p extensions/swimcloud-companion/tsconfig.json`: clean.
- `node extensions/swimcloud-companion/build.mjs`: `crawler.js` 102.7kb,
  `background.js` 12.5kb, both built.
- `npm run build -w @omniswim/shell`: succeeds, `server.js` 361.1kb.

No git operations. Both pieces of work are complete and ready; only their
own final-report step was interrupted.
