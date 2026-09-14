# WORKLOG 07 — fixing the extension crawler's review findings (#1, #2, #3, #5)

**2026-09-09, `executor`, direct dispatch after the adversarial review, in
parallel with `WORKLOG-06`'s capture-store fix.**

## Bug 1 — `plannedPageCount` never corrected

`runCrawl` now sends `omniswim-swimcloud-open-capture` twice: once with the
honest floor (`page1Steps.length`, right after team-list confirmation), and
again with the real total (`fullSteps.length`) once every team's page 1 has
revealed its pagination — before the bulk fetch of pages 2..N starts. The
capture route's existing partial-update semantics (Phase 2c) make the
second send replace the first; no server or route change was needed.

## Bug 2 — team discovery never sent

`discoverTeams()` now also returns the genders actually seen during
discovery, verbatim (`'M'`/`'F'`, never mapped to `Men`/`Women` — matching
how the server's own `pageFacetsFor` already treats gender as pass-through,
not a value to normalize). The `teamDiscovery` block rides on both
open-capture sends from Bug 1, so it lands before any bulk fetching and
survives a cancel partway through discovery. `completeness: 'user-confirmed'`
— the honest value once a human has clicked through the confirmation
checklist, per that field's own type.

## Bug 3 — no resume-from-store dedup

Before planning, the content script now sends a new
`omniswim-swimcloud-read-capture` message; the background worker does
`GET /api/swimcloud/captures/{captureId}` (an existing route — no server
change) and replies. The reply distinguishes `available: false` ("could not
even ask" — app down, not paired) from `found: false` ("asked, no such
capture") — the first plans every page as before; the second is the normal
first-crawl case. Pages whose stored ref has `outcome: 'ok'` are skipped and
counted toward progress with their own panel line.

**One deliberate, documented deviation**: page 1 of every team+gender is
still always re-fetched even if already stored, because a *stored* page 1
only proves a previous run reached it — the pagination info that reveals
`totalPages` is only trustworthy from a fresh fetch, and skipping it could
silently truncate a resumed plan to whatever page count an earlier, possibly
partial run happened to see. Cost: 8 re-fetched pages instead of 66 on the
design doc's own worked example, not zero. Stated on the progress panel, in
the code, the README, and the design doc — not left implicit.

## Bug 5 (labeled #4 in the review, renumbered here since #4 in this
worklog's own sequence is the capture-store fix) — eliminated structurally

`captureIdForSubject` moved to `packages/swimcloud/src/entities.ts` (already
Node-free, already used this way for `SwimCloudCaptureSubject` — same
reasoning). `captureStore.ts` re-exports it, so every existing import is
unchanged. `background.js` is now a build artifact of a real
`src/background.ts` that imports the actual function — the hand-duplicated
copy is gone, not just tested for drift. Both bundles stay plain IIFEs, so
`manifest.json` needed no `"type": "module"` change.

## Two items surfaced, not chased further

- Team-discovery pages (`topteams`, meet root) are fetched but never
  relayed into the capture store, so a Retry always re-requests those
  specific pages (a handful, not the bulk). Storing them would change what
  a capture record actually contains — a real design question, out of
  scope for a bug-fix pass.
- `SwimCloudCapturePicker.tsx` still hand-mirrors
  `SwimCloudCaptureTeamDiscovery` rather than importing the now-Node-free
  type from `entities.ts`. Cosmetic type duplication, consistent with this
  codebase's already-documented convention of `packages/matrix` keeping
  local mirrors of `packages/swimcloud` shapes rather than depending on it
  directly — left alone rather than touching a file outside this fix's
  scope for a non-functional cleanup.

## Verified, independently re-confirmed after both parallel fixes landed

- `npx vitest run`: **481 passed, 0 failed**, 28 files.
- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npx tsc --noEmit -p extensions/swimcloud-companion/tsconfig.json`: clean.
- `node extensions/swimcloud-companion/build.mjs`: `crawler.js` 90.3kb,
  `background.js` 9.7kb, both built.
- `npm run build -w @omniswim/shell`: succeeds, 2937 modules, `server.js` 360.8kb.

No git operations. All four review findings from `WORKLOG-05` are now
closed: three fixed in the extension (this file), one fixed in the capture
store (`WORKLOG-06`).
