# Worklog — Phase 2: fetch service + cache

Same purpose as
[WORKLOG-01-phase1-data-model-and-scoring.md](WORKLOG-01-phase1-data-model-and-scoring.md):
read this first if resuming mid-Phase-2. Working from
[04-phasing.md](04-phasing.md) "Phase 2".

## Status: CORE DONE. Live-site verification still outstanding (by design — see below).

## Checklist

- [x] **Politeness wrapper** (`packages/swimcloud/src/fetcher.ts`) — commit
  `23636666`. Robots.txt denylist enforced via `classifySwimCloudUrl` before
  any request; instance-wide rate limiting with an injectable clock;
  status-keyed cache read-through; `forceRefresh` against a `'final'` entry
  throws (`SwimCloudFinalEntryImmutableError`) rather than silently
  refreshing or silently no-op'ing.
- [x] **Status-keyed cache** (`packages/swimcloud/src/cache.ts`) — same
  commit. `InMemorySwimCloudCache` (tests, and any caller without
  persistence wired up yet) and `FileSystemSwimCloudCache` (one JSON file
  per canonical URL — no `packages/db` dependency; that stays descoped).
- [x] **Playwright integration** (`packages/swimcloud/src/playwrightFetcher.ts`)
  — same commit. Written against the real `playwright-core` API (already in
  the tree at the version `@playwright/test` resolves to), session reuse via
  `storageState`, honest User-Agent enforced at construction.
- [ ] **The one thing this checklist cannot mark done**: a supervised,
  human-present run of `PlaywrightSwimCloudFetcher` against one real
  SwimCloud URL, confirming it actually clears the Cloudflare Managed/JS
  Challenge (`01-legal-and-access-strategy.md` §2). This is deliberately
  **not** something this session did or should do unattended — see
  "Why the live-fire test is not in this worklog's done column" below.
- [x] Full suite green after Phase 2: 173 tests / 11 files, lint clean 8/8
  workspaces, at commit `23636666`.

## Why the live-fire test is not in this worklog's done column

Two independent reasons, not one:

1. **Policy.** `01-legal-and-access-strategy.md` §4's whole design for Track
   B is "on-demand, single-operator, an explicit paste action" — deliberately
   never something code (or an agent) decides to do on its own initiative.
   Actually fetching `swimcloud.com` — even once, even for verification — is
   the one action in this entire plan that needs a human present making that
   specific call in the moment, not a standing "go ahead" from three weeks of
   conversation ago.
2. **Mechanics.** No Chromium binary is installed in this environment
   (`npx playwright install` was never run — see the Phase 1a commit's
   "environment issues" note). `PlaywrightSwimCloudFetcher.fetchRaw()` would
   fail immediately regardless of policy.

What *is* verified: everything in `fetcher.ts`/`cache.ts` that doesn't
require a real browser — which is the actual policy logic (denylist, rate
limit, cache semantics) — via 33 tests against a hand-rolled fake
`SwimCloudRawFetcher`. `playwrightFetcher.ts` itself has 5 tests covering
what's testable without launching Chromium (constructor validation, the
`storageState` missing-file path resolution).

## Update, 2026-09-07: the local smoke test is done

Installed Chromium (`npx playwright install chromium`) and wrote
`tests/swimcloudPlaywrightFetcher.local.test.ts` — 3 tests against a
throwaway local `node:http` server (never SwimCloud): launch+navigate+
extract, `storageState` persists a real cookie the server set, and a second,
separate fetcher instance replays that cookie back purely via the file on
disk. All three passed. This upgrades `PlaywrightSwimCloudFetcher` from
"written against the documented API, never executed" to "executed,
mechanics confirmed" — **without** resolving open question 2, which this
test deliberately does not attempt.

**The actual live-site verification (Phase 2's real acceptance criterion)
is still not done and still needs the human-present moment described
above.** The mechanism working locally is evidence it's *likely* to work
against a real Cloudflare-fronted page too, but "likely" is exactly the gap
a supervised run closes and nothing else can.

## Log

- **2026-09-07** — `packages/core` and `packages/swimcloud` both confirmed
  clean and green after Phase 1 (commit `724c3288`). Started Phase 2 in the
  same session, no new agent spawned — the orchestrator (this session, Sonnet)
  wrote `cache.ts`, `fetcher.ts`, `playwrightFetcher.ts` and their tests
  directly, verifying lint + full suite before each commit, same discipline
  as the Phase 1b recovery.
- **2026-09-07** — Committed as `23636666`. Full suite 173/173, lint 8/8.
