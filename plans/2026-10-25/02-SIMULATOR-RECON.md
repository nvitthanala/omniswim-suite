# Phase P0: SwimCloud meet simulator recon

Status: **ready to run.** The Claude in Chrome tools (`mcp__claude-in-chrome__*`)
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

_None yet._
