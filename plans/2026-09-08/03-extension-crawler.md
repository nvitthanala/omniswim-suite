# Extension architecture for the crawl

## Component split, and why crawl correctness is not in the extension

The crawl planner is a **pure function in `packages/swimcloud/src/crawlPlan.ts`**,
not extension code. Given a subject and the parse results so far, it returns
the exact ordered list of URLs to fetch next. It touches no network, no
clock, no DOM. It is unit-testable in Node with the existing fixtures.

The extension only *executes* a plan it is handed. This is what makes the
extension work legitimately `worker`-shaped (see
[07-phasing-and-delegation.md](07-phasing-and-delegation.md)) instead of
correctness-critical, and it is what makes "does the crawl ever emit a
denylisted URL?" a plain unit test rather than a live-traffic question.

## Request sequencing

**Meet subject:**

1. Fetch `/results/{meetId}/topteams/?gender=M` and `?gender=F` — the
   primary team-discovery mechanism, **fully buildable as of the
   2026-09-08 OQ-1b resolution** (see [01-decisions.md](01-decisions.md)).
   Parse with `parseMeetTopTeamsHtml`
   ([04-parsers-and-fixtures.md](04-parsers-and-fixtures.md)),
   `real-capture-verified`. Take every team row regardless of score — a
   "–" score is a real team that scored zero, not an absent one.
2. **Fallback**, used only if step 1 fails outright (404/malformed): fetch
   `/results/{meetId}/?gender=M` and `?gender=F`, run `parseMeetTeamsHtml`
   on both, and union the team ids. Defense-in-depth, no longer
   load-bearing for the common case. Either path ends with the same next
   step: show the discovered teams as a checklist, and wait for the user
   to confirm or amend it before any bulk fetching starts.
3. For each team × each gender: fetch
   `/results/{meetId}/team/{teamId}/swims/?gender=G` (page 1).
4. Read `pagination.totalPages` from `parseTeamMeetSwimsHtml`'s output. It
   is present on page 1 and lists every page number — confirmed verbatim in
   the real page-1 fixture (`<ul class="c-pagination">` with items 1–8). So
   the full page count is known after one fetch per team-gender, and the
   total remaining work is known and displayable before the bulk of it
   runs.
5. Fetch pages 2..N with `?page=N&gender=G`.
6. Absent pagination widget means one page. The fixture header states this
   explicitly and warns it must not be treated as a parse error.

Ordering is: both meet roots, then team-by-team, and within a team, men
then women, page 1 upward. Deterministic, so a resumed crawl produces the
same order and a diff of two crawls is meaningful.

**Team subject:** designed in [04-parsers-and-fixtures.md](04-parsers-and-fixtures.md).
Not implemented this round — gated on real captures.

## Pacing and politeness

One `SwimCloudPoliteFetcher` instance per crawl, `minDelayMs: 3000`,
unchanged from its default. Do not lower it for the extension. Its cache
read-through is backed by the extension's `chrome.storage.local` store
during the crawl, and every fetched page is also posted to the on-disk
store, so a resumed crawl skips what it already has.

**Volume, stated plainly, because a coach has to be told before clicking:**

| Scenario | Pages | At 3 s |
| --- | --- | --- |
| Meet 356467 (4 teams, HSU 8 pages/gender) | ~66 | ~3.5 min |
| A 20-team championship at the same depth | ~322 | ~16 min |
| Team subject (design; ~12 meets, ~60 roster profiles) | ~300 | ~15–25 min |

These numbers go in the confirm dialog, computed from the real page counts
after step 4, not as a static estimate.

## Error handling

| Condition | Behavior |
| --- | --- |
| **403 / Cloudflare challenge** | **Stop the entire crawl immediately.** No retry, no backoff loop. Message: "SwimCloud returned a challenge. Open the page in a tab, pass it, then Resume." Retrying a challenge in a loop is precisely the bulk-scraper behavior `01-legal-and-access-strategy.md` §4 draws the line at. |
| 404 | Record `outcome: 'http-error'`, continue. A school with no women's program legitimately has no women's list. |
| 5xx | Stop the crawl. One manual Retry, never automatic. |
| Network error | Stop the crawl. Resume is available. |
| Denylisted URL | Cannot happen — `SwimCloudPoliteFetcher` throws `SwimCloudForbiddenUrlError` before any request. If it does happen, that is a planner bug and the crawl aborts loudly. |
| Malformed / unexpected markup | **Does not stop the crawl.** The extension never parses for content; it stores bytes. Only the two structural reads the plan needs (team links, pagination) run in-extension, and either failing marks that one page's plan branch `'partial'` and continues. A SwimCloud redesign therefore costs zero captured bytes. |

## Where the crawl loop actually runs — corrected 2026-09-08

The first draft of this section said the background service worker owns
crawl state in `chrome.storage.local`, "so a service-worker restart does not
lose the crawl." That was solving a problem this design does not have, and
worse, was solving it with a mechanism (`chrome.storage.local` +
presumably `chrome.alarms` for MV3-safe pacing) that adds real complexity a
closer look shows is unnecessary.

**The crawl fetches pages; it never navigates the tab.** Every URL the
planner emits (`/results/{meetId}/team/{teamId}/swims/?gender=&page=`,
`/results/{meetId}/topteams/?gender=`, the meet root) is same-origin to the
page the content script is already injected into. `fetch()` from a content
script against its own page's origin needs no `host_permissions`, carries
the page's cookies automatically (it's the same session), and — because the
tab's own URL never changes — **the content script that's running the loop
never gets torn down and re-injected.** There is no persistence problem to
solve, because there is no restart to survive. This also settles what the
original plan flagged as an open question (OQ-5, "do fetches carry the
session"): they trivially do, because they're not a separate mechanism at
all — same page, same `fetch()` a "View source" click would use.

Concretely:

- **Content script** (the existing injection point, `content.js` + the new
  bundle from D1) owns the crawl loop for its full duration: sequencing,
  the 3-second pacing wait (`await sleep(...)`, no `chrome.alarms` needed —
  a content script's own event loop is not subject to Manifest V3's
  *service worker* idle-termination policy; nothing here runs in the
  service worker), and the progress panel injected into the page.
- **Background service worker**'s job shrinks to what actually needs
  extension-level privilege: relaying each fetched page from the content
  script (`chrome.runtime.sendMessage({ url, html, httpStatus })`) on to the
  local HTTP route, and owning the `chrome.downloads` fallback. A
  background script's own `fetch()` to `http://127.0.0.1:{PORT}` is not
  subject to the *page's* CSP or same-origin rules the way a content
  script's would be — it needs its own `host_permissions` entry for
  `http://127.0.0.1/*` in `manifest.json`, which is a normal, well-supported
  MV3 pattern, not a guess requiring a spike.
- **State is in-memory in the content script for one crawl's lifetime.**
  Closing the tab or navigating away simply ends the crawl — every page
  already relayed to the local store is already durably saved (each page is
  posted as soon as it's fetched, not batched at the end), so nothing
  already captured is lost. Reopening the page and clicking the button
  again re-plans from scratch and skips every URL the store already holds —
  so a restart's real cost is only the pages that were still in flight, not
  the whole crawl.

  **Corrected 2026-09-08.** This paragraph used to credit that skip to "the
  store's cache read-through (`SwimCloudPoliteFetcher`, reused per D1)".
  That was never true of the built extension: `SwimCloudPoliteFetcher` is a
  Node module and has zero references anywhere under `extensions/`, and the
  crawl loop started each run with an empty `fetchedUrls` set, so a restart
  or a 5xx Retry re-fetched every already-successful page. The skip is real
  now, by a different mechanism: before planning, the content script asks
  the background worker for `GET /api/swimcloud/captures/{captureId}` and
  drops every planned step whose stored page ref has `outcome: 'ok'`. Page 1
  of each team+gender is deliberately exempt — the stored refs record the
  pages a previous run reached, which is a floor and never the total, and
  only a fresh page 1 carries the pagination that gives the total. Planning
  a team's page count off that floor would silently drop every page past it.

This removes `chrome.storage.local` crawl-state and any `chrome.alarms`
machinery from the design entirely. Simpler, and grounded in how content
scripts and same-origin `fetch()` actually behave — not in an assumption
that needed a live test to confirm.

**New residual open question** (replacing the old OQ-5, which this design
change resolves by construction): could SwimCloud's own anti-automation
detection treat a burst of `fetch()` calls from an already-loaded page
differently than the same URLs loaded by normal navigation (some sites
fingerprint request patterns, not just origin)? Not answerable by reasoning
— only the first real crawl will show it. See OQ-5 (revised) in
[08-open-questions.md](08-open-questions.md).

## Progress and cancel

A fixed panel injected into the page the crawl was started from (by the
content script, alongside the existing button):

- Title: the subject ("New South Championships — full meet").
- Line 1: `Team 3 of 4 · Women · page 5 of 8`.
- Line 2: `41 of 66 pages · about 1 min left`.
- A determinate progress bar (`plannedPageCount` is known after step 4).
- **Cancel** — always enabled. Marks the capture `'partial'` (a message to
  the background to record that status against the capture id), keeps every
  page already relayed, stops before the next request.
- **Pause / Resume** — same mechanism as cancel, without marking; resume
  continues the same in-memory loop, not a new crawl.

## How bytes reach the directory — reversing `03-architecture.md` §5

A content script cannot write arbitrary files. Three candidates, and this is
a reversal of a previously open (never-resolved) question in
`plans/2026-09-06/03-architecture.md` §5, so it is argued rather than
asserted.

| Mechanism | Verdict |
| --- | --- |
| Clipboard (what shipped in practice for the single-page case) | **Rejected for this feature.** It carries one page per user action. This feature is 66–322 pages per action. There is no clipboard flow that survives that. |
| `chrome.downloads` | **Kept as fallback.** Writes to the Downloads folder, one file per page, needing a manual move. Works with the app closed. |
| Native messaging | **Rejected.** Requires installing a host manifest into a per-browser registry path, per browser, per platform. Materially more setup than the unpacked-extension install the README already documents. |
| **Localhost HTTP POST to the existing server** | **Chosen.** |

**Why the reversal is justified.** `03-architecture.md` §5 left this
genuinely open, listing a localhost endpoint, a watched file, and the
clipboard as candidates "recorded as an open question... needs a decision
before Track A implementation starts." The clipboard is what got built in
practice, for the one-page case. The decisive new fact: that choice was
made — and worked fine — for a one-page-per-click transport. The problem
changed. The reasoning against a localhost listener that later showed up in
practice (see `WORKLOG-03`) was "zero new infrastructure, no port, works
even when the desktop app isn't running." Two of those three no longer
apply, and the third is handled:

- *Zero new infrastructure* — `apps/shell/server.ts` is an Express server
  that already exists and already runs whenever the app runs. This is one
  new route, not a new server.
- *No port* — the port already exists. `PORT` defaults to 3000 via
  `OMNI_PORT`.
- *Works when the app isn't running* — still true, and still a real
  advantage. Hence the `chrome.downloads` fallback, plus an "Import
  downloaded captures" action in the app that drains a Downloads subfolder
  into the store.

**The clipboard path is not deleted.** A single-page capture is still
useful, the Manager flow depends on it, and it is the only path verified
against the real running app with screenshots. It becomes the secondary
route.

### `manifest.json` additions this requires

Concrete, since "the extension needs more permissions" is otherwise a
hand-wave:

```json
{
  "background": { "service_worker": "background.js" },
  "permissions": ["downloads"],
  "host_permissions": ["http://127.0.0.1/*"]
}
```

`host_permissions` for `www.swimcloud.com` is **not** added — the content
script's crawl fetches are same-origin to the page it's already injected
into per `content_scripts.matches`, which already covers it. The new entry
is only for the background service worker's POST to the local app, a
genuinely cross-origin, extension-privileged request. Requesting the
narrowest permission that's actually new is also the right call for Chrome
Web Store review, if this extension is ever submitted there instead of
staying unpacked/developer-mode — not a concern today, worth not making
worse later.

### Route contract

```
POST http://127.0.0.1:{PORT}/api/swimcloud/captures/{captureId}/pages
     X-Omniswim-Capture-Token: <pairing token>
     body: { omniswimSwimCloudCapture: 2, subject, sourceUrl, retrievedAt,
             track: 'browser-extension', httpStatus, html }

POST   /api/swimcloud/captures            -> open or update a capture record
GET    /api/swimcloud/captures            -> list (the Matrix picker)
GET    /api/swimcloud/captures/{id}       -> one record
POST   /api/swimcloud/captures/{id}/parse -> parse the stored pages, return parses
DELETE /api/swimcloud/captures/{id}       -> forget
```

The payload version bumps to `2` and reuses `clipboardPayload.ts`'s existing
validate-never-throw discipline. Extend `readSwimCloudClipboardPayload` to
accept both versions rather than forking a second reader — its
`unsupported-version` rejection exists for exactly this.

### Security requirements — non-negotiable, and new

Any web page in the browser can POST to `127.0.0.1`. The repo has already
been bitten here: `plans/2026-08-14/10-security-exposure.md` §1 records a P0
where the server bound `0.0.0.0` with no auth, exposing athlete data for
identifiable minors on venue wifi. That was fixed (`HOST` now defaults to
`127.0.0.1`). This route must not reopen it.

1. **Pairing token.** The app displays a token; the user pastes it into the
   extension's options page once. The route requires it and compares in
   constant time. Without this, any site the coach visits can write into
   the capture store.
2. **Registered only on loopback.** If `HOST` is not a loopback address,
   the route is not registered at all, and the startup banner says so.
   `server.ts` already has `isLoopbackHost`.
3. **CORS scoped to the extension origin.** Never `*`.
4. **`captureId` is validated against a strict pattern** and resolved with
   `path.resolve` under the capture root, with the result asserted to still
   be under the root. `plans/2026-08-14/10-security-exposure.md` §2 is a
   path-arithmetic finding; do not repeat it.
5. **Body size cap.** One page of SwimCloud HTML is ~200 KB.
   `express.json({ limit: '50mb' })` is the global; the capture route sets
   its own tighter limit.
