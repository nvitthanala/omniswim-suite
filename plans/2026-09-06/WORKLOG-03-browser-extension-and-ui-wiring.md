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

**Update, 2026-09-07 — visually verified too.** Initially deferred this (no
existing project run-skill, and the click path wasn't obvious without
exploring the app's own routing first), but came back to it once a
Chromium binary was installed for the Phase 2 local smoke test anyway.
Started the real dev server (`npm run dev`), drove it with headless
Playwright against `http://localhost:3000/manager`, clicked the actual
"Import roster" button, and screenshotted the result. Screenshots saved in
[`verification-screenshots/`](verification-screenshots/):

- `import-wizard-with-clipboard-button.png` — the wizard open on its paste
  step, "From clipboard" rendering cleanly in the tab row next to the
  existing Paste/CSV/SwimCloud tabs, no layout breakage.
- `clipboard-button-closeup.png` — close crop, confirms it matches the
  adjacent "SwimCloud" toggle's styling exactly.
- `clipboard-button-toast-no-team.png` — clicked "From clipboard" with no
  team selected; the exact toast text from the handler
  ("Select or enter a team name first.") appears, confirming the click
  handler is wired up and actually reads component state, not just that
  the button exists.

Zero console/page errors across every run. Reaching the next branch (filling
the team field, then hitting the "could not read clipboard" toast) was
flaky in the throwaway verification script itself — the typed value didn't
reliably stick before the next click — not chased further, since the two
facts that actually mattered (renders correctly; click handler genuinely
fires and reads real state) are both now confirmed with evidence.

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

## Code review pass (2026-09-07, after Phase 3 landed)

Ran `/code-review medium` against the full branch diff. 8 findings surfaced;
3 were real, verified bugs and are fixed in commit `1e098d28` (with
regression tests proven to fail against the pre-fix code, then pass after —
see that commit for the full account): a `did-not-compete` entry inflating
`lostPlaces` in the NCAA engine, a silently-dropped place `"0"` in the
SwimCloud parser, and a `"Yard"`-labeled personal best silently discarding a
contradictory course column. One more (a Zod schema's `source` enum not
updated when `HistoricalSwim.source` gained `'swimcloud'`) was a real,
currently-latent gap, also fixed there.

Four findings reviewed and **deliberately not fixed**, recorded here per
this repo's "report, don't fix, outside scope" rule:

- **A tie straddling a point table's boundary gets two different per-place
  `reason` values** (e.g. a 2-way tie for places 6–7 on a 6-place table:
  place 6 gets `reason: null` — a genuine table zero — place 7 gets
  `reason: 'place-outside-point-table'`). Reviewed and judged **not a
  bug**: the two tied swimmers get different numeric `place` values (6 and
  7), and those two *slots* genuinely have different provenance — one is
  in the table and worth 0, the other isn't in the table at all. The shared
  `points` value (0 for both, correctly split) is what actually matters and
  is correct. Changing `reason` to always agree within a tie would conflate
  two real, different facts to make the output look tidier — not worth it.
- **Two non-interoperating scoring engines now coexist in `packages/core`**
  (this session's new `computeNcaaEventScoring`/`ncaaScoringRules.ts`, and
  the pre-existing `calculatePoints`/`utils.ts` pipeline `scoringTheory.ts`
  uses). This was a deliberate Phase 1 design choice, not an accident — see
  the Phase 1a commit — and reconciling them (or deciding one supersedes
  the other) is real, separate design work belonging to whichever feature
  next needs both to agree, not a fix-up here.
- **The "Meter"-is-ambiguous course-detection rule is independently
  reimplemented in three places**: `packages/swimcloud/src/parser.ts`
  (twice — meet-heading and personal-best row parsing) and
  `packages/core/src/lib/cutlineEventNames.ts`. All three currently agree
  in practice (compared by hand); consolidating would mean either breaking
  the deliberate `packages/core` ↔ `packages/swimcloud` isolation
  (`03-architecture.md` §1) or introducing a new shared micro-package —
  both bigger calls than this round should make unilaterally.
- **`urlClassifier.ts`'s five resource-kind branches repeat a similar
  missing-id/invalid-id validation shape by hand.** A real cleanup
  candidate, but `classifySwimCloudUrl` already carries 63 tests covering
  every branch, which is strong regression coverage against exactly the
  copy-paste-typo risk this finding warns about. Lower priority than the
  four items above.

## Log

- **2026-09-07** — All of the above done in one continuous session (no new
  agent spawned — same direct-execution approach as Phase 2, given the
  earlier Opus rate-limit hit and the value of continuity across a fast-
  moving, interdependent set of changes). Four commits, each independently
  verified (lint + full suite, and a production build for the two that
  touched UI/cross-package imports) before landing.
