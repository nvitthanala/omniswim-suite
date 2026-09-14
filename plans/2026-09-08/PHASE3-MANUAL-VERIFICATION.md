# Phase 3 manual verification checklist — the extension crawler

**Status: not yet run by anyone.** Everything below is a list of steps a
human must carry out in a real Chromium browser against a real SwimCloud
page. Nothing in this file is a substitute for running it — see
`extensions/swimcloud-companion`'s own report for exactly which parts got
real `vitest` coverage instead (the pure `crawlRequest.ts`,
`crawlErrorPolicy.ts`, `progress.ts`, `captureResume.ts`,
`backgroundRoundTrip.ts`, `boundedFetchPool.ts` and `swimmerTimes.ts`
modules) and which parts, listed here, did not.

There is no headless-browser or `chrome.*` shim in this repo's test setup
(`package.json` has no `puppeteer`/`playwright-core`-for-extensions/
`jest-chrome`; `@playwright/test` exists but drives web pages, not a loaded
Manifest V3 extension's content/background scripts). Writing a vitest test
that mocks `chrome.*` well enough to "pass" would produce false confidence,
which this repo's `CLAUDE.md` treats as worse than stating the gap plainly.
This checklist is that plain statement, made actionable.

## 0. Prerequisites

- [ ] Rebuild the bundle after any source change: `node extensions/swimcloud-companion/build.mjs`.
- [ ] Start the app (`npm run dev -w @omniswim/shell` or the app's normal
      start command) and find the startup banner's `SwimCloud capture
      routes:` block. Copy the `Pairing token:` value.

## 1. Load the extension

- [ ] Open `chrome://extensions` (or the Edge/Brave equivalent).
- [ ] Enable **Developer mode**.
- [ ] **Load unpacked** → select `extensions/swimcloud-companion/`.
- [ ] Confirm it loads with no manifest errors (Chrome shows a red "Errors"
      button on the card if `manifest.json`, `background.js`, or the
      registered content scripts fail to parse — there should be none).

## 2. Options page — pairing token

- [ ] Click the extension's **Details** → **Extension options** (or right-click
      the toolbar icon → Options).
- [ ] Paste the pairing token from the app's startup banner. Set the port only
      if the app isn't on 3000.
- [ ] Click **Save** and confirm the "Saved." message appears.
- [ ] Reload the options page and confirm the token persisted
      (`chrome.storage.local` survives a reload; it does NOT survive
      "Clear browsing data" → "Cookies and other site data" for some browsers'
      settings — note if that surprises you).

## 3. Track A (clipboard) still works, unmodified

- [ ] Visit any real `swimcloud.com` page (a team, meet, or swimmer page).
- [ ] Confirm the original blue **"Copy for Omniswim"** button still appears
      bottom-right, unchanged in position and behavior.
- [ ] Click it, confirm the clipboard confirmation text appears, and confirm
      pasting into the app's existing "Import from clipboard" flow still
      works exactly as before this change.

## 4. Track A′ (auto-fetch) — the new button

- [ ] Visit a real SwimCloud meet page: `https://www.swimcloud.com/results/{meetId}/`.
- [ ] Confirm a second, purple **"Auto-fetch full meet (Omniswim)"** button
      appears above the clipboard button, and that it does NOT appear on a
      non-meet-scoped page (e.g. a bare swimmer profile).
- [ ] Click it. Confirm:
  - [ ] The button disappears and a dark progress panel appears bottom-right.
  - [ ] It shows "Discovering teams…" briefly, then a checklist of the
        meet's teams (checked by default) with a rough page-count floor and
        a **Start crawl** button.
  - [ ] Unchecking a team and clicking **Start crawl** excludes it from the
        crawl (spot-check: that team's pages never appear in the capture).
  - [ ] Cancelling from the checklist (before Start) ends cleanly with no
        requests issued.

## 5. Crawl in progress

- [ ] After **Start crawl**, confirm:
  - [ ] Requests to `swimcloud.com` are spaced at least 3 seconds apart (watch
        the Network tab — no burst of concurrent requests).
  - [ ] The progress panel updates after each page: `Team N of M · Gender ·
        page X of Y` and `A of B pages · about T left`, matching what's
        actually happening.
  - [ ] The progress bar fills proportionally.
  - [ ] **Pause** stops new requests from starting (in-flight ones complete);
        **Resume** (same button, relabeled) continues from where it left off,
        not from the start.
  - [ ] **Cancel** stops immediately (no further requests) and the panel
        reflects that the capture ended `partial`.

## 6. Pages actually land in the store

- [ ] While a crawl runs (or after it finishes), confirm new files/entries
      appear under `data/swimcloud-captures/` (or wherever
      `FileSystemSwimCloudCaptureStore`'s configured root is) — one capture
      record for the meet, growing page count.
- [ ] Stop the app before starting a crawl, run one anyway, and confirm pages
      fall back to `chrome.downloads` (check the browser's downloads list for
      a `omniswim-swimcloud-captures/<captureId>/...json` file per page)
      instead of silently vanishing.
- [ ] Restart the app mid-crawl (simulating a restart) and confirm the next
      relayed page succeeds again (the pairing token survives an app
      restart, per `swimcloudCaptureRoutes.ts`'s persisted-token design).
- [ ] Confirm the capture record's `plannedPageCount` is corrected during the
      crawl, not left at the page-1 floor: watch
      `data/swimcloud-captures/captures/meet-{meetId}.json` (or `GET
      /api/swimcloud/captures`) and check it starts at team count × 2, then
      moves to the real total as soon as every team's page 1 has been read —
      **before** the bulk fetch, not at the end. The Matrix picker must never
      show a page count above the planned count.
- [ ] Confirm the same record grows a `teamDiscovery` block with `source`
      (`topteams` or `meet-root-links-fallback`), `genders` (`["M","F"]` as
      the planner writes them — not `Men`/`Women`), the confirmed `teamIds`,
      and `completeness: "user-confirmed"`. Confirm the Matrix picker renders
      it.

## 6a. Resuming a crawl

- [ ] Start a crawl on a multi-page meet, let a dozen pages land, then close
      the tab. Reopen the meet page and click **Auto-fetch full meet** again.
      Confirm the panel shows "An earlier crawl of this meet already stored N
      pages…" before team discovery starts.
- [ ] After **Start crawl**, confirm the panel shows the "Resuming: X of Y
      planned pages are already captured…" line and that the Network tab shows
      **no** request for a page the store already holds.
- [ ] Confirm page 1 of every team+gender IS re-requested. That is deliberate:
      only a fresh page 1 carries the pagination widget that proves how many
      pages that team has. The stored page refs are a floor, never a total.
- [ ] Stop the app, then start a crawl. Confirm it plans every page (no resume
      claim on the panel) rather than skipping anything — an unreachable app
      must read as "we do not know what is stored", never as "nothing is".

## 6b. Rosters (pass 3) — still paced, never skipped

- [ ] After the swims passes finish, confirm the panel switches to `Rosters ·
      Team N of M · Gender` and `A of B roster pages · about T left · S
      swimmers so far, total known when this pass ends`.
- [ ] Confirm in the Network tab that roster requests are still **at least 3
      seconds apart, one at a time**. Nothing about this pass is relaxed; if
      roster requests overlap, that is a bug.
- [ ] Confirm roster pages are re-fetched even on a resumed crawl that already
      stored them. That is deliberate, for the same reason page 1 of each team's
      swims is re-read: the stored bytes are on the app's disk, and the swimmer
      list this run needs to plan the swimmer-times pass exists only in a page
      this run fetched itself. A skipped roster would silently drop that team's
      swimmers from the next pass.
- [ ] Confirm a team with no programme for one gender (a 404 roster) does not
      stop the crawl and simply contributes no swimmers.

## 6c. Swimmer times (pass 4) — the one pass that overlaps

This pass is the deliberate, narrow relaxation of
`plans/2026-09-08/03-extension-crawler.md`'s "one at a time, 3 s apart" rule and
of `plans/2026-09-06/01-legal-and-access-strategy.md`'s "never concurrent". It
applies to `/swimmer/{id}/times/` pages only. Watch for all four of these:

- [ ] **The overlap is real.** Open the Network tab, filter to `swimcloud.com`,
      and switch to the waterfall view. During this pass there must be **two or
      three swimmer-times requests in flight at once** — overlapping bars, not a
      single staircase. If every request still waits for the previous one to
      finish, the pool is not doing anything and the pass will take as long as a
      sequential crawl.
- [ ] **The overlap is bounded.** Never more than **3** in flight, and starts
      never closer together than about **400 ms**, however fast SwimCloud
      answers. A burst of ten simultaneous requests when a lane frees up is a
      bug, not a speed-up — that is the traffic shape the legal strategy draws
      the line at.
- [ ] **The core pacing is untouched.** Scroll the Network log back to the
      team-swims and roster requests and confirm they are still ≥3 s apart and
      strictly sequential. This is the check that the relaxation stayed inside
      its category.
- [ ] **One broken swimmer page does not halt the crawl.** Use devtools request
      blocking on a single `/swimmer/{id}/times/` URL and confirm: the panel's
      "N not saved" count goes up by one, the pass keeps fetching every other
      swimmer, and the crawl still reaches "Done". A timeout, a 404 and a 5xx
      must all behave this way — only a **403** stops the pass, and it says so
      on the panel while leaving the meet results already captured alone.
- [ ] A swimmer whose page 404s must read as **"N not served by SwimCloud"**,
      not as "N not saved". Those are different facts: the first is SwimCloud
      answering that there is no such page (recorded against the capture with no
      bytes, which is correct), the second is a page this run held and could not
      file. If a 404 shows up under "not saved", the two counters are crossed.
- [ ] The panel reads `Swimmer times: N of M fetched` with `M` being a real
      total (it is known before the pass starts, once every roster is parsed),
      and line 2 reads `3 at a time, 400 ms apart · about T left`.
- [ ] When the swimmer count is smaller than the roster row count, confirm the
      panel explains why — roster rows with no SwimCloud profile link, and
      swimmers listed on more than one roster. A count that shrinks with no
      explanation is indistinguishable from an under-fetch.
- [ ] **Pause holds the pool.** Clicking Pause during this pass must stop new
      swimmer-times requests starting; the two or three already in flight
      complete. Resume continues the same pass, not a new one.
- [ ] **Cancel does not strand a fetched page.** Cancel during this pass and
      confirm the requests already in flight still land in the capture rather
      than being abandoned after SwimCloud already served them.

### Cross-package dependency — confirm before running this section

This pass only reaches the capture store because `classifySwimCloudUrl` models
`/swimmer/{id}/times/` as the `swimmerTimes` resource.
`apps/shell/lib/swimcloudCaptureRoutes.ts` rejects any page whose `sourceUrl`
does not classify as `fetchable`, so if that ever regresses, every swimmer-times
page comes back 400 from the app and falls through to the `chrome.downloads`
fallback — hundreds of files in the Downloads folder instead of pages in the
capture, with the panel still reading "N of M fetched" the whole time.

- [ ] Spot-check one swimmer-times page in `data/swimcloud-captures/` after the
      pass runs, not just the panel count. The panel reports what was fetched;
      only the store proves what was filed.

## 7. Error handling

These need a way to simulate bad responses — e.g. temporarily point the
crawl at a meet id that doesn't exist (404), or use a proxy/devtools request
blocking to simulate a 5xx or a network failure. Cover each row of
`plans/2026-09-08/03-extension-crawler.md`'s error table:

- [ ] **404** on one team-gender's swims page: crawl continues, that page is
      recorded with `outcome: 'http-error'`, no other page skipped.
- [ ] **403 / Cloudflare challenge**: crawl stops immediately, panel shows
      the exact text "SwimCloud returned a challenge. Open the page in a
      tab, pass it, then Resume." — verify it is this exact sentence, not a
      paraphrase.
- [ ] **5xx**: crawl stops, a **Retry** button appears; clicking it restarts
      the crawl from team discovery rather than resuming after the failed step
      — but it now skips every page already stored, so the re-run's real cost
      is team discovery plus page 1 of each team (see "Known gaps" below).
- [ ] **Network error** (e.g. disable wifi mid-crawl): crawl stops, no retry
      offered, message says to resume once the connection is back.
- [ ] **Malformed team-discovery markup**: if SwimCloud's markup for
      `topteams` doesn't match what `parseMeetTopTeamsHtml` expects, confirm
      the crawl falls back to the meet-root pages rather than aborting
      outright (hard to force deliberately — note if this path was actually
      exercised or only reasoned about).

## 8. Theming / visual

- [ ] Confirm the progress panel and buttons are legible and don't collide
      with SwimCloud's own page chrome in both a normal window and a
      maximized one.

## Known gaps in this implementation, to keep in mind while testing

- **Retry and restart replan from team discovery, and re-read page 1.**
  Cross-session dedup now exists: before planning, the crawl asks the local
  app for `GET /api/swimcloud/captures/{id}` and skips every page whose stored
  ref has `outcome: 'ok'` (real bytes on disk). What a restart or a 5xx Retry
  still costs is the two team-discovery pages plus page 1 of every team+gender
  — team discovery because those pages are not stored in the capture at all,
  and page 1 because only a fresh one carries the pagination that says how
  many pages that team has. The stored refs give the pages a previous run got
  to, which is a floor and never the total, so planning against them would
  silently drop every page past the floor. On the design doc's 66-page
  example that is 8 re-fetched pages instead of 66. A per-page resume that
  restarts *after* the failed step, rather than replanning, is still not
  implemented.
- **The resume claim is only as good as the app being up.** If the app is not
  running, not paired, or answers anything the content script cannot read, the
  crawl plans every page. That is the safe direction, but it means a coach who
  forgot to start the app gets a full re-crawl with no warning beyond the
  missing resume line on the panel.
- **The swimmer-times pool's scheduling is unit-tested; its fetches are not.**
  `tests/swimCloudExtensionBoundedFetchPool.test.ts` drives the real scheduler
  with an injected `sleep` and controllable work items, so "never more than 3 in
  flight", "starts are staggered", "one failing item does not stop the pool",
  "a stalled item holds one lane and no more", and "cancel lets in-flight work
  finish" are assertions rather than claims. What no test in this repo covers is
  the pool wired to a real `fetch()` and a real `chrome.runtime` relay — that is
  section 6c above, and it is the only thing that can show whether SwimCloud
  tolerates the overlap at all.
- **Whether three concurrent requests are safe is not a test question.** The
  pool is a knowing relaxation of "never concurrent"
  (`plans/2026-09-06/01-legal-and-access-strategy.md`). It is bounded on both
  axes and confined to leaf pages, and it is still a materially different
  traffic pattern from a single sequential stream. If a crawl starts drawing
  challenges during pass 4 and not during passes 1–3, that is the answer, and
  the constants in `extensions/swimcloud-companion/src/swimmerTimes.ts` are
  where to respond to it.
- **Per-team-gender page counts on the progress panel** are read from the
  `knownTotalPages` map built during the page-1 discovery pass, so "page 5
  of 8" should be accurate once a real page confirms `pagination.totalPages`
  parses the way `parseTeamMeetSwimsHtml`'s tests expect. Worth double-
  checking against a real multi-page team during this checklist's run.
