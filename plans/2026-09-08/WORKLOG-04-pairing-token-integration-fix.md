# WORKLOG 04 — closing the pairing-token integration gap between Phase 2c and Phase 4

**2026-09-08, direct execution (not delegated) immediately after Phase 2c,
Phase 3, and Phase 4 all landed from parallel dispatch.**

## The gap

Phase 4's `worker` did exactly what a careful implementation should: it
built `SwimCloudCapturePicker.tsx` against the contract it was given, ran
its tests, and then **flagged, in its own completion report, a real problem
it found rather than hiding it**: every capture route requires
`X-Omniswim-Capture-Token`, and nothing gives a browser tab holding the
Matrix UI a way to obtain that token. The picker would 401 on every call
against a real server. This is precisely the kind of disagreement the
Phase 2c state-file note asked to be checked for ("verify the two actually
agree once both report back") — they did not.

## The fix

Added `GET /api/swimcloud/pairing-token` to `apps/shell/server.ts`, placed
after `optionalAuth`/`requireAuth` are constructed (the pairing-token setup
itself happens earlier in `startServer()`, before those exist yet, so this
route could not live next to it). Reasoning, not just the code:

- Gated by this app's own auth (`requireAuth` when `AUTH_REQUIRED`,
  `optionalAuth` otherwise) — identical protection to every other
  workspace-data route in the file. It grants the picker no more trust than
  the app already extends to its own frontend.
- No CORS header. A page on another origin can still cause the browser to
  *send* this request, but cannot *read* the JSON response without an
  `Access-Control-Allow-Origin` this route never emits — so the token
  stays opaque to any page but this app's own same-origin frontend, which
  is the actual property worth protecting.
- Registered only when the capture routes themselves were (loopback bind)
  — serving a token for routes that don't exist would be a confusing
  half-truth.

`SwimCloudCapturePicker.tsx` now fetches this once when opened, before
doing anything else, and attaches the token to every subsequent capture
route call (list, parse, delete). If the token fetch fails, it shows why
and never sends a request it knows will 401 — no silent retry loop, no
guessed fallback.

## Verified for real, not just re-mocked

- `npx vitest run`: **445 passed, 0 failed** (up from 431; one new test
  asserts the picker shows the token error and calls no capture route at
  all when the token fetch fails).
- `npm run lint --workspaces --if-present`: all 8 workspaces clean (one
  real bug caught here: a leftover zero-argument `loadCaptures()` call
  inside the 404-retry branch of `selectCapture`, missed in the first
  pass of the edit — `tsc` caught it immediately).
- `npm run build -w @omniswim/shell`: succeeds.
- **A live smoke test against the actual built production server**
  (`NODE_ENV=production`, a scratch port), not just the mocked test suite:
  `GET /api/swimcloud/pairing-token` → 200 with a real token;
  `GET /api/swimcloud/captures` with no header → 401; the same call with
  the fetched token → 200; a real create → delete round trip; the capture
  store confirmed empty afterward. This is the same discipline Phase 2's
  worklog used to verify its own security guards against a real server
  rather than trusting mocks alone.

## Why this was done directly rather than delegated

Small, cross-cutting (touches both `apps/shell` and `packages/matrix`),
and security-adjacent — exactly the shape of change that's cheaper and
safer to make with full context in hand than to write a standalone brief
for, especially once the fix itself became this well-defined.
