# Multi-team SwimCloud crawl and theoretical-meet plan (2026-10-03)

Goal: paste several SwimCloud team links, pick a season per team, pull each roster and every swimmer's history (with relay-leg credits), then import the set to project a theoretical meet.

## Ground rules
- No agent contacts SwimCloud. Code is built and tested on archived pages in `data/swimcloud-captures/`. The user runs live crawls in their own browser session.
- The existing denylist (`/api/`, `/jsonapi/`, `/team/*/facilities/`, `/tz_detect/`) stays. The 3-second pacing, Cloudflare stop-on-403 and the bounded pool (3 lanes, 400 ms stagger) stay. Concurrency across teams shares the one pool; it does not add lanes.
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
- Resume-dedup per `(team, season, swimmer)`; per-team progress and error lines; Cancel and Pause as today. Pure logic in `src/` with unit tests (no chrome mocks); the impure loop stays on the manual checklist.

## Phase B4: import and theoretical meet (app)
- Import the capture set as one workspace roster per team and season, keeping history per swimmer.
- Meet builder: choose teams and the entry rules; projections use each swimmer's best time in the chosen year range.
- Relay projection: real legs when present. Where legs are missing, an optional, labelled estimate from flat-start individual bests (flat-start best minus a stated start adjustment), shown in a distinct style and never written as a leg time. The adjustment is a setting, not a constant. The estimate is a user decision (recorded 2026-10-03), but the provenance rule applies: label it, store it apart.

## Phase B5: proof
- Fixture tests on the real captures, mutation checks, one end-to-end dry run on archived data with no network, a manual checklist for the live crawl, vault and state updates.

## Risks
- Terms of use and access posture are in `plans/2026-09-06/01-legal-and-access-strategy.md`. Multi-team crawling raises request volume; the pool and pacing must not loosen. The user accepts the risk for their own session; I do not add stealth, account switching or paywall bypass.
- If F-B shows relay credits only for subscribers, B2 is dropped and relays fall back to leadoff plus the labelled estimate.
