# Omniswim SwimCloud Companion

A browser extension for two related flows described in
[`plans/2026-09-06/`](../../plans/2026-09-06/README.md) and
[`plans/2026-09-08/03-extension-crawler.md`](../../plans/2026-09-08/03-extension-crawler.md):

- **Track A** (clipboard, one page, no fetching): adds a **"Copy for
  Omniswim"** button to any SwimCloud page you're already viewing.
- **Track A′** (auto-fetch, full meet): adds a second **"Auto-fetch full
  meet (Omniswim)"** button on a meet page that fetches every team's full
  results for that meet, still from your own logged-in browser session, and
  posts each page straight into the app.

Read
[`01-legal-and-access-strategy.md`](../../plans/2026-09-06/01-legal-and-access-strategy.md)
§4 and its "Amended 2026-09-08: Track A′" section before using the
auto-fetch button. Track A′ is **not** the same risk posture as Track A: it
fetches many pages per click, on a timer-paced loop, rather than acting only
on the page you're currently looking at. It has its own risk acceptance
recorded in that document.

## Track A — what it does

- Adds a small blue button, bottom-right, on any `swimcloud.com` page.
- On click: reads the page's current HTML and URL, builds a small JSON
  payload, and copies it to your clipboard. Nothing is sent over the
  network by this button — the clipboard is the whole transport.
- Paste that clipboard content into Omniswim Suite's "Import from clipboard"
  action (packages/manager).

## Track A′ — what it does

- Adds a second, purple button, above the clipboard one, **only on a
  meet-scoped SwimCloud page** (`/results/{meetId}/...`).
- On click:
  0. Asks the local app what it already holds for this meet, so a restarted
     or retried crawl never re-requests a page SwimCloud has already served.
     Page 1 of each team is the one exception — it is always re-read, because
     only a fresh page 1 proves how many pages that team has.
  1. Discovers every team in the meet (`/results/{meetId}/topteams/` for
     both genders, falling back to the meet-root pages if that fails), and
     records that discovery — its source, the genders read, the team list you
     confirmed — on the capture, so the app can say where the list came from.
  2. Shows a checklist of the discovered teams so you can confirm or amend
     it before any bulk fetching starts.
  3. Fetches every team's full results, one page at a time, waiting at
     least 3 seconds between requests — same-origin `fetch()` calls from
     the page you're already on, using your existing session, never a
     separate bot.
  4. Relays each fetched page, as soon as it's fetched (not batched), to
     Omniswim Suite's local server via the extension's background service
     worker. If the server isn't reachable, the page is saved instead to
     your Downloads folder under `omniswim-swimcloud-captures/<captureId>/`
     so nothing already fetched is lost.
  5. Shows a live progress panel (team/gender/page, pages done, an ETA) with
     **Cancel** and **Pause/Resume** controls.
- A 403/Cloudflare challenge stops the whole crawl immediately — no retry
  loop. A 404 is recorded and the crawl continues (a team with no program in
  one gender is a real, expected outcome, not an error). A 5xx stops the
  crawl with one manual Retry. See
  [`03-extension-crawler.md`](../../plans/2026-09-08/03-extension-crawler.md)'s
  "Error handling" table for the exact rules.
- This never runs on a timer and never starts itself — every fetch happens
  because the crawl loop you started with one click is still running. Closing
  the tab or navigating away ends the crawl; everything already relayed is
  already saved.

## Multi-team crawl — what it does

A second button, "Multi-team crawl (Omniswim)", sits on every
`www.swimcloud.com` page (above the other two). It crawls several teams, each
for the season you pick, into the Omniswim app. It runs in the content script,
in your own browser session, because the requests must be same-origin.

How to use it:

1. Click the button. A panel opens.
2. Paste team links, one per line (or split by spaces or commas). Any
   `/team/{id}/...` link works. Click **Parse links**. The panel lists the teams
   it will read and every line it skipped, with the reason.
3. **Conference links are not supported yet.** The panel says "conference pages
   are not supported yet (waiting for a captured conference page)" and crawls
   nothing for them. Paste the teams' own links instead.
4. Click **Read season lists**. For each team the panel fetches
   `/team/{id}/roster/?gender=M` (no season) and reads that team's own season
   menu. Season ids are never shared between teams and never computed.
5. Pick a season per team (or "Skip this team"). The menu starts on the season
   the page shows as current. Click **Start crawl**.
6. Use **Pause** and **Resume** (work in flight finishes first) and **Cancel**.
   The panel shows one progress line per team, error lines, and a summary at the
   end: rosters and swimmers done, failed, skipped (already finished), and teams
   whose season is not offered.

What it requests, in order: each team's season page, then both rosters
(men, women) of every chosen team, then one
`/api/swimmers/{id}/profile_fastest_times/` request per distinct swimmer. A
swimmer on two teams is fetched once. Every page goes to the app under the
subject `team-{id}-{season}` (season pages under `team-{id}`).

Pacing is the existing pacing, read from the same constants
(`src/crawlPacing.ts`, `SWIMMER_TIMES_*` in `src/swimmerTimes.ts`): one request
at a time, at least 3 s apart. A 429 is retried with the existing backoff, which
only waits longer. The crawl stops by itself on a Cloudflare 403 (never
retried: refresh your SwimCloud session in the tab, then start again), any 5xx,
a network error, three rate-limited pages in a row, a swimmer reply that is not
JSON, or several pages in a row that the app cannot accept. Finished swimmers
are saved in `chrome.storage.local` and skipped on the next run. Roster pages
are always fetched again.

What it does not do:

- No conference crawl (no captured conference page exists yet).
- No relay-leg credits (waiting for a captured swimmer response that has one).
- The swimmer endpoint returns all-time bests. For a past season they can
  include later seasons. Do not read them as that season's times.
- A roster page whose season does not match the chosen one is a failure and is
  not sent to the app.

Manual live checklist (nobody has run this against the live site):

1. Open any SwimCloud page, click the button, paste two team links, Parse.
   Expect both ids listed and a conference link refused with the note.
2. Read season lists. Expect one 3 s-spaced request per team and a dropdown per
   team that matches that team's own season menu on the site.
3. Pick a season that is not the current one for one team. Start. Open DevTools
   Network. Expect roster URLs with `season_id` and `sort=name`, then swimmer
   URLs. Expect no request faster than 3 s apart and no request in parallel.
4. Check the roster page the app received is for the chosen season (a wrong
   season must show as a failed roster, not as data).
5. Pause for 10 s, Resume. Expect no request while paused.
6. Cancel mid-run, start again with the same teams. Expect finished swimmers
   skipped and rosters fetched again.
7. If SwimCloud answers 403 or 429, expect the crawl to stop with the message
   and no retry of the 403.

## What it deliberately does not do

- Neither button ever runs on a schedule, in the background, or without a
  click. Track A′'s crawl runs only for as long as the tab it was started
  from stays open on that page.
- Track A never sends data anywhere except your own clipboard.
- Track A′ never fetches anything outside `swimcloud.com` from the content
  script; the only cross-origin request is the background service worker's
  POST to your own machine's `127.0.0.1`, gated by a pairing token you paste
  in once (see "Pairing the extension" below).
- Neither button requires you to be logged in to anything except SwimCloud
  itself (however you'd normally view a page there).

## Pairing the extension (required for Track A′ only)

Track A′ needs to know where to send captured pages and how to prove it's
allowed to. Omniswim Suite prints a pairing token in its own startup
console banner, under "SwimCloud capture routes". To pair:

1. Start the app and copy the `Pairing token:` line from its startup output.
2. Open the extension's options page (`chrome://extensions` → this
   extension's card → **Details** → **Extension options**, or right-click
   the toolbar icon → **Options**).
3. Paste the token, confirm the port matches the app's (default 3000), and
   click **Save**.

The token is stored in `chrome.storage.local`, private to this browser
profile. Anyone holding it can write into your local capture store, so treat
it like a password; delete `data/swimcloud-pairing-token.json` on the app
side to revoke and force a re-pair. Track A (the clipboard button) needs no
pairing — it never talks to the network.

## Installing it (unpacked, for development/personal use)

This is not published to the Chrome Web Store. To use it:

1. **Build the crawler bundle first**: `node extensions/swimcloud-companion/build.mjs`
   (needs `esbuild`, already a repo dependency — no separate install step).
   Re-run this after any change under `extensions/swimcloud-companion/src/`.
2. Open `chrome://extensions` (or the equivalent in Edge/Brave/any
   Chromium-based browser: `edge://extensions`, etc.).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select this directory
   (`extensions/swimcloud-companion/`).
5. Visit a SwimCloud page — a team, swimmer, results, or conference page —
   and the "Copy for Omniswim" button should appear bottom-right. On a meet
   page specifically, the "Auto-fetch full meet" button appears above it.

## Payload shapes

Track A (clipboard), version 1:

```json
{
  "omniswimSwimCloudCapture": 1,
  "sourceUrl": "https://www.swimcloud.com/team/633/",
  "retrievedAt": "2026-09-07T00:00:00.000Z",
  "track": "browser-extension",
  "html": "<!doctype html>..."
}
```

Track A′ (posted by the background service worker), version 2 — see
[`03-extension-crawler.md`](../../plans/2026-09-08/03-extension-crawler.md)'s
"Route contract" for the full HTTP contract:

```json
{
  "omniswimSwimCloudCapture": 2,
  "subject": { "kind": "meet", "meetId": "356467" },
  "sourceUrl": "https://www.swimcloud.com/results/356467/team/58/swims/?gender=M",
  "retrievedAt": "2026-09-08T00:00:00.000Z",
  "track": "browser-extension",
  "httpStatus": 200,
  "html": "<!doctype html>..."
}
```

Both shapes are versioned and validated by
`packages/swimcloud/src/clipboardPayload.ts`'s
`readSwimCloudClipboardPayload`, which accepts either version rather than
forking a second reader. `content.js`'s `buildPayload()` (Track A) still
duplicates the v1 shape by hand — it's an unbundled classic script with no
import available to it. Track A′'s `crawler.js` is different: it's built by
`build.mjs` from `src/crawler-content.ts`, which genuinely imports
`@omniswim/swimcloud`'s planner, parser and URL classifier rather than
duplicating any of their logic.

## Source layout

- `content.js` / `content.css` — Track A, unchanged by this round.
- `src/crawler-content.ts` — Track A′'s crawl loop, DOM panel, and
  `chrome.runtime` messaging. Bundled by `build.mjs` into `crawler.js`,
  which `manifest.json` loads as a second content script alongside
  `content.js`.
- `src/crawlRequest.ts`, `src/crawlErrorPolicy.ts`, `src/progress.ts`,
  `src/captureResume.ts` — the pure pieces of the crawl loop, factored out
  specifically so they have real `vitest` coverage
  (`tests/swimCloudExtensionCrawlRequest.test.ts`,
  `tests/swimCloudExtensionCrawlErrorPolicy.test.ts`,
  `tests/swimCloudExtensionProgress.test.ts`,
  `tests/swimCloudExtensionCaptureResume.test.ts`) without needing a browser.
- `src/background.ts` — the service worker: opens and updates the capture
  record, reads it back so a restarted crawl skips what is already stored,
  relays fetched pages to the local app, and owns the `chrome.downloads`
  fallback. Bundled by `build.mjs` into `background.js`, which
  `manifest.json` loads. It became a bundle so it could import
  `captureIdForSubject` from `@omniswim/swimcloud/entities` instead of
  carrying a hand-written copy of that rule —
  `tests/swimCloudExtensionCaptureId.test.ts` keeps it that way.
- `src/multiTeamDriver.ts` — the multi-team crawl loop with every I/O injected
  (`tests/swimCloudExtensionMultiTeamDriver.test.ts`, run on archived roster
  pages with a fake clock). `src/multiTeamQueue.ts` is its work queue.
  `src/multiTeamPanelModel.ts` holds the panel's text and rows
  (`tests/swimCloudExtensionMultiTeamPanelModel.test.ts`).
  `src/multiTeamPanel.ts` is the thin DOM half, wired in by `crawler-content.ts`.
  `src/crawlPacing.ts` holds the shared 3 s floor.
- `options.html` / `options.js` — the pairing-token field.

`crawler.js` and `background.js` are **build artifacts**. Edit the matching
file under `src/` and re-run `node extensions/swimcloud-companion/build.mjs`.

## Status

**Untested against a real SwimCloud page**, for both tracks — Track A never
was (see history below), and Track A′ is new. See
[`plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md`](../../plans/2026-09-08/PHASE3-MANUAL-VERIFICATION.md)
for the exact checklist nobody has run yet, and its "Known gaps" section for
what this implementation does not yet handle (a 5xx Retry replans from team
discovery rather than resuming after the failed step, and page 1 of every
team is always re-read).

What IS unit-tested: the pure crawl-planning functions in
`packages/swimcloud/src/crawlPlan.ts` (`tests/swimcloudCrawlPlan.test.ts`),
the payload reader (`tests/swimcloudClipboardPayload.test.ts`), the capture
routes (`tests/swimcloudCaptureRoutes.test.ts`), and this extension's own
pure helpers listed above. What's unverified is everything that needs a
live browser and a live SwimCloud page: DOM injection timing, whether
`fetch()` from a content script really carries the session cookies the way
the design doc reasons it does, and how SwimCloud's own markup and
anti-automation behavior actually respond to a paced burst of same-origin
fetches.
