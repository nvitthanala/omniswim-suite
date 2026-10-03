# Multi-team SwimCloud crawl and theoretical-meet plan (2026-10-03)

Goal: paste several SwimCloud team links, pick a season per team, pull each roster and every swimmer's history (with relay-leg credits), then import the set to project a theoretical meet.

## Ground rules
- No agent contacts SwimCloud. Code is built and tested on archived pages in `data/swimcloud-captures/`. The user runs live crawls in their own browser session.
- The existing denylist (`/api/`, `/jsonapi/`, `/team/*/facilities/`, `/tz_detect/`) stays. The pacing, Cloudflare stop-on-403 and the bounded pool stay as coded: `SWIMMER_TIMES_CONCURRENCY` is 1 with a 3000 ms stagger (lowered 2026-09-22 after 111 of 184 requests drew HTTP 429). Never read these numbers from this doc; read the constants. Concurrency across teams shares the one pool; it does not add lanes.
- Provenance (CLAUDE.md): absent is not zero; no estimate is stored as a real time; a leg is credited only from a page that states it.
- Nothing is hardcoded to a conference or division.

## What already exists
- Extension `extensions/swimcloud-companion` crawls one meet (Track A') and relays pages to the local app. `swimmerTimes.ts` and `timesEndpointDiscovery.ts` fetch a swimmer's times. `crawlPlan.ts` plans roster and season-best fetches for a scope (`roster-and-season-bests`, `everything`).
- `crawlPlan.ts` never emits `season_id` today (no derivation formula exists). Captured pages show the current season pre-selected.
- `relayLeadoff` is read from `title="Leadoff"` chips. Relay legs on event pages sit in a hidden "Show names" table (parser warns `relay-legs-absent` when missing).
- A swimmer's `/times/` page is a shell; times load through an endpoint, so relay rows in a history are not in the archived HTML.

## Open facts to verify (cannot be assumed)
1. **Season ids.** How the season picker maps year to `season_id`, per team. Verify from the team page's own season select (options carry the ids). No derivation.
2. **Relay-leg credits in a swimmer's history.** The user states non-leadoff legs appear as credited times. The archived data holds no such row. Need a fixture to learn: the row markup, whether the leg has a flag (like Leadoff), the event label (`100 Y Free` vs relay name), and whether the relay's meet and place are present.
3. **Whether the times endpoint is season-filterable** (`data-season-ids` appears on the times shell).

## Phase B0: capture fixtures (user, own browser, Track A copy button)
- F-A: a team page with the season select open (one team, 2+ seasons).
- F-B: one swimmer's times response (endpoint JSON or HTML) for a swimmer who swam a non-leadoff relay leg, season known.
- F-C: a relay event page with "Show names" expanded (legs and any leg times).
Save under `data/swimcloud-captures/`; record in the capture state file. The agent reads them locally.

## Phase B1: season-aware planning (offline)
- `crawlPlan.ts`: accept `{teamId, seasonId?}` and emit `season_id` only when the user picked it from a fixture-verified list. Unknown season stays absent, never guessed.
- Parse the season select into `{label, seasonId}` options (`parseTeamSeasonOptions`), with a fixture test.

## Phase B2: relay-leg parser (offline)
- Parse relay credits from F-B into `SwimCloudRelayLegCredit { swimmerId, relayEvent, legIndex?, time, isLeadoff, meetId, swimKey }`; absent fields stay absent.
- Join to the relay event page (F-C) on SwimCloud's own swim/relay id, never on name plus time.
- Convert to `HistoricalSwim` with a `relayLeg` kind so the optimizer and projections can tell leadoff, non-leadoff and individual swims apart. Core scoring logic stays unchanged; this is data plumbing. Executor, with architect review of the type.

## Phase B3: multi-team orchestration (extension)
- Options page: textarea of team URLs, per-team season chips from B1, scope, Start. Queue teams; the shared pool runs rosters and swimmer histories across teams.
- Resume-dedup per swimmer id (the times fetch has no team or season in it; see the 2026-10-03 review update); per-team progress and error lines; Cancel and Pause as today. Pure logic in `src/` with unit tests (no chrome mocks); the impure loop stays on the manual checklist.

## Phase B4: import and theoretical meet (app)
- Import the capture set as one workspace roster per team and season, keeping history per swimmer.
- Meet builder: choose teams and the entry rules; projections use each swimmer's best time in the chosen year range.
- Relay projection: real legs when present. Where legs are missing, an optional, labelled estimate from flat-start individual bests (flat-start best minus a stated start adjustment), shown in a distinct style and never written as a leg time. The adjustment is a setting, not a constant. The estimate is a user decision (recorded 2026-10-03), but the provenance rule applies: label it, store it apart.

## Phase B5: proof
- Fixture tests on the real captures, mutation checks, one end-to-end dry run on archived data with no network, a manual checklist for the live crawl, vault and state updates.

## Risks
- Terms of use and access posture are in `plans/2026-09-06/01-legal-and-access-strategy.md`. Multi-team crawling raises request volume; the pool and pacing must not loosen. The user accepts the risk for their own session; I do not add stealth, account switching or paywall bypass.
- If F-B shows relay credits only for subscribers, B2 is dropped and relays fall back to leadoff plus the labelled estimate.

## Update 2026-10-03 (evening): findings and decisions

- **Live access.** The user supplied teams 58, 412 and 48 and the NSISC conference page, and asked
  for the example to be run. The embedded Orca browser got the Cloudflare "Just a moment..."
  page for `/team/58/` and did not clear in 18 seconds. No challenge was solved or worked around.
  Live pages come from the user's own browser through the extension's copy button (Track A).
- **F-A already exists.** The archived roster page for team 412 holds the season select with real
  ids (30 = 2026-2027, 29 = 2025-2026 selected, 28 = 2024-2025 ...). B1 is built on it. Season ids
  are read from each team's own page and never reused across teams or derived.
- **Still needed from the user:** F-B (a swimmer's times with a non-leadoff relay leg), F-C (a
  relay event page with "Show names" expanded) and F-D (the NSISC conference page, for the
  conference-to-teams list). No parser is written for F-B, F-C or F-D until a real capture exists.
- **A6 done.** Three stale `ui-*` workspaces removed from the real database after a backup
  (`data/backups/omniswim.db.pre-a6-cleanup.20261003.bak`). 18 duplicate startup backups removed.
  Cause: each server start writes one, and e2e ran on the real data folder. `playwright.config.ts`
  now uses a temp copy.

## Update 2026-10-03 (night): architect review fixes to B1

An architect review of the offline B1 code found seven defects. All are fixed and each has a test
that failed before the fix and a mutation that makes it fail again.

- **One fetch per swimmer.** The queue key is `swimmer|<id>`, not `(team, season, swimmer)`. The
  endpoint is `/api/swimmers/{id}/profile_fastest_times/`, so one swimmer on two teams or in two
  seasons is one request, and a team crawled again for another season does not refetch its
  returning swimmers. Every (team, season) pair stays on the work item as `attributions`, so
  progress and error lines are still per team. Old-shape resume keys match nothing and are refetched.
  **Data caveat:** the endpoint returns all-time bests. For a past-season roster they include swims
  from later seasons. Downstream code must not read them as that season's times. This also answers
  open fact 3 for now: nothing here filters by season.
- **Concurrency.** `createQueue` throws `concurrency-too-high` above `SWIMMER_TIMES_CONCURRENCY`.
  A roster page runs alone: it never starts while other work is in flight, and nothing starts while
  a roster is in flight.
- **Halt and resume.** `resumeQueue` works whether or not the driver called `retryFailed` first.
  Every halting failure is kept, not only the first, and Resume returns each still-failed one to pending.
- **Season-form parser.** `value` no longer matches `data-value`; `name` no longer matches
  `data-name`; HTML comments are ignored.
- **Targets.** A conference is the lower-cased slug plus the country. `NSISC` and `nsisc` are one
  target. The same slug in another country is another target. The slug is stored lower-case.
- **Driver rules, recorded in the `multiTeamQueue.ts` header, with helpers** (the driver is not
  written): store the queue `nextWork` returns before any `await`; call `verifyRosterSeason(html, work)`
  before `addSwimmers` and `markFailed` on a mismatch; halt on a 403, any 5xx, a network error and
  `CONSECUTIVE_429_HALT` (3) consecutive 429 give-ups (`shouldHalt`).
