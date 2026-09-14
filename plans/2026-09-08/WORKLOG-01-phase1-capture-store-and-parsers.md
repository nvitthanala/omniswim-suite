# WORKLOG 01 — Phase 1: capture store, crawl planner, meet-team parsers

**2026-09-08, direct execution** (no subagent spawned — quota was tight, 26%
of the 5-hour window remaining with a scheduled reset in ~2 hours; direct
execution avoided paying a cold-start context cost against that budget, same
reasoning `WORKLOG-02`/`WORKLOG-03` record for the same tradeoff). Scoped to
exactly Phase 1 from `07-phasing-and-delegation.md` — one package
(`packages/swimcloud`), fully specifiable, independently verifiable — so a
forced stop at any point would leave a green tree, never a half-built one.

## What shipped, in `packages/swimcloud/src/`

**New files:**
- `captureStore.ts` — `FileSystemSwimCloudCaptureStore`, a manifest layer
  over the existing `FileSystemSwimCloudCache` (unchanged). Directory
  layout, merge-by-`canonicalUrl`/`captureId` semantics, and the
  no-`'complete'` `SwimCloudCaptureCompleteness` type exactly as specified in
  `02-capture-store.md`.
- `crawlPlan.ts` — pure `planMeetTeamDiscovery`, `planMeetTeamDiscoveryFallback`,
  `planMeetTeamSwims`. No network, no clock, no DOM.

**Changed files:**
- `entities.ts` — added `SwimCloudCaptureSubject` (additive).
- `cache.ts` — added `SwimCloudCacheEntry.httpStatus?` and `.captureId?` (additive).
- `urlClassifier.ts` — added the `meetTopTeams` resource kind for
  `/results/{meetId}/topteams/`, confirmed real 2026-09-08 (see
  `01-decisions.md`'s OQ-1/OQ-1b findings). Classification, `canonicalPathForResource`,
  and `meetScopeFromSourceUrl` (in `parser.ts`) all updated together.
- `parser.ts` — added `parseMeetTeamsHtml` (the meet-root Teams card,
  `discoveryCompleteness: 'unproven'`) and `parseMeetTopTeamsHtml` (the full
  `topteams` page, `discoveryCompleteness: 'verified-complete-for-this-capture'`),
  sharing one internal row-extractor (`extractTeamStandingsRows`) and one
  internal page-locator (`locateCardTable`, finds a card's table by its
  `<h2 class="c-title">` heading rather than assuming table order — robust
  to the landing page's multiple cards).
- `clipboardPayload.ts` — added `omniswimSwimCloudCapture: 2` support
  (`SwimCloudClipboardPayloadV2`, carrying a `subject` and optional
  `httpStatus`), reusing the existing reader and its `unsupported-version`
  rejection rather than forking a second one, per `03-extension-crawler.md`'s
  route-contract spec.
- `index.ts` / `package.json` — every new export made public; two new
  subpaths (`./captureStore`, `./crawlPlan`) added to the exports map,
  matching the existing per-module subpath convention.

## A real bug found and fixed mid-build, not just a design correction

`clipboardPayload.ts`'s new `import type { SwimCloudCaptureSubject } from
'./captureStore'` broke the exact boundary `docs/INVARIANTS.md` #7 already
protects: `captureStore.ts` composes `cache.ts`'s `FileSystemSwimCloudCache`,
which does `await import('node:fs/promises')` internally, and TypeScript
fully type-checks a file it reads for even one re-exported type — so this
one type-only import pulled Node-only code into the type-check graph of
every browser package that imports `@omniswim/swimcloud/clipboardPayload`
(`packages/matrix`, `packages/manager`). Caught by `npm run lint --workspaces`,
not by `@omniswim/swimcloud`'s own lint (which passed the whole time — the
break was only visible from a *consumer's* tsconfig, which is exactly why
the full-workspace sweep matters and a single package's lint isn't enough).

Fixed by moving `SwimCloudCaptureSubject` to `entities.ts` (already
Node-free, already safely imported everywhere) and re-exporting it from
`captureStore.ts` for API continuity. Not a workaround — `entities.ts` is
where a domain type belongs; it was only ever in `captureStore.ts` because
that's where this worklog first needed it.

## Verified, not claimed

- `npm run lint --workspaces --if-present`: **all 8 workspaces clean.**
- `npx vitest run`: **363 passed, 0 failed** (up from 316 at session start —
  47 new tests, all against real fixtures where a real fixture existed:
  `tests/swimcloudMeetTeamsParser.test.ts` (13 tests, all four real
  meet-landing/topteams captures), `tests/swimcloudCrawlPlan.test.ts` (10,
  pure), `tests/swimcloudCaptureStore.test.ts` (10, real temp-directory
  filesystem, not mocked), plus additions to the existing url-classifier (6
  new) and clipboard-payload (8 new, one existing test's now-false premise
  fixed rather than left contradicting reality — see below) suites).
- `npm run build -w @omniswim/shell`: **succeeds**, 2936 modules, both the
  Vite browser bundle and the esbuild server bundle.

One existing test's premise needed correcting, not just passing around:
`swimcloudClipboardPayload.test.ts` had a test asserting
`omniswimSwimCloudCapture: 2` was an unsupported future version — true
before this worklog, false after. Fixed to test version `3` for the
"genuinely unsupported" case, and added a new test for the case that test
used to almost-accidentally cover: a v1-shaped payload merely *claiming*
version 2 is correctly rejected as `wrong-shape` (missing the required
`subject` field), not silently accepted.

## What Phase 1 does not include, on purpose

- No extension changes (Phase 3), no server route (Phase 2), no Matrix UI
  (Phase 4). This worklog is `packages/swimcloud` only.
- No git operations — diffs only, per every agent definition's standing rule.
- The team-subject work (Phase 5) is untouched — still gated on F6/F7/F8,
  real captures that don't exist yet.

## Reported API surface (for Phase 2/3/4 to build against)

```ts
// captureStore.ts
export class FileSystemSwimCloudCaptureStore {
  constructor(root: string);
  getCapture(captureId: string): Promise<SwimCloudCaptureRecord | undefined>;
  listCaptures(): Promise<readonly SwimCloudCaptureRecord[]>;
  upsertCapture(record: SwimCloudCaptureRecord): Promise<SwimCloudCaptureRecord>;
  putPage(captureId: string, entry: SwimCloudCacheEntry | undefined, pageRef: SwimCloudCapturePageRef): Promise<void>;
  readPage(canonicalUrl: string): Promise<SwimCloudCacheEntry | undefined>;
  deleteCapture(captureId: string, options: { withPages: boolean }): Promise<void>;
  rebuildIndex(): Promise<void>;
}
export function captureIdForSubject(subject: SwimCloudCaptureSubject): string;
// + types: SwimCloudCaptureSubject (from ./entities), SwimCloudCapturePageRef,
//   SwimCloudCaptureRecord, SwimCloudCaptureCompleteness, SwimCloudCapturePageOutcome,
//   SwimCloudCaptureTeamDiscovery

// crawlPlan.ts
export function planMeetTeamDiscovery(meetId: SwimCloudMeetId): readonly SwimCloudCrawlStep[];
export function planMeetTeamDiscoveryFallback(meetId: SwimCloudMeetId): readonly SwimCloudCrawlStep[];
export function planMeetTeamSwims(input: SwimCloudMeetSwimsCrawlInput): readonly SwimCloudCrawlStep[];
// + types: SwimCloudCrawlStep, SwimCloudCrawlGender, SwimCloudMeetSwimsCrawlInput

// parser.ts (additions)
export function parseMeetTeamsHtml(html: string, context: SwimCloudParseContext, options?: SwimCloudMeetTeamsParseOptions): SwimCloudParseResult<SwimCloudMeetTeamsParse>;
export function parseMeetTopTeamsHtml(html: string, context: SwimCloudParseContext, options?: SwimCloudMeetTeamsParseOptions): SwimCloudParseResult<SwimCloudMeetTeamsParse>;
// + types: SwimCloudMeetTeamStanding, SwimCloudMeetTeamsDiscoveryCompleteness,
//   SwimCloudMeetTeamsParse, SwimCloudMeetTeamsParseOptions

// urlClassifier.ts (addition)
// SwimCloudResourceKind gains 'meetTopTeams'; SwimCloudResource gains the
// { kind: 'meetTopTeams', meetId, query: SwimCloudMeetTeamQuery } variant.

// clipboardPayload.ts (addition)
export interface SwimCloudClipboardPayloadV2 {
  omniswimSwimCloudCapture: 2;
  subject: SwimCloudCaptureSubject;
  sourceUrl: string; retrievedAt: string; track: 'browser-extension';
  httpStatus?: number; html: string;
}
// readSwimCloudClipboardPayload's SwimCloudClipboardAccepted.payload is now
// SwimCloudClipboardPayload | SwimCloudClipboardPayloadV2 — check
// `.omniswimSwimCloudCapture` to narrow.

// cache.ts (additions, both optional — no existing caller changes)
// SwimCloudCacheEntry.httpStatus?: number
// SwimCloudCacheEntry.captureId?: string
```

## Next

Phase 2 (`apps/shell/server.ts` capture routes — pairing-token auth,
loopback-only registration, path-traversal guard, body-size cap; full spec
in `03-extension-crawler.md`'s security-requirements section) is unblocked
and can start immediately against the API surface above.
