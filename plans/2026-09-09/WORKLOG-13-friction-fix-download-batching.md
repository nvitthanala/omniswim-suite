# WORKLOG 13 — the 234-popup bug: root cause, fix, and its real limit

**2026-09-09/10, direct execution (no subagent) — small, precisely
diagnosed, and the user asked to be walked through it plainly rather than
handed a test-pass count.**

## What the user reported, verbatim

> "ran the crawler, i reran and it could pull 234 pages but it was
> exporting each page one by one with pop ups for every single page, cant
> you package them all together and then have them exported together"

## Root cause #1 — a "success" that silently meant "not saved to the app"

`extensions/swimcloud-companion/src/background.ts`'s `relayPage` tries a
localhost POST to the running app first, and falls back to
`chrome.downloads` if that fails for any reason (app not running, no
pairing token, network error). Both outcomes returned `{ relayed: true }`
— the content script's `relayFetchedPage` treated a downloads-fallback
save as **identical** to a real save into the app. A totally unpaired
extension therefore fell back on every single page, and the crawl finished
reporting **zero failures**, because nothing was ever counted as one.

## Root cause #2 — the one warning that could have caught this said nothing

`extensions/swimcloud-companion/src/progress.ts`'s
`formatResumeDegradationLine` has a real, typed case for exactly this
condition — `SwimCloudResumeDegradation`'s `'app-unreachable'` member,
produced when the crawl's very first round trip to the background worker
comes back saying it can't reach the local app. The `switch` handling that
type had no case for it; it fell through to the `default: return ''`. The
signal existed in the type system and was never wired to a message.

## The fix

- **A pre-flight gate.** `readAlreadyCaptured`'s existing first round trip
  (already made for resume purposes, so this costs no new network request)
  now feeds a blocking confirmation — `awaitPairingConfirmation` — before a
  single SwimCloud page is fetched. Not connected → the panel says so
  plainly, offers **Continue anyway** or **Cancel**, and the user decides
  before 234 requests go out, not after.
- **A live, honest counter.** `RelayState` gained `downloadsFallbackCount`,
  tracked separately from `totalFailures` (a page that fails via BOTH the
  app and Downloads). The panel updates this count as it happens, not only
  in a final summary.
- **The actual ask: one file, not N.** `background.ts`'s `downloadFallback`
  no longer calls `chrome.downloads.download()` per page. Every fallback
  page is written to `chrome.storage.local` under its own key (an O(1)
  write, not a rewrite of a growing multi-megabyte array), with a small
  per-capture index tracking which keys exist. A new message,
  `omniswim-swimcloud-flush-downloads`, sent exactly once by `finishCrawl`
  regardless of how the crawl ends (done, cancelled, or stopped on an
  error — all six exit paths were updated to thread `relay` through so
  this fires everywhere, not just the happy path), combines every buffered
  page into one JSON array and triggers exactly one download.
- **Storage, not memory, as the accumulator, on purpose.** This worker is a
  Manifest V3 service worker, which Chrome can terminate between messages;
  an in-memory buffer holding a long crawl's fallback pages would be gone
  with it. `chrome.storage.local` survives that restart.
  `manifest.json` gained the `unlimitedStorage` permission specifically for
  this — the default 10 MB quota is well below what a real fallback run
  can produce (pages run ~200 KB each).

## What this fix could NOT be verified against, stated plainly

No real Chrome browser with the extension loaded, clicking a real crawl.
There is no headless-extension test harness in this repo — every prior
worklog in this initiative has said the same thing about the impure crawl
loop, and it remains true here. What WAS verified: the exact root cause,
read from the real code, not guessed; a clean `tsc --noEmit` and both
bundles rebuilding; the full existing test suite staying green; and new
pure-logic tests pinning the exact new strings and counts
(`tests/swimCloudExtensionProgress.test.ts`), including one that encodes
the original bug's exact symptom as an assertion (`formatResumeDegradationLine`
for `'app-unreachable'` must be non-empty and must mention "pairing token").

The user's own next step — reload the extension, retry the same real crawl
— is still the thing that actually proves this, the same as every prior
round of this initiative has required.

## A note on the user's course-correction

> "you go ahead and test it as if it is me, not running any bs tests, i
> dont care if 680something tests are successful if i cant handle this
> properly"

Taken as a standing instruction, not a one-off complaint: report root
cause and what was verified against a real artifact (the actual code, the
actual running server, the actual built bundle) before mentioning a test
count, and say plainly what's still a manual step. This worklog is written
in that order for exactly that reason — see [`01-UI-REDESIGN-PLAN.md`](01-UI-REDESIGN-PLAN.md)
for the reason this quota's remaining budget went into a plan document
rather than an attempt at real-browser test infrastructure: that infrastructure
is a legitimate, real gap, but building it well is a bigger and separate
investment than fits what was left of this session, and the user's own
explicit minimum bar this round was the plan, not more code.

## Verified

- `npx tsc --noEmit -p extensions/swimcloud-companion/tsconfig.json`: clean.
- `node extensions/swimcloud-companion/build.mjs`: `crawler.js` 136.8kb,
  `background.js` 14.1kb.
- `npx vitest run`: 683 passed before this fix, **690 passed after** (7 new
  tests added to `tests/swimCloudExtensionProgress.test.ts`, appended to
  the existing file rather than a new one — pinning
  `formatResumeDegradationLine`'s new `'app-unreachable'` message and both
  new download-batching formatters).
- `npm run lint --workspaces --if-present`: clean, all 8 workspaces.

No git operations.
