# WORKLOG 12 — importing a whole roster's event history from a capture in one action

**2026-09-09, `executor`, direct dispatch.** This is the feature that makes
the whole crawl worth having: instead of a coach pasting one swimmer's
times page at a time, they pick a completed capture and one action pulls
in every rostered swimmer's history the crawl already fetched.

## The refactor, done properly

`handleClipboardTeamRoster` and `handleClipboardSwimmerTimes` (the existing
one-swimmer-at-a-time clipboard flow) had the roster-seeding and
per-swimmer-conversion logic inline. Rather than write a third copy for
the new bulk path, both were extracted into `packages/manager/src/lib/
rosterQueueImport.ts` (`seedRosterQueueFromAthletes`,
`convertAndAccountSwimmerTimes`, `markRosterQueueCaptured`, and the
composition `buildRosterImportFromCapture`), and the two existing handlers
were rewritten to call them — confirmed by the report: the old inline
`existingNames` Set, the manual queue-matcher loop with its closure-
captured `matchedNew`, and the skip-reason tally are all gone from
`RosterImportWizard.tsx`, replaced by calls into the shared module.

## The new capability

`SwimCloudCaptureRosterImportPanel.tsx` — a "Browse captures" entry point
next to the existing "From clipboard" button (same tier, not a
replacement). Fetches the pairing token and capture list the same way
Matrix's picker does (re-implemented, not imported — the two packages
can't depend on each other), lets the coach pick a capture and a
discovered roster, and shows the honest coverage **before** committing:
*"1 of 35 athletes have captured times · 34 will need a manual capture."*
One athlete's match is consumed at most once, so a name-only fallback
match can't double-claim a swimmer's times page.

**Gender handled as a real disagreement, not silently resolved**: a
roster's own stated gender and the wizard's scope can differ. Neither
overrules the other. The coach sees an inline warning badge before
importing, the action button itself says "Import anyway," and the
resulting preview's warning list states plainly which gender the swims
were recorded under.

**Graceful degradation preserved end to end**: an athlete with no matched
times page, or one whose page converted to zero usable swims (all leadoff
splits, say), stays in the roster queue unchecked — the existing "Capture
next swimmer" clipboard fallback still works for exactly these swimmers.
Already-in-workspace swimmers are recognized the same way the clipboard
path already recognizes them, not re-announced as new.

**A deliberate test-construction choice, disclosed plainly**: the real
swimmer-times fixture is an Auburn swimmer; the tests re-point it at a
real Henderson State roster athlete's real id specifically to prove the
matching is happening by id (the two real names don't overlap at all, so
a passing test can only mean the id branch fired). Every individual value
in the test is still real SwimCloud data — nothing was invented — but the
pairing across the two fixtures was constructed for exactly the coverage
this needed. Both test files say so in their own headers.

## Verified, independently re-confirmed after the agent reported

- `npx vitest run`: **683 passed, 0 failed**, 37 files (36 new).
- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npm run build -w @omniswim/shell`: succeeds.

No git operations.

## Status: both of the user's requested steps are now done

1. Read-only browse of captured rosters/swimmer-times (Phase 4b).
2. Roster + history import from a capture, in one action (Phase 4c).

Step 3 — the user hand-testing all of this in a real browser — is next,
by the user's own plan, not something to automate further.
