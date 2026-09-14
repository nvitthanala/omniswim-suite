# WORKLOG 05 — adversarial review of Phases 2/2c/3/4, and the fixes it triggered

**2026-09-08, after Phases 0/0b/1/2/2c/3/4 and the Phase 6 verification sweep
all landed green.** The user asked for "a thorough review" once everything
was built. A fresh `general-purpose` agent with no prior context reviewed
the security surface and the extension code (which no one else had
independently read) adversarially — instructed to find real problems, not
confirm prior reports. It found genuine bugs. This file records them and
what was done about each.

## Security surface: held up

Timing-safe token comparison, the new `/api/swimcloud/pairing-token` route's
auth gating, path-traversal resistance (including a `%2F`-encoded slash
attempt), and CORS origin matching were all traced by hand, not trusted from
their own comments. No bypass was found. The picker's every capture-route
`fetch(` call was confirmed to carry the token header, with only the
token-fetch itself correctly omitting it.

## Real bugs found — functional/integration, not security

1. **`plannedPageCount` sent once, before the true total is known, and
   never corrected.** A fully successful 66-page crawl would display
   "66 of 8 planned pages" in the Matrix picker forever — the opposite of
   this initiative's own "never overclaim completeness" discipline.
2. **Team discovery computed but never sent.** `discoverTeams()` and
   `confirmTeamList()` produce exactly what `SwimCloudCaptureTeamDiscovery`
   needs; none of it reached the server. The picker's `teamDiscovery` UI
   (built in Phase 4, real code, real tests) had nothing to ever display.
3. **No resume-from-store dedup, contradicting this initiative's own
   design doc.** `03-extension-crawler.md` explicitly claims a restart's
   real cost is "only the pages that were still in flight" — false as
   shipped. A 5xx-triggered Retry, or closing and reopening the tab,
   re-fetches every already-successful page from SwimCloud, doubling live
   traffic against a site this repo's own legal/access doc already treats
   as scraping-sensitive.
4. **Unlocked read-modify-write on the capture manifest.** Two concurrent
   writers to the same `captureId` (two tabs auto-fetching the same meet)
   can race; whichever `writeCapture` runs second silently drops the
   other's page reference from the manifest, even though the page's bytes
   are safely stored — the page becomes invisible to `/parse` forever with
   no error anywhere.
5. **`background.js` hand-duplicates `captureIdForSubject`'s logic**, with
   no shared source of truth — a latent drift risk for Phase 5 (team
   subjects), not a live bug today since the season-suffix branch is never
   exercised yet.

## Fixes dispatched

Two `executor` agents, disjoint scope, in parallel:

- **`extensions/swimcloud-companion/`** — bugs 1, 2, 3, and (best-effort) 5.
- **`packages/swimcloud/src/captureStore.ts`** — bug 4, via an in-process
  per-`captureId` async mutex, explicitly scoped in its own doc comment to
  what it does and does not protect against (one Node process's concurrent
  request handlers — the actual deployment shape here — not multiple OS
  processes).

Results recorded in `docs/reference/SWIMCLOUD_CAPTURE_STATE.json` and a
follow-up worklog once both report back.

## Interrupted by a session-quota reset, then re-dispatched clean

Both agents were killed mid-flight by a 5-hour quota reset before either
had edited a single file (confirmed via file mtimes and content grep —
`crawler-content.ts` had no `teamDiscovery` references, `captureStore.ts`
had no mutex code). No partial or corrupted state to reconcile. Both were
re-dispatched with the identical briefs immediately once the new quota
window opened, 2026-09-09.
