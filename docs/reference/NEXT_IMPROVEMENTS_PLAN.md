# Next improvements plan (2026-10-03)

Follows the UI simplification branch (`nvitthanala/ui-simplification`, 7 local commits, not pushed). Two tracks: A (follow-ups that need no SwimCloud contact, built now) and B (multi-team crawl, see `SWIMCLOUD_MULTI_TEAM_CRAWL_PLAN.md`).

## Decisions from the user (2026-10-03)
- Plan, then build the non-SwimCloud items now. Implement the crawl's offline parts (parsers on archived pages, request planning, tests). The user runs any live crawl. No agent contacts SwimCloud.
- Relay legs: use the public leadoff and relay time, plus any credited relay-leg time that appears in a swimmer's own meet history. No paywall bypass.
- Missing relay legs in a projection: derive from flat-start individual bests, labelled as an estimate, never mixed with real legs.
- Crawl driven by pasted team links plus a season pick.

## Track A: follow-ups (small, ordered by risk)

| # | Item | Why | Gate |
| --- | --- | --- | --- |
| A1 | Fix the `WorkspaceRouteSync` swap loop (`apps/shell/src/App.tsx:34`) | Cold `?workspace=<id>` loads swap ids about 30 times a second; specs work around it | New test: a cold load settles on the URL's workspace and stays |
| A2 | Lock fixes: pass the PDF-points lock into the diver-weight field (Auto + PDF points); lock eligibility when the draft picks Auto | Engine ignores the value; the dialog lets the user edit it | Field disabled with a reason; test fails on old code |
| A3 | Undo safety: warn or refuse when the lineup changed since the run | One-shot Undo overwrites later edits | Test: edit after run, Undo refuses with a message |
| A4 | `SuggestedPresetBanner` `.catch`, drawer Remove hint and key handler, fixed amber colours in five files | Review leftovers | Tests; hex/amber ratchet |
| A5 | Per-theme screenshot test for Lineup and Standings | Catches layout regressions | Playwright, three themes, two widths |
| A6 | Stale test workspaces and cold-start backups | Tests leave `ui-*` workspaces; cause of the three `meets-startup-*` backups unknown | Specs clean up after themselves; decision from the user before touching the real db |

Executor for A1-A3 (logic), worker for A4-A5. One agent at a time. Review by a different agent than the author.

## Track B: multi-team crawl and theoretical-meet projections
See `SWIMCLOUD_MULTI_TEAM_CRAWL_PLAN.md`. Phases B0 to B5. B0 needs the user to capture three fixtures first.

## Docs and vault
Each phase updates `docs/reference/*STATE.json`, the plan record, and a note under the vault's `Sessions/`. Final pass updates `04-Known-Issues-and-Current-State.md`.

## Status (2026-10-04)

- A1 to A6: done and verified. A6 removed three stale `ui-*` workspaces and 18 duplicate startup backups; `playwright.config.ts` and the production-server spec now run on temp copies of the data.
- Track B: B1 (seeds, links, planner, queue), the multi-team driver and panel, and B4 part 1 (theoretical meet builder, workspace builder) are built and architect-reviewed. The crawl has run live once on teams 412, 58 and 48.
- Open: the theoretical meet screen (U2), relays from individual bests, the conference page parser (needs a capture), relay-leg credits (need two captures). See `THEORETICAL_MEET_PLAN.md` and `THEORETICAL_MEET_STATE.json`.
