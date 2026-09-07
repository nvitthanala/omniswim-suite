# Worklog — Phase 3: browser extension + import-UI wiring

Same purpose as the other worklogs in this folder: read this first if
resuming mid-Phase-3. Working from [04-phasing.md](04-phasing.md) "Phase 3".

## Status: DONE, with one recorded default decision and one recorded verification gap.

## Checklist

- [x] **Track A transport decided**: clipboard, not a localhost listener or a
  watched file (`03-architecture.md` §5's open question). Commit `e75a1c64`.
  Chosen to keep moving rather than block on asking — zero new
  infrastructure, no port, works even when the desktop app isn't running.
  Reversible if it proves wrong in practice.
- [x] **`extensions/swimcloud-companion/`** — Manifest V3 extension. Commit
  `e75a1c64`.
- [x] **`packages/swimcloud/src/clipboardPayload.ts`** — app-side reader,
  versioned, never throws. Commit `e75a1c64`. Caught its own bug before
  commit: `typeof [] === 'object'` in JS, so the initial shape check let an
  array payload fall through to a confusing `unsupported-version` rejection
  instead of `wrong-shape` — fixed with an explicit `Array.isArray` check.
- [x] **The real gap this phase actually needed to close, found while
  working it, not planned in advance**: `parseTeamRosterHtml` (Phase 1b)
  extracts name/class/hometown with no times, and this app's
  `Recruit`/`HistoricalSwim` types both require `event`/`time`/`timeType` —
  a roster member's presence here *is* their swim entries. Building
  `parseSwimmerProfileHtml` (personal-bests table) was the actual
  prerequisite for "add a roster member via SwimCloud link," not something
  `04-phasing.md` called out by name. Commit `878e5a38`.
- [x] **`packages/manager/src/lib/swimCloudImportBridge.ts`** — converts
  `SwimCloudPersonalBest[]` to `HistoricalSwim[]`. Commit `ad736c7f`. Found
  and fixed a real cross-package architecture bug before this ever reached a
  test: importing from the `@omniswim/swimcloud` package root (instead of
  its `/parser` subpath) drags `cache.ts`/`playwrightFetcher.ts` — and
  `node:fs/promises`/`playwright-core` — into a UI package's compile graph.
  Confirmed fixed not just by `tsc` but by a real `npm run build` of the
  shell app succeeding (see below).
- [x] **UI wiring**: a "From clipboard" button in `RosterImportWizard`,
  commit `e9c2323f`. Every failure mode in the read→validate→classify→parse→
  convert chain surfaces as a specific toast message.
- [x] Full suite green after Phase 3: 210 tests / 14 files, lint clean 8/8
  workspaces, `npm run build` (shell app) succeeds, at commit `e9c2323f`.

## What "done" does and doesn't mean here

**Structurally verified**: every file type-checks, the full unit suite
passes, and — this is the one that actually matters for the cross-package
bundling concern above — a real production `vite build` of the shell app
succeeds with no Node-builtin-in-browser-bundle errors.

**Not verified**: the button has never been clicked in a running app. I
considered using the `run` skill to launch the app and screenshot it, and
decided against spending the exploration budget that would take (this repo
has no existing project run-skill for it, and the click path to
`RosterImportWizard` — open a workspace, find the roster panel, open the
import wizard — isn't something I could navigate without first exploring
the app's own routing) against the marginal value, given two independent
structural checks (types + production build) already passed and the new
button reuses the exact same CSS classes and layout pattern as the
adjacent, already-working "SwimCloud" reference-toggle button verbatim. If
this turns out to have a layout problem, it's a five-minute fix once someone
actually looks at it — flagged here so that's a known possibility, not a
silent gap.

## What Phase 3 does *not* cover, on purpose

- **Team-roster captures have no UI path at all.** `parseTeamRosterHtml`'s
  output (name/class/hometown, no times) has no adapter to this app's
  swim-history-shaped model and none is planned — see the
  `parseSwimmerProfileHtml` commit's rationale. If a "quick add athlete to
  roster with no times yet" feature is ever wanted, that's a different,
  new concept in `packages/core`'s types, not something to bolt onto
  `HistoricalSwim`.
- **Meet-results captures aren't wired to any UI.** `parseMeetResultsHtml`
  exists and is tested (Phase 1b) but nothing in `packages/manager` calls
  it yet. That's a materially bigger piece of work — it needs a scoring-
  aware surface, not the roster importer — and wasn't in this round's scope.
- **Track B (the Playwright fetcher) still has never touched a live site.**
  Unrelated to Phase 3's UI work; tracked in the Phase 2 worklog. Nothing in
  Phase 3 changes that status.

## Log

- **2026-09-07** — All of the above done in one continuous session (no new
  agent spawned — same direct-execution approach as Phase 2, given the
  earlier Opus rate-limit hit and the value of continuity across a fast-
  moving, interdependent set of changes). Four commits, each independently
  verified (lint + full suite, and a production build for the two that
  touched UI/cross-package imports) before landing.
