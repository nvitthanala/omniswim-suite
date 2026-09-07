# Omniswim SwimCloud Companion

Track A of the SwimCloud ingestion plan
([`plans/2026-09-06/`](../../plans/2026-09-06/README.md)): a browser
extension that adds a **"Copy for Omniswim"** button to SwimCloud pages
you're already viewing, in your own logged-in browser. Read
[`01-legal-and-access-strategy.md`](../../plans/2026-09-06/01-legal-and-access-strategy.md)
§4 before using this — it explains why this track exists and what it does
and does not do.

## What it does

- Adds a small button, bottom-right, on any `swimcloud.com` page.
- On click: reads the page's current HTML and URL, builds a small JSON
  payload, and copies it to your clipboard. Nothing is sent over the
  network by this extension — the clipboard is the whole transport.
- Paste that clipboard content into Omniswim Suite's "Import from clipboard"
  action (packages/manager — wiring for this is tracked in
  [`plans/2026-09-06/04-phasing.md`](../../plans/2026-09-06/04-phasing.md)
  Phase 3; as of this file being written, the extension side is done and the
  app-side paste action may or may not exist yet — check the Phase 3
  worklog).

## What it deliberately does not do

- Never fetches anything on its own. Never runs on a timer or in the
  background. Never navigates. It only ever acts in direct response to you
  clicking the button on a page you already opened yourself.
- Never sends data anywhere except your own clipboard.
- Doesn't require you to be logged in to anything except SwimCloud itself
  (however you'd normally view a page there).

If a future version of this extension ever grows an "auto-import" or
scheduled mode, that would be a materially different thing — Track B, not
Track A — and would need to be evaluated against
`01-legal-and-access-strategy.md`'s standards for that track, not this one.

## Installing it (unpacked, for development/personal use)

This is not published to the Chrome Web Store. To use it:

1. Open `chrome://extensions` (or the equivalent in Edge/Brave/any
   Chromium-based browser: `edge://extensions`, etc.).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this directory
   (`extensions/swimcloud-companion/`).
4. Visit a SwimCloud page — a team, swimmer, results, or conference page —
   and the button should appear in the bottom-right corner.

## Payload shape

```json
{
  "omniswimSwimCloudCapture": 1,
  "sourceUrl": "https://www.swimcloud.com/team/633/",
  "retrievedAt": "2026-09-07T00:00:00.000Z",
  "track": "browser-extension",
  "html": "<!doctype html>..."
}
```

This shape is versioned (`omniswimSwimCloudCapture: 1`) and must stay in sync
with `packages/swimcloud/src/clipboardPayload.ts`, which is what actually
validates and parses it on the app side. `content.js` can't import that
module directly — it's an unbundled Manifest V3 content script — so the
shape is duplicated in exactly one place (`content.js`'s `buildPayload()`)
rather than spread across the file. If you change one, change the other, and
re-run `npx vitest run tests/swimcloudClipboardPayload.test.ts`.

## Status

**Untested against a real SwimCloud page.** Like the rest of this plan's
`packages/swimcloud` code, this extension was written against a description
of SwimCloud's structure, not a page SwimCloud actually served — see
`plans/2026-09-06/04-phasing.md` open question 2. The one difference: this
extension doesn't need SwimCloud's markup to have any particular shape to
work correctly — it copies whatever HTML is actually on the page, verbatim,
regardless of structure. What's unverified is downstream of this file: how
well `packages/swimcloud`'s parser makes sense of that HTML once it's real.
