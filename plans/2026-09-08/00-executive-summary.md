# Executive summary

## The symptom

A coach clicks "Copy for Omniswim" on a SwimCloud meet page, then "+ from
SwimCloud" in Matrix, and gets an error instead of a meet.

## The state of that bug, measured, not assumed

The original bug report assumed Matrix's import routes a meet capture to
`parseMeetResultsHtml`. In the current working tree, it does not.
`packages/matrix/src/components/OpsModule.tsx`'s `handleSwimCloudImport`
(~line 430) already refuses a bare `/results/{meetId}/` capture and emits a
toast telling the coach to go find `/results/{meetId}/team/{teamId}/swims/`
by hand.

Two facts follow, and both matter:

1. The Matrix path fails **honestly**, not silently. That is the codebase
   working as designed.
2. The remaining live routing of a meet capture to `parseMeetResultsHtml` is
   in **Manager**, not Matrix: `packages/manager/src/components/RosterImportWizard.tsx`'s
   `handleClipboardMeetResults` (~line 305) still calls it. That is the one
   place the known-dead page shape is still reachable by a user. Fixed in
   this round, independent of everything else — see
   [04-parsers-and-fixtures.md](04-parsers-and-fixtures.md) "Retired," and
   Phase 0b in [07-phasing-and-delegation.md](07-phasing-and-delegation.md).

## Why the fix is not a fix

The honest error is unusable at real scale.
`packages/swimcloud/src/urlClassifier.ts`'s `meetTeamSwims` doc comment and
`tests/fixtures/swimcloud-real-meet-team-swims-356467-team58-page1.html`'s
header both record the arithmetic: the swims list paginates at 30 rows and
splits by gender with no combined view. Henderson State alone at meet 356467
is 8 pages × 2 genders = 16 clicks. Four teams competed. A full meet is
~64 manual captures. `OpsModule.tsx`'s own comment already says one team at
a championship meet is 16 captures.

So the ask is not a parser fix. It is: one click captures the whole dataset.

## What this round builds

1. The browser extension gains an auto-fetch crawl. One click on a meet or
   team page enumerates and fetches every page needed, paced and
   politeness-checked, with visible progress and a cancel button.
2. Captures land in a machine-global capture store on disk, not the
   clipboard.
3. Matrix's "+ from SwimCloud" gains a picker that browses that store,
   replacing the clipboard paste as the primary path.

## What this round deliberately does not build

- The **team** capture scope (roster → every swimmer profile, plus a
  season's meets) is designed here but **gated on real page captures that do
  not exist**. Three of its page shapes have never been seen. Building
  against them would be exactly the guess this package's every file header
  forbids.
- Nothing about the Playwright track changes. It stays scaffolded and
  unused.
- No change to `packages/core` scoring, and no new "bare athlete" data-model
  concept (still out of scope, same as `WORKLOG-03`).
