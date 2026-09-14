# WORKLOG 11 — retiring the synthetic swimmer-profile parser, and read-only browse

**2026-09-09, two agents, disjoint scope (`packages/manager` vs `packages/matrix`), in parallel.**

## 1. A real, live bug found and fixed (`packages/manager`)

While scoping the user's "roster imports" request, found a bug of the exact
same shape as the one that started this whole session: `RosterImportWizard`'s
clipboard flow called `parseSwimmerProfileHtml`, marked
**`Synthetic-fixture-only`** in its own doc comment — written for the base
`/swimmer/{id}/` page, which real captures now prove does NOT carry the
personal-bests table. That table lives on `/swimmer/{id}/times/`, already
parsed correctly by today's real, mutation-tested `parseSwimmerTimesHtml`.

**Fixed**: new `swimCloudSwimmerTimesToHistoricalSwims` bridge function,
using the real parser's explicit `relayLeadoff: boolean` field to exclude
relay legs (strictly more reliable than the old converter's
string-matching a stroke name). The dispatcher now routes the new
`swimmerTimes` URL-classifier kind to the fixed handler; a bare
`/swimmer/{id}/` capture gets a redirect message ("capture the Times tab
instead") rather than a doomed parse attempt. `parseSwimmerProfileHtml`
and the old `swimCloudPersonalBestsToHistoricalSwims` are `@deprecated`,
kept one round per this initiative's standing convention.

**A name-order inconsistency, found and stated plainly rather than
papered over**: the new converter emits `"Paulk, River J"` (family name
first, from `#swimmer-info`); the meet-results converter emits `"Colin
Candebat"` (display order). These two SwimCloud-sourced converters now
disagree, and the old (deprecated) converter used to agree with the
meet-results one — so this is a real behavior change at the call site,
not a pre-existing skew. Not silently normalized: the parser's own
"one name, one source" rule refuses to guess where to split a
comma-separated name (a two-word family name breaks any such guess), and
the bridge isn't the place to overrule that. The app's alias-suggestion
system (`athleteAliases.ts`, which keys on `canonicalSwimmerName` and does
fold `"Last, First"`) surfaces the resulting pair for a human to confirm —
correct behavior, but a coach who ignores the prompt gets two rows for one
swimmer. Flagged as a real, contained follow-up, not fixed here.

**A second real bug this same change introduced, caught and fixed in the
same pass**: `rosterQueueEntryMatches`'s name-fallback compared
`normalizeSwimmerName` on both sides. Against the new parser's name order,
a roster row with no linked swimmer id (`"Katie Batts"` vs `"Batts,
Katie"`) would silently never check off — no error, just a permanently
stuck queue entry. Fixed by switching the fallback to
`canonicalSwimmerName`, which folds the order difference. The id-matching
branch above it — what actually answers for every athlete in the real
capture — was untouched.

**A fabrication caught by its own test, not shipped**: the agent's report
states plainly that its first draft of the converter's spot-check test
used times written from memory rather than read from the fixture; the
test failed, and the numbers were corrected against the raw markup before
anything was called done. Recorded here because that is exactly the
failure mode `CLAUDE.md`'s data-provenance rules exist to catch, and the
reason it didn't ship is the test, not restraint.

## 2. Read-only browsing of rosters/swimmer-times (`packages/matrix`)

Two collapsed-by-default sections added to `SwimCloudCapturePicker.tsx`,
below the existing team/gender import checklist: "Rosters in this capture"
(team/gender/season/count, expands to the athlete list) and "Swimmer times
in this capture" (name/count, expands to the personal-bests table). Both
fully omitted when empty. Swimmer names render in their real printed
order with a tooltip explaining why, rather than being silently
reformatted. No import actions — browsing only, per scope; the actual
import capability is Phase 4c, next.

## Verified (independently re-confirmed after both agents reported)

- `npx vitest run`: **647 passed, 0 failed**, 35 files.
- `npm run lint --workspaces --if-present`: all 8 workspaces clean.
- `npm run build -w @omniswim/shell`: succeeds.

No git operations.

## Next: Phase 4c

The big remaining piece — importing a whole roster's swimmers' event
histories from a completed capture in one action, instead of one
clipboard paste per swimmer — was blocked on this bug fix landing (both
touch the same manager files). Unblocked now; dispatching next.
