# C1 report: school names on the Teams step, and the extension harness

Branch: `cloud/c1-team-names-harness` (from `e331b8d7`, `nvitthanala/ui-simplification`).
Cost (priced by `scripts/claude-cost-report.mjs`, this session only): about $4.65, all Sonnet 5.5.
The final figure is in the last section.

## Task A: school names, tagged correctly

- New crawls: `multiTeamDriver.ts` remembers the school name each roster page prints. It reads it
  with `parseTeamRosterHtml` (the data layer's parser). It sends the name as the capture `label` when it
  marks a capture. It sends a name only if every roster page of that team prints the same one.
  The existing `POST /api/swimcloud/captures` route already took `label`. No route change.
- Bug found by the harness: `multiTeamPanel.ts` dropped the third argument when it wired
  `markCapture`. The label never reached the worker. Fixed, with a unit test.
- Old captures: `GET /api/swimcloud/captures` now adds `teamName` to each team capture
  (`apps/shell/lib/swimcloudCaptureTeamName.ts`). It reads the stored roster pages and makes no network
  request. It caches the name in `label` once, and never for a crawl in progress. Roster pages that
  disagree give `teamNameWarning` and no name.
- Dialog: the Teams step shows the school name, or `Team N` with no claim, plus a division tag from
  `resolveTeamDivision` (the lookup the seed builder uses). `unknown division` for any school not in the
  table, a discontinued program, or no name. Never D1. Names that disagree show a warning.
- Division lookup results:
  - Henderson State University: NCAA D2 (canonical `Henderson State University`)
  - Ouachita Baptist University: NCAA D2 (canonical `Ouachita Baptist University`)
  - Delta State University: NCAA D2 (canonical `Delta State University`)
  - University of West Florida (team 10002824 in the harness): NCAA D2
- Tests: `tests/theoreticalMeetTeamNames.test.ts` (14 tests), a label test in
  `tests/swimCloudExtensionMultiTeamApp.test.ts`, and `tests/e2e/theoretical-meet.spec.ts` (mocked list
  has a labelled capture, two server-named captures and one with no name; 6 of 6 pass).
- Mutation proof (3 real mutations, each killed, each restored with an identical sha256):
  driver `size === 1` to `!== undefined` (1 test failed), `decideTeamName` `=== 1` to `>= 1`
  (1 failed), `teamDivisionTag` unknown fallback to D1 (2 failed).

## Task B: the harness

`npm run test:harness` (`scripts/run-harness.mjs`, `tests/harness/`). Skips with a message when Chromium
or the build is missing. Not part of `npm test`. Real 3 s pacing, about 2.5 minutes in all.

| Scenario | Result |
| --- | --- |
| Happy path (pinned 12-request order, gaps, captures, label, Build theoretical meet) | pass |
| 403 on a swimmer | pass |
| 429 once then OK | pass |
| 200 "Just a moment..." on a team page | pass |
| 200 "Just a moment..." where swimmer JSON belongs | pass |
| Redirect to another team | `test.fixme`: `route.fulfill` with a 302 is not followed by Chromium for the extension's fetch. The 302 is logged, the target is never requested, the extension reports a network error. |
| Lock across two tabs | pass |
| Cancel mid-run | pass |

Notes: the fake rewrites each swimmer row's `swimmer_id` to the id asked for, because the parser skips
rows that name another swimmer. Times are untouched. Rosters are cut to two swimmer rows per page.
The 10002824 men's page is the real "No rosters found" page, so that team's name comes from its women's page.
Pacing gaps measured at the route handler were 3000 to 3010 ms. The assertion allows 150 ms of jitter.
Dev dependencies added: none.

## Gates

- `npm run lint`: 0 errors, 2 known complexity warnings.
- `npm run lint:extension`: clean.
- `npx vitest run`: 2574 passed, 38 skipped, 1 failed test plus 1 failed file. Both failures read the
  git-ignored `data/swimcloud-captures/pages` folder, which is absent in this checkout (ENOENT):
  `tests/swimCloudMeetImportBridge.test.ts` (event 8 exhibition) and `tests/relayLegsHiddenList.test.ts`.
  They do not touch this work. The brief expected these to skip; here they error.
- `PORT=3601 npx playwright test tests/e2e/theoretical-meet.spec.ts`: 6 passed.
- `npm run test:harness`: 7 passed, 1 skipped (fixme).

## Vault notes

- A team capture can carry a school name two ways: the extension sends it as `label` on mark, and
  `GET /api/swimcloud/captures` adds `teamName` read from stored roster pages. The Teams step prefers either.
- Roster page team name comes from the page `<title>` (`Roster - {school}`) or the first `<h1>`.
  The harness fixtures print it in the `<h1>`.
- The division tag uses `resolveTeamDivision` through `teamDivisionTag` in `theoreticalMeetView.ts`.
  Unknown is never D1.
- `multiTeamPanel.ts` wires `markCapture` to the app. A new argument must be passed there too.
- Harness: `npm run test:harness`. The redirect scenario cannot be driven through `route.fulfill`.
  Gaps are measured at the route handler, so they read 3000 to 3010 ms.
- Known env gap: two vitest files fail when `data/swimcloud-captures/pages` is absent.
