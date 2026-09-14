# WORKLOG 03 — Phase 2: the local capture HTTP route

**2026-09-08, delegated to `executor` (Opus) with a standalone brief,
immediately after the 5-hour quota reset.** Full detail — every route
signature, the two real bugs found, the CORS reasoning, verification
output — is recorded in `docs/reference/SWIMCLOUD_CAPTURE_STATE.json`'s
phase "2" entry; this file is the short version for anyone reading the
plan directory in order rather than the state file.

## What shipped

- `apps/shell/lib/swimcloudCaptureRoutes.ts` (new) — the five routes from
  `03-extension-crawler.md`'s contract, minus `/parse` (no consumer until
  Phase 4 exists — building it now would mean guessing its shape).
- `apps/shell/lib/loopbackHost.ts` (new) — `isLoopbackHost` moved out of
  `server.ts` verbatim so the route-registration gate and the existing
  network-exposure warning share one implementation, not two copies that
  can drift.
- `server.ts` — registers the router, mints/loads the pairing token,
  prints it in the startup banner.
- All five security requirements from the plan (pairing token compared in
  constant time, loopback-only registration, a reasoned CORS decision
  rather than a cargo-culted header, a path-traversal guard on
  `captureId`, a real 2 MB body cap) are implemented and each has a test
  that would fail if the guard were removed — not just a happy-path test.

## Two real bugs, not invented for the test

1. `server.ts` applies `express.json({limit:'50mb'})` app-wide; body-parser
   is a no-op once `req.body` is already set, so a *route-level* 2 MB
   parser mounted after the global one would have silently inherited
   50 MB. Fixed by mounting the capture router before the global parser
   and giving it its own `Content-Length` check besides.
2. `captureIdForSubject` (Phase 1, `captureStore.ts`) interpolates a team
   subject's `season` straight into a filename, and `clipboardPayload.ts`
   validates `season` only as `typeof === 'string'` — correct for its own
   job, not for this one. A hostile `season` would have produced a
   traversing `captureId` the *server itself* derived, bypassing a
   `captureId`-only regex check entirely. Fixed by validating the derived
   id exactly like any other path parameter, plus a season charset guard.

## Verified

- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npx vitest run`: **403 passed, 0 failed** (34 new, in
  `tests/swimcloudCaptureRoutes.test.ts`).
- `npm run build -w @omniswim/shell`: succeeds.
- Live smoke test against the actual built production server (not just
  the test suite): banner prints the token; 401 with none; 403 with a
  wrong one; the full create → post-page → get → list → delete happy path
  returns 201/200/200/200/200; a traversal `captureId` returns 400 and
  writes nothing outside the capture root. Residue cleaned up afterward.

## Not done, on purpose

`/api/swimcloud/captures/:id/parse` — genuinely deferred, not skipped by
accident: nothing consumes it yet, and Phase 4 (the Matrix picker) is what
should define what a "parse" response needs to contain.

Phase 3 (extension auto-fetch crawler) and Phase 4 (Matrix capture picker)
are both unblocked now — both were only waiting on Phase 1 and Phase 2.
They can run in parallel via `worker` per the plan's phasing table, since
neither depends on the other and both are UI/wiring against Phase 1+2's
now-reported API surface.
