# Theoretical meet from crawled teams (plan, 2026-10-04)

Goal: project a meet from teams already crawled with the extension, with no meet PDF. The user has
three crawled teams (412, 58, 48 for 2026-2027). The Matrix demands a loaded meet today because its
standings come from `menResults` and `womenResults` (meet rows). Psych rows are only an overlay.

## Decisions (user, 2026-10-04)
- Seed time: all-time best per event, SCY only (see `SWIMCLOUD_MULTI_TEAM_CRAWL_PLAN.md`, B4).
- Entries follow the scoring caps (conference overrides merged).
- Destination: a NEW workspace each time. Nothing existing is overwritten.
- Relays: built from individual bests, labelled as estimates, never stored as real leg times.

## How it enters the app
The theoretical meet is a workspace whose meet results are the seeded entries ranked by seed time.
That unlocks Standings, Analyze, Team cards and the Manager's what-if tools, with no change to the
scoring engine. `loadedMeet` carries a "Theoretical meet" label so every gate that checks for a
loaded meet opens.

## Phases
- **U1 data layer** (pure, tested): captures to `TheoreticalMeetInput`; seeds to a workspace payload.
- **U1c relays** (after a design check): relay rows from individual bests, labelled estimated.
- **U2 UI**: "Build theoretical meet" dialog (pick crawled teams, scoring, preview, caveats), entry
  points in the Matrix Meet step and the workspace list, sensible empty states.
- **U3 proof**: end-to-end on the three real captured teams; manual checklist; vault and state.

## Caveats the UI must show
- Seeds are all-time bests and can overstate a swimmer who has since slowed.
- Relays are estimates (once built); until then, "relays not included".
- Exhibition swims can still become seeds (known issue, needs a core type field).
- Only SCY meets. Diving is not included.
