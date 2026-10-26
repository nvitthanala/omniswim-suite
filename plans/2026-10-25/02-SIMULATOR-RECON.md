# Phase P0: SwimCloud meet simulator recon

Status: **done 2026-10-25** (two items open: S2 extent, Q16 widths; see Findings). The Claude in Chrome tools (`mcp__claude-in-chrome__*`)
appeared in a Claude Code session on 2026-10-25. If they are missing at the
start of a session, use `01-REDESIGN-PLAN.md` section 12; it has the fallback
chain. P0 is the first step of the next session. The user authorized
live research through Claude in Chrome on 2026-10-25 ("run your own research,
i trust it"). Decision U12 of the 2026-10-10 plan covers the posture: the
user's own Chrome and sign-in, a separate tab, human pace, captures never
committed raw.

Start URL from the user: `https://www.swimcloud.com/meetsimulator/?event=1|50|Y|1&teams=`

## Posture

- One tab, opened by Claude, closed at the end.
- Human pace: one action at a time. No loops, no bulk navigation.
- Read what the page loads. Do not send requests the page would not send,
  except S2 below, and only once.
- Stop on a Cloudflare challenge or any 403. Do not retry.
- Save raw HTML and network bodies to the session scratchpad only. Commit
  sanitized fixtures: keep the structure, replace swimmer names with
  `Test Swimmer A`, and so on.

## Questions to answer

### Access
1. Does the simulator need sign-in? A paid plan? Which plan does the user have?
2. What does the page show signed out?

### URL and state
3. What does each part of `event=1|50|Y|1` mean (stroke, distance, course,
   gender?), and how are `teams=` listed?
4. Which settings live in the URL, and which only in page state?

### Data
5. Do swims arrive as JSON from an XHR or fetch call, or as server-rendered
   HTML? Record every request URL, method, query parameters and the response
   shape.
6. Where is the 3-year window set? A request parameter, a server rule, or the
   UI only?
7. **S2 (one request only):** does the data request accept a window wider than
   3 years? Try it once, by changing the date control if the UI allows it,
   else by editing the one parameter once.
8. Does the page receive converted times (SCM or LCM to SCY), and how are they
   marked?
9. Does the page receive relay splits, or only relay times?
10. Does the page receive cut standards or cut flags?

### Controls
11. List every control: teams, date window, course, scoring preset, scorers
    per event (number buttons), entry limits tab (individual per-swimmer
    limit, max 5; per-team, with "–" for unlimited; relay per-swimmer and
    per-team), diving, swimmer include or exclude.
12. Are the controls plain form elements, a framework (React, Vue, Alpine,
    jQuery), or server round trips? This decides how S1 injects controls.

### Scoring
13. Does scoring run in the browser or on the server? If the browser, find the
    function or bundle.
14. Record SwimCloud's team scores and per-event results for three
    configurations. These become the parity fixtures for P2:
    - A dual meet, two teams, SCY only.
    - A conference meet with the NSISC teams, default settings.
    - The same conference meet with a non-default entry limit and scorer count.

### NSISC scoring and schedule (R15, R16)
17. Read SwimCloud's NSISC scoring table: individual points per place,
    relay points per place, number of places. Compare with the code's NSISC
    preset (`packages/core/src/lib/scoringDefaults.ts`). Record any
    difference; P3 fixes it with a test. Also record: how many relays per
    team score in a relay event (the code's `maxRelaysScoringPerTeam: 2` has
    no source, D2 finding F8), diving points per place, and the A-final size.
    Archive the capture under `data/` with a manifest entry before any value
    becomes `published` (D2 section 3.2). Also record how SwimCloud marks a
    non-scorer in a meet's results (exhibition flag, no place, or a place with
    0 points). R41 removes non-scorers from the places (D2 finding F18).
18. Does the simulator have any notion of event order, days or sessions? If
    not, where on the page does a "Meet schedule" panel fit (R16)?

### Page security and delivery (from the D3 spec)
19. Record the `Content-Security-Policy` response header on
    `/meetsimulator/`. It decides whether the docked dashboard iframe can load
    (`D3-STORAGE-AND-BUILD.md` section 3).
20. Does `swimcloud.com` (no `www`) redirect to `www`? It decides the
    manifest `matches` patterns.
21. Does the page load its data inside a page worker or a service worker?
    If so, page-thread hooks see nothing.

### Look
15. Record the CSS class names of tables, dropdowns, buttons and tabs, the
    font stack, and the main colors (light only, unless SwimCloud has dark).
16. Note the page width and layout at 1280 px and at 390 px.

## Output

Write findings into the "Findings" section below, one line per question,
with evidence (request URL, selector, or screenshot name). Patch the state
file's P0 entry when done.

## Findings

Recon ran 2026-10-25 (evening, US Central) in the user's Chrome through
Claude in Chrome, signed out of SwimCloud. Route: normal start (section 12),
no fallback needed. Evidence names:

- **Bundle**: `https://www.swimcloud.com/media/webpack/simulator/index.1792676876.js`
  (760,912 B; React + Redux). Archived, untracked, in
  `data/swimcloud-captures/simulator/` with `manifest.json`, together with
  the CSS bundle, response headers, signed-out HTML, a constants excerpt
  and `rescore.cjs` (re-scores the committed fixtures).
  Offsets below (`@N`) are character offsets into that file.
- **Store**: the page's Redux store, reached from the page through
  `document.getElementById('simulator')` → `__reactContainer$…` fiber →
  the `Provider`'s `memoizedProps.store`.
- Swimmer names and ids in captures are replaced before anything is
  committed.

### Access

1. **No sign-in needed.** Signed out, the simulator loads teams, swims,
   scores and every settings panel. The header shows LOGIN / REGISTER.
   `loginwall.js` loads, but it gated nothing touched in this session. The
   user's Free plan (R30) therefore sees at least the signed-out page.
2. Signed out, the page shows the full simulator: Teams table with scores,
   event dropdown with ranked entries, Bench, and the settings column
   (Events, Roster, Date Range, Time, Scoring, Entry Limits).

### URL and state

3. **`event=stroke|distance|course|legs`.** Stroke: 1 free, 2 back,
   3 breast, 4 fly, 5 IM, 6 free relay, 7 medley relay, `H` diving.
   Course: `Y`, `S`, `L`. Legs: 1 individual, 4 relay. Diving has no course:
   `H|1|1` 1 m, `H|3|1` 3 m, `H|2|1` platform. Gender is not in the event
   id. `teams=` is a comma-separated, sorted list of SwimCloud team ids
   (Henderson State = 58). The page caps the list at 20 teams (bundle
   `n.slice(0,20)`). Evidence: bundle constants `Pp`/`Tp`/`Rp` @498653.
4. **Only `teams` and `event` live in the URL** (`gh()` writes them with
   `history.replaceState`). Everything else is Redux state, reset on load:
   gender, date mode and range, time to use, course, event list, point
   system, scorers per team, all entry limits, relay source, free-relay
   order, swimmer removals (`meetChanges`, `inactiveSwimmers`).

### Data

5. **JSON over XHR (axios), one GET per team:**
   `GET /api/teams/{teamId}/simulator/?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&eventgender=M|F&eventcourse=Y|S|L&divecourse=6&time_to_use=fastest|average`.
   Response `{swimmers: [...], relays: [...]}`. A swimmer holds
   `id, name, display_name, first_name, last_name, gender, gradcollege,
   gradhs, …, indrecords[], relaysplits[], relayleadoffs[]`. Every swim row
   (individual, split, leadoff, relay) has exactly
   `id, eventstroke, eventdistance, eventcourse, eventgender, numlegs,
   eventtime (string seconds, "108.13"), flystart (bool), pointvalue
   (string, SwimCloud power points)`. **No swim date and no meet id.** A
   relay row has the same fields and no legs. Henderson State men, season
   2026-27 (2026-10-25): 42 swimmers, 166 individual rows, 54 relay splits,
   26 leadoffs, 5 relays, 63,605 B. Other requests: `GET
   /api/seasonchoices/?count=10&from_next=false` (10 seasons, 2017-18 to
   2026-27, each `{seasonId, label, startDate, endDate, isCurrent}`), `GET
   /api/teams/search/?q=&page=` and `?ids=` (team objects with `id, name,
   abbr, teamcode, orgcode, lsc, …`; Henderson State `orgcode: 3`).
   The client caches each team response by its parameter set
   (`mh[...]`); changing a scoring or limit setting re-scores with no
   request. Settings that change the request: teams, gender, date, time to
   use, course.
6. **The 3-year window is a client-side date-picker limit only.** "Specific
   Dates" mode sets `minDate = subYears(today, 3)` on both pickers (bundle
   `lb(ub,"minDate",um(Na(),3))` @690875; `um` = subtract years). "Season"
   mode offers one season at a time from the 10 `seasonchoices` (back to
   2017-18), and sends that season's `startDate`/`endDate`
   (`YYYY-09-01`..`YYYY+1-08-31`). The request takes plain `start_date` and
   `end_date`; no window parameter exists.
   **The roster is always the current one.** Season 2021-22 for Henderson
   State (one UI click, request 7, 24,100 B) returned the same 42 swimmers
   (`gradcollege` 2026-2030) with only their swims inside that window. The
   endpoint picks swimmers by current roster and filters swims by date.
   It does not return the 2021-22 roster.
7. **S2 read rule, written before the request.** The response has no swim
   date, so a 200 alone proves nothing. The S2 request asks for
   2019-09-01 → 2026-10-25 for team 58 only. Honored = at least one
   (swimmer, event) best equals a 2021-22 best to the hundredth and is
   strictly faster than that swimmer's 2026-27 best and is absent from a
   3-year window by date logic (2021-22 ends before 2023-10-25). Clamped =
   no such row. Rejected = non-200.
   **Mechanics, as run:** Specific Dates mode; one store dispatch
   `{type:'@SETTER/startDate', payload:'2019-09-01'}` (request count
   unchanged, 7 → 7); then To = Oct 25, 2026 through the UI picker. Exactly
   one data request followed (plus one Cloudflare `cdn-cgi` ping).
   **Result: accepted (200), 98,356 B, 42 swimmers, 285 individual rows**
   (2026-27 alone: 166). The server did not reject a 7-year span.
   **Honored vs clamped is not settled.** The read rule failed: season
   2021-22 and season 2022-23 (UI clicks, requests 7 and 10) both returned
   zero swims for this roster, so no pre-2023-10-25 row exists to compare.
   Two readings fit: (a) the server clamps every request to today − 3
   years, which would also empty 2022-23; (b) no current swimmer swam for
   team 58 before fall 2023. A swimmer profile check (does a `gradcollege`
   2026 swimmer have Henderson State swims in 2022-23?) separates them; see
   the end of this section.
8. **No converted times.** The client has no conversion code (bundle has no
   course-conversion logic). An `eventcourse=Y` request returns only `Y`
   rows; season 2025-26 with `Y` returned 202 individual rows, all `Y`,
   all hundredths. The same season with `L` (LCM button, request 12)
   returned 42 swimmers and **zero rows**, though several of them swim LCM
   in summer. So swims appear to be **scoped to the team**: only swims
   recorded for this team, in the requested course, in the date window. No
   row carries a converted flag, because none is converted.
9. **Relay splits: yes. Relay legs: no.** Each swimmer carries
   `relaysplits` (`flystart: true`) and `relayleadoffs` (`flystart: false`,
   also used as individual times by `getIndividuals`). A relay row is a
   time with no legs. With "Relays: Aggregate" (the default) the client
   builds relays itself from the fastest available split per leg (`kf`
   @~526000; medley order back, breast, fly, free; free relays reorder by
   "traditional" `[2,4,3,1]` or fastest-to-slowest). "Relays: Actual" uses
   the relay rows.
10. **No cut standards or cut flags** reach the page. The bundle has no cut,
    standard or qualifying logic.

### Controls

11. **Every control, from the settings column** (selectors use
    `button`/`label` text; class names are CSS-module hashes and change per
    build):
    - **Teams**: async multi-select (react-select), max 20, search
      `/api/teams/search/`.
    - **Men / Women** tabs (store `gender`, default `M`).
    - **Meet type** select: 16 Event Order, 13 Event Order, 3 Day
      Championship, High School. Picking a type applies a whole preset
      (`Up`): events, point system, scorers, entry limits. Teams that share
      one `orgcode` auto-apply the first preset of `Bp[orgcode]`; orgcode 3
      (college) → 16 Event Order.
    - **Events**: SCY / SCM / LCM buttons; event-list select (16-Event
      College, 13-Event College, Three-Day Championship, Four-Day
      Championship with 1000 Freestyle, High School, Custom); one toggle per
      event (26 events incl. 1 m, 3 m, platform diving). The list order is
      the meet's event order.
    - **Roster**: name search box plus one include checkbox per swimmer, per
      team.
    - **Date Range**: Season (radio per season, 10 seasons) or Specific
      Dates (From / To pickers, min today − 3 years, max today).
    - **Time**: Individual Fastest / Average; Relays Actual / Aggregate.
    - **Scoring**: point system radio (College, High School 4/6/8 lane,
      Sectional and State Final, 16 Place Scoring, 24 Place Scoring) and
      "Max per team" radio 1–6. The store accepts 0 (no cap), but the UI
      offers no "no cap" option.
    - **Entry Limits**: Individual per athlete `--`,1–5; Individual per team
      `--`,1–5; Relay per athlete `--`,1–5; Relay per team 1–5 (**no
      `--`**); Total per athlete `--`,1–5. `--` stores 0 = unlimited.
    - **Per-entry edits** in the event table: remove (×), edit a time,
      add from the Bench, replace a relay leg (`meetChanges` actions
      `SET_ENTRY_TIME`, `SET_LEG_TIME`, `REMOVE_ENTRY`, `ADD_INDRECORD`,
      `ADD_ACTUAL_RELAY`, `ADD_AGGREGATE_RELAY`, `REPLACE_LEG`).
    - No diving-specific setting beyond the event toggles; the request
      always sends `divecourse=6`.
12. **React 18.3.1 + Redux (react-redux), axios.** Not plain form elements.
    jQuery 3.7.1 and Bootstrap load for the site shell, not the simulator.
    For S1 this means: read and drive state through the store (found from
    the page in 2 fiber steps), not by editing DOM inputs. A
    `dispatch({type:'@SETTER/<key>', payload})` sets any setting; setters
    that refetch go through the page's own `vh()` (debounced 1 s), so a
    bare dispatch does not refetch. A content script needs the MAIN world
    to reach the store.

### Scoring

13. **Scoring runs in the browser.** Function `gf` (@~523969). Rules, read
    from the code:
    - Per event, entries sort by `Ra`: non-diving first, timecode, then
      non-exhibition first, then has-time first, then time ascending
      (diving: score descending).
    - Points = `IND_EVENTS[index]` or `REL_EVENTS[index]` by **the entry's
      index in the full sorted list**. A team's entry beyond
      `maxScorersPerTeam` earns 0 **but keeps its index**; the next entry
      does not move up. This is the **opposite of R41** (NSISC: a
      non-scorer leaves the places and scorers move up). P2 parity must copy
      SwimCloud's rule; P3 NSISC must not. They need separate code paths.
    - **No tie splitting.** Tied times get consecutive indexes and
      different points.
    - The same per-team cap applies to relays in relay events.
    - `maxScorersPerTeam` is **per event**. It is not the code's
      `maxIndividualScorersPerTeam: 18`, which is a meet-wide scoring-team
      size. Do not map one to the other.
    - Diving scores with `IND_EVENTS`. Diving rows come with two course
      codes, `"6"` and `""`; the page keeps each diver's **highest score
      across both** (sort descending, then one row per diver and event).
      Fixture A: T48-S03 3 m has `"6"` 292.20 and `""` 451.28; the result
      uses 451.28.
    - `getIndividuals` mixes relay leadoffs into a swimmer's individual
      times and drops rows with no `pointvalue`.
    - Bug: the 3 Day Championship preset lists a `scoring32` alternative
      that `_p` does not define; selecting it would score every swim 0.
      The Scoring panel does not offer it.
    - Point tables (`_p` @~497693): College IND 9-4-3-2-1, REL 11-4-2 (dual
      meet); HS 4-lane 4-3-1 / 6-3-1; HS 6-lane 6-4-3-2-1 / 8-4-2; HS
      8-lane 8-6-5-4-3-2-1 / 10-5-3; Sectional and State Final 12 places
      16-13-12-11-10-9-7-5-4-3-2-1 / relay ×2; 16 Place
      20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1 / relay ×2; 24 Place
      32-28-27-26-25-24-23-22-20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1 /
      relay ×2.
    - The event table shows an over-cap entry's score as "-".
    - Presets (`Up`): 16 and 13 Event Order = College points, 3 per team,
      ind 3/athlete 3/team, relay 2/athlete 2/team, total unlimited.
      3 Day Championship = 16 Place, 4 per team, ind 3/athlete 4/team, relay
      4/athlete 1/team. High School = HS 6-lane, 3 per team, ind
      2/athlete 3/team, relay 3/athlete 2/team, total 4.

14. **Parity fixtures: recorded, plus one extra.** Files in
    `tests/fixtures/swimcloud/simulator/` (README there). Men, SCY, season
    2025-26 (a finished season, so the data will not drift), teams 58, 48,
    412 (the 2026 NSISC men's field, from the repo's meet 356467 capture).
    - A: dual 58 v 48, defaults. 58: 186, 48: 102.
    - B: 58 + 48 + 412, defaults (the orgcode-3 shortcut applies 16 Event
      Order, so this scores with dual-meet points 9-4-3-2-1, cap 3). 58:
      138, 412: 92, 48: 70.
    - C: B + 16 Place Scoring, 4 scorers per team, individual 4 per team.
      58: 849, 412: 777, 48: 575. No request was sent: scoring and entry
      limits re-run in the browser.
    - D (extra): C with 2 scorers per team, to exercise the cap rule. 58:
      544, 412: 544, 48: 483 (a tie on points; the page still ranks 58
      first).
    An offline re-score with the rule in Q13 reproduced every entry's
    points and every total in A–D. Real ties appear in B–D (100 breast
    56.77 / 56.77; 100 free 45.37 / 45.37) and score with different points,
    which confirms "no tie splitting". Not verified: which tied entry the
    page sorts first (it follows input order through a stable sort).
    The fixtures record the entries the page chose, not how it chose them.
    Plan section 3.3 lists the SimSnapshot as "teams, swimmers, swims,
    settings, SwimCloud's own scores"; it does not name entries.
    **Recommendation for P2:** add the page's chosen entries
    (`simulatedMeet.splashes`, with relay legs) to the SimSnapshot. Then
    parity needs only the scoring rule. Without them, parity also needs a
    copy of SwimCloud's auto-entry logic, which this recon did not decode.

### NSISC scoring and schedule

17. **SwimCloud has no NSISC preset.** R15 holds in this form: SwimCloud
    has a 16-place table ("16 Place Scoring", key `scoring16`) that matches
    the code's NSISC preset. `scoring16` IND equals `SCORING_POINTS`
    (`packages/core/src/constants.ts:317`) exactly, and REL is exactly 2×
    IND, which matches `relayMultiplier: 2`. No difference to fix in P3 on
    points. Diving uses the individual table. SwimCloud has **no A-final
    size and no relays-per-team scoring rule**: the per-team scorer cap
    (`maxScorersPerTeam`) covers relays too, and "Relay per team" is an
    entry limit (1–5). So `maxRelaysScoringPerTeam: 2` still has no
    SwimCloud source; R25 (the user) is its source. Non-scorers: the
    simulator's data has no exhibition rows in practice (`exhibition` is
    absent from the simulator payload); a capped entry shows place kept,
    0 points. **Meet results mark a non-scorer as exhibition with no
    place**, read from the repo's capture of the 2026 NSISC 100 Breast Men
    finals (`tests/fixtures/swimcloud-real-meet-event-356467-event26.html`,
    note 4 inside it): the rank cell holds `<span class="c-label
    c-label--neutral c-label--outline u-cursor-help" title="Exhibition">X</span>`
    instead of a number. Scorers are ranked without them (A final 1–8,
    B final 9–15, C final all `X`; prelims 1–15 then five `X` rows). That
    matches R41 (non-scorers leave the places). Results pages also share a
    rank on a tie (prelims `… 6 7 7 9 …`), unlike the simulator. Archive:
    the point tables are in a SwimCloud JS bundle, not a published rule
    document, so they cannot be `published` provenance; they are a parity
    reference only. The bundle, CSS, headers and HTML are archived,
    untracked, in `data/swimcloud-captures/simulator/` with
    `manifest.json` (`url`, `sha256`, `retrievedAt`). NSISC values stay
    sourced from the NSISC documents (R32) and the user's answers.
18. **Event order: yes. Days and sessions: no.** The event list is ordered
    (`eventIds`, preset orders such as "Three-Day Championship"), and the
    event dropdown follows that order. Nothing models days or sessions. A
    "Meet schedule" panel fits as a new item in the settings column (same
    pattern as Events / Date Range: a row that opens a sub-panel), below
    Entry Limits.

### Page security and delivery

19. **No `Content-Security-Policy` and no `X-Frame-Options`** on
    `/meetsimulator/` (curl from this machine, 2026-10-26 03:17 UTC; no
    `<meta http-equiv>` CSP in the HTML). Headers present: HSTS,
    `x-content-type-options: nosniff`, `referrer-policy: same-origin`,
    `cross-origin-opener-policy: same-origin-allow-popups`. A docked
    extension iframe is not blocked by the page. (Curl headers can differ
    from what Chrome receives behind Cloudflare; recheck in the P1
    harness.)
20. **`https://swimcloud.com/meetsimulator/` → 301 →
    `https://www.swimcloud.com/meetsimulator/`.** Manifest `matches` needs
    only `https://www.swimcloud.com/*`.
21. **No service worker** (`navigator.serviceWorker.controller` null) and
    no data worker: the page-thread XHR hook caught every data request.
    Page-thread hooks work.

### Look

15. **Light theme only**, Material-style. The page stays light even though
    this machine prefers dark (`prefers-color-scheme: dark` was true).
    - Font: `Roboto, "Helvetica Neue", Helvetica, Arial, sans-serif`
      (Google Fonts Roboto 400/500/700); body 14 px, weight 400.
    - Colors: body background `#FAFAFA` (rgb 250,250,250); cards white;
      text `rgba(0,0,0,0.87)`; table header text `rgba(0,0,0,0.54)` weight
      500; row borders `#E0E0E0`; primary and links `#1565C0`
      (rgb 21,101,192); select border `#BDBDBD`.
    - Cards: `.c-card`, radius 8 px, Material elevation-2 shadow.
    - Titles: `h1.c-title.c-title--small` 18 px / 500.
    - Tables: `table.c-table-clean.c-table-clean--middle.table.table-hover`,
      cells `.c-table-clean__rank`, `__score`, `__actions`, `__img`,
      wrapper `.c-table-clean--responsive`.
    - Selects: `select.form-control` (radius 2 px). Buttons: Bootstrap
      `.btn .btn-primary` (radius 4 px, 13 px / 500), icon buttons
      `.btn.btn-icon.btn-icon-plain`. Tabs (Men / Women):
      `li.c-tabs__item.active > .c-tabs__link`, active color `#1565C0`.
    - Simulator-specific classes are CSS-module hashes (for example
      `AuLEFmlFIPOf3H3NdwgT`); they change per build. Select by role and
      text, or through the store, not by these.
    - The old Omniswim crawler extension is installed in this Chrome. It
      adds two floating buttons ("Multi team crawl (Omniswim)", "Copy for
      Omniswim") at the bottom right. They are not SwimCloud's. They
      appear in every screenshot. Nobody clicked them.
16. **Layout.** `#simulator.container` is 1120 px wide at a 1920 px
    window, left nav shown. Bootstrap 3 grid: `col-md-9` (teams, event
    table, bench) and `col-md-3` (settings column). Below the `md`
    breakpoint (992 px) the columns stack and a floating
    `.btn-fab.u-is-hidden@md.js-drawer-open` button opens the site drawer.
    **Not measured:** the 1280 px and 390 px views. `resize_window` reported
    success but the window stayed 1920 px wide (it is maximized), so no
    screenshot exists at those widths. Recheck in the P1 harness with a set
    viewport.

### S1 and S2 summary

- **S1: yes.** A MAIN-world script reads everything without new requests:
  the store holds `rosters`, `origRosters` (parsed team data),
  `simulatedMeet.splashes` (entries with `points`), `totalScores` and every
  setting. The raw responses can also be taken by wrapping
  `XMLHttpRequest` before the page's first team request.
- **S2: accepted, extent unsettled.** One request for 2019-09-01 →
  2026-10-25 returned 200 with more rows than one season. Whether the
  server clamps to 3 years is still open (Q7). The planned check (does
  Henderson State swimmer T58-S04, `gradhs` 2022 and `gradcollege` 2026,
  have Henderson State swims in 2022-23?) hit a **Cloudflare "Just a
  moment…" challenge** on the public swimmer profile page. The recon
  stopped there, as the posture requires, and closed its tab. To settle
  it, the user can open that swimmer's profile once by hand. If it shows
  2022-23 swims for Henderson State, the server clamps (the season
  request for 2022-23 returned nothing). If it shows none, S2 needs a
  team with older swims. Local data does not settle it: the repo's
  capture of that swimmer's fastest times (retrieved 2026-10-04) shows
  one 2022-23 best, swum 2023-02-11 for team 10009480, not Henderson
  State. That fits team-scoped swims (Q8) and says nothing about a clamp.

### Posture record

- One tab, opened by Claude and closed at the end. Human pace; no loops.
- SwimCloud requests sent by the page during the session: about 20 team
  data requests, all from normal UI actions (team picks, season radios,
  course button), plus the one S2 request. One swimmer profile navigation
  hit the Cloudflare challenge. No 403.
- **Deviations, recorded once each:** from this machine's shell (not the
  browser), `curl` fetched the simulator page once (headers for Q19), the
  `swimcloud.com` redirect once (Q20), and the simulator JS and CSS
  bundles once each (static assets, read offline). One store `dispatch`
  set the S2 start date. Raw responses stayed in the page and in the
  session scratchpad; only sanitized files were written to the repo.
