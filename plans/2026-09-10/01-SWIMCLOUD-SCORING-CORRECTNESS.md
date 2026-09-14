# SwimCloud meet import: scoring correctness audit and fix

**Date:** 2026-09-10
**Trigger:** user report after a real crawl-and-import: "said 188 warnings,
populates but it is not clean, does not identify prelims vs finals results
... exhibition swims are not scored ... make sure the point numbers are
correct."

This doc records what was checked, what was found (with evidence from the
real archived fixture, not guessed), what was fixed, and what is still open.

## 1. What "188 warnings" actually is

`SwimCloudCapturePicker.tsx` shows `Parsed with ${warnings.length} warning(s)
— see console.` `warnings` comes from `parseCapture` in
`apps/shell/lib/swimcloudCaptureRoutes.ts`, which appends one line per
`SwimCloudParseWarning` across **every page in the whole capture** — every
roster page, every swims-list page, every swimmer-times page, for both
genders. A 42-team-page + swims-list crawl easily produces this many lines.

Most of these are expected, not defects. The dominant contributor is almost
certainly `relay-legs-absent`: SwimCloud's swims-list page does not publish
relay legs at all, so every relay row fires this warning by design (see
`parser.ts`'s own doc comment on that code). A bare count with no breakdown
makes 188 look alarming when most of it is normal structure. **This is a UI
gap, not proof the parse is broken** — see §5.

## 2. The real bug: prelims and finals are unlabeled, undifferentiated rows

Confirmed directly against the archived real fixture
(`tests/fixtures/swimcloud-real-meet-team-swims-356467-team58-page1.html`,
Henderson State men, page 1 of 8):

- The table's columns are `Name | Event | Time | Flags | Imp | Place | Pts` —
  **no round or session column at all.**
- A swimmer who swam an event in both prelims and finals gets **two separate
  rows**, identical in every column except time/place/pts/swim-id. Measured
  on this one 30-row page: **6 such groups, 13 of 30 rows (43%)**:

  | Swimmer | Event (label) | Swims |
  | --- | --- | --- |
  | Avery Henke | 100 Y Breast | 54.09 (1st, swim 171560736), 54.27 (1st, swim 171560737) |
  | Oskar Cebula | 100 Y Breast | 54.86 (1st, swim 171561833, `event/100/`), 55.45 (6th, swim 171560731, `event/26/`), 55.48 (5th, swim 171560730, `event/26/`) |
  | Nojus Skirutis | 200 Y Fly | 1:47.40 (2nd, swim 171561460), 1:47.77 (1st, swim 171561459) |
  | Olivér Pózvai | 100 Y Free | 44.44 (2nd, swim 171560864), 44.91 (4th, swim 171560863) |
  | Colin Candebat | 100 Y Fly | 47.82 (1st, swim 171561402), 47.86 (1st, swim 171561403) |
  | Camden Mask | 100 Y Breast | 55.52 (17th, swim 171560743), 55.66 (unplaced, swim 171560742) |

- **The `Place` column is a per-round placement, not the event's true field
  placement.** Proof: Nojus Skirutis's *faster* swim (1:47.40) is marked
  "2nd"; his *slower* swim (1:47.77) is marked "1st". That is impossible
  under one ranking — it is only consistent with two separate pools (a
  prelims heat and a finals heat) each computing "place" independently.
  Trusting this column as the true meet place, as the bridge did, is wrong
  for any event contested in more than one round.
- **SwimCloud's numeric `event/{n}/` id does not identify a labeled event
  1:1.** Oskar Cebula's three "100 Y Breast" swims split across two
  different ids (`event/26/`, `event/100/`) — the id tracks a results page,
  not a round or a stroke/distance. A fix that groups duplicates by event id
  alone would miss this case; it must group by the event's printed label.

### Why this produced wrong points, silently

`packages/core`'s scoring engine (`utils.ts`) classifies every row's round
via `classifyRoundTier(roundSwam)`, and `canScoreAthlete` uses that tier to
decide whether a row is scored (prelims of a normal event: no; finals:
yes; unknown tier `'UNK'`: **yes, same as a real final** — this is the
correct default for a source that always disambiguates rounds, like the PDF
pipeline, where an unlabeled row is a canonical/what-if row, not a real
result).

`swimCloudMeetImportBridge.ts` never set `roundSwam` on a SwimCloud row, so
every row — including every duplicate prelims-and-finals pair above — came
in as tier `'UNK'` and was scored as an independent, fully valid finish. A
swimmer who made finals in one event was, in effect, being scored twice
(sometimes three times) for it, using a "place" that was never the real
field placement to begin with. This is exactly the "wrong in a lot of
places" the user reported, and it produces no parser warning at all — the
rows parse cleanly; the *scoring* of them is what's wrong.

## 3. Exhibition swims — audited, correctly isolated, still unverified

`packages/core/src/lib/ncaaScoringRules.ts` already implements Rule 7-10-1
correctly: exhibition entries are removed from consideration before place
computation (`NcaaEntryStatus = 'scoring' | 'exhibition' | ...`).

On the SwimCloud parser side (`packages/swimcloud/src/parser.ts`), two
unrelated concepts both use the letter `X` and are kept correctly separate,
by doc comment and by code path:

- `readTime`'s exhibition detector: a leading `X` on a *time token*
  (`X:58.32`), the Hy-Tek convention. Explicitly commented **"Unverified for
  SwimCloud specifically."**
- The swimmer-times personal-bests page's `X` badge chip, `title="Extracted"`
  — a *different cell*, meaning "SwimCloud extracted this time from a PDF,"
  unrelated to exhibition status. The doc comment at `SwimCloudSwimmerTimesTag`
  says outright: "`X` here is not the Hy-Tek exhibition marker."

No cross-contamination was found between the two. **What remains open:**
neither committed real fixture contains a confirmed real exhibition swim, so
the Hy-Tek leading-`X` detector has never been checked against actual
SwimCloud markup. It is entirely possible SwimCloud marks exhibition swims
some other way (a badge, like `D2 B` and `Leadoff` already are) that this
parser does not look for at all — see §6.

## 4. The fix (landed this pass)

`packages/matrix/src/lib/swimCloudMeetImportBridge.ts`,
`swimCloudTeamMeetSwimsToSwimmerResults`:

- Groups swims by `(athleteName, teamName, event.label)` — **label, not
  event id** — per the Oskar Cebula finding above.
- Any group with more than one non-leadoff swim is excluded **in full**
  from `men`/`women`. Nothing picks a "winner" between the duplicates by
  time, by place, or by which swim id is larger — every one of those is a
  guess this codebase's own provenance rules forbid for competition data
  (`CLAUDE.md`: "Never interpolate, extrapolate, project, or estimate").
- Each excluded swim is reported through a new
  `SwimCloudMeetImportSkipReason`, `'ambiguous-round-duplicate'`, carrying a
  new optional `detail` field naming the swim's time, place, and SwimCloud
  swim id, so a coach can look it up on the event's own results page
  (`/results/{meetId}/event/{n}/`, which SwimCloud does label
  "Preliminaries"/"Finals" — see §6) and resolve it by hand.

**Effect on the real fixture:** of 30 rows, 3 are relay-leadoff splits (as
before) and now 13 more are excluded as ambiguous duplicates — 16 of 30
excluded, 14 converted. The team's score for this page is now *missing*
points for the six affected events rather than *wrong* — an intentional
trade under "absent ≠ empty": a coach who sees a flagged gap can go check it;
a coach looking at a silently-inflated total cannot tell anything is wrong.

**Tests:** `tests/swimCloudMeetImportBridge.test.ts` — rewrote the six
real-capture assertions that depended on the old (bugged) row counts, and
added a new `describe` block of 7 synthetic-fixture unit tests exercising
the grouping logic directly (single swim untouched; two-swim group excluded
both sides; two different swimmers not falsely grouped; cross-event-id
grouping by label; `detail` field content; a leadoff never joining the
group). 37/37 tests in the file pass; full suite 697/697 pass.

## 5. Follow-up: the warning count needs a breakdown — ✅ DONE 2026-09-13

`SwimCloudCapturePicker.tsx`'s toast (since replaced by `SwimCloudCaptureBrowser`)
and `OpsModule.tsx`'s console-only `console.warn` calls treated every warning
and every skip reason as equally alarming, and surfaced skip reasons
(including `'ambiguous-round-duplicate'`) only in the console. Fixed:
new `SwimCloudImportDiagnosticsPanel` (`packages/matrix/src/components/`)
+ `swimCloudImportDiagnostics.ts`, wired into both `OpsModule.tsx` import
paths. `result.skipped` is grouped by `reason`, with
`'ambiguous-round-duplicate'` always shown expanded and named (event,
swimmer, detail) rather than a bare count. Warnings are grouped by code
for the clipboard path, which has them structured; the capture-browser
path only has pre-formatted strings (`/parse`'s own response shape), so it
gets a flat, still-visible list rather than a by-code split — that would
need a route-contract change, not attempted this pass. See
`docs/reference/SWIMCLOUD_CAPTURE_STATE.json` OQ-11.

## 6. The real fix: parsing the per-event results page — F9 now captured, confirmed

> **✅ DONE 2026-09-10.** Everything this section scopes below is built and
> verified — see `docs/reference/SWIMCLOUD_CAPTURE_STATE.json` phase "11" for
> the full account (parser, meet-scoped bounded-concurrency crawl, bridge
> resolution, route wiring) and its own list of stated deviations (diving,
> single-round timed finals, DQ/scratch, relays, and pagination all remain
> unverified against real markup, by design — absent, not guessed). The
> "ready for `executor`, not yet started" framing below is historical; kept
> as the original scoping record, not a live task list.

The interim fix in §4 trades "silently wrong" for "visibly incomplete." The
real fix is to stop needing the swims-list page to disambiguate rounds at
all — and the user, pushing back directly on §4's "we can't know which round
this is," captured the missing page themselves on 2026-09-10:
`tests/fixtures/swimcloud-real-meet-event-356467-event26.html` (fixture F9,
`https://www.swimcloud.com/results/356467/event/26/`, the exact event Avery
Henke's duplicate rows came from). **Full findings are in that fixture's own
header comment** — read it before writing any code against it. Summary:

1. **One page per "Finals"-labeled event holds every round**, each a
   `<div class="o-table-group"><table>...<caption>ROUND</caption>` block, in
   program order. Event 26 ("100 Breast Men Finals") has four: A Final, B
   Final, C Final, Preliminaries.
2. **The caption text maps directly onto the existing `classifyRoundTier`**
   (`packages/core/src/lib/utils.ts`) — "A Final"→'A', "B Final"→'B',
   "C Final"→'C', "Preliminaries"→'PRE'. No new round vocabulary needed;
   feed the caption straight into `SwimmerResult.roundSwam`.
3. **A/B Final tables carry the real meet Score** in a `u-is-hidden` `<td>`
   (hidden from rendering, present in markup) — the first page type in this
   pipeline with genuine per-swim meet points. C Final/Preliminaries carry
   `Pts` (the SwimCloud power index) instead, matching those rounds not
   scoring here.
4. **Exhibition is marked in the rank cell**, replacing the ordinal with
   `<span title="Exhibition">X</span>` — not the leading-`X`-on-time-token
   Hy-Tek guess `readTime` currently makes (§3). That guess needs correcting
   once this page type is parsed; do not keep both conventions live without
   knowing which one, if either, real SwimCloud swims-list markup actually
   uses.
5. This directly resolves the running example: Henke's "A Final" (54.27,
   1st, score 20) and "Preliminaries" (54.09, 1st) rows are now genuinely
   distinguishable, and Oskar Cebula's team-swims-list group correctly splits
   into an A Final row (55.45, score 13) and a Preliminaries row (55.48) —
   but his *third* swims-list row (54.86, `event/100/`, no "Finals" suffix)
   is NOT on this page at all. It sits under a separate, unrelated numeric
   event id this meet's own sidebar lists alongside similarly-unlabeled ids
   (100, 101, 102, 201, 202, 300, 400, 402, 403, 500, 501, 503, 938, 939) —
   all higher than the real numbered program (1–42). This matches
   `packages/core/src/lib/utils.ts`'s already-documented finding that HyTek
   numbers post-meet time-trial sessions above the scored program with no
   giveaway suffix (`isOutsideScoredProgram`/`scoredEventNumberMax`). Treat
   Cebula's third row as a likely time-trial swim, not a third real round,
   until/unless that page is captured and says otherwise — do not guess.
6. The gender toggle on this page type is confusingly numbered (switching
   "Men"→"Women" on event 26 points at `event/400/`, not a nearby id) — read
   gender from the toggle's active label text, same discipline the
   team-swims parser already uses, never from event-id arithmetic.

### Scoped build (ready for `executor`, not yet started)

1. **New parser** (`packages/swimcloud/src/parser.ts` or a sibling file):
   parse each `o-table-group` into `{ round: string; rows: [...] }` for a
   given event page, against the F9 fixture. Reuse `readTime`/`readPoints`-
   style helpers where the cell shapes match; do not duplicate their ~40
   lines. Correct the exhibition detector per point 4 above once this page's
   real convention is confirmed — check the rank cell's `title="Exhibition"`
   span, not a leading `X` on the time.
2. **Meet-scoped, not team-scoped, fetching**: one event page covers every
   team's swimmers in that event, so a crawl of a whole meet must fetch each
   *unique event id* exactly once, not once per team. Discover the set of
   event ids from the team-swims-list captures already being fetched (each
   `SwimCloudTeamMeetSwim.event.eventId` names its `/event/{n}/` page).
3. **Parallelized, bounded fetching** — the user's explicit ask: "make sure
   its parallelized and works fast, almost instant if needed... be
   intelligent so that big meets dont take long to export." Reuse the
   existing bounded-concurrency pool (`extensions/swimcloud-companion/src/boundedFetchPool.ts`,
   currently 3 lanes / 400ms stagger for swimmer-times fetches, wired in
   Phase 5 — WORKLOG-09) rather than inventing a second concurrency
   mechanism; widen the lane count only if the existing politeness stagger
   still leaves this fast enough in practice — don't remove the stagger
   outright without checking whether that risks the same anti-automation
   detection concern already on file for Track B (OQ-5).
4. **`meetEvent` urlClassifier resource kind already exists** — confirm
   whether it is on `apps/shell/lib/swimcloudCaptureRoutes.ts`'s
   `isParseableResourceKind` allowlist (it likely is not yet, since nothing
   parsed it before now) and add it there. `OpsModule.tsx`'s clipboard path
   currently toast-blocks `meetEvent` captures outright ("That page only
   shows a summary of the meet...") — that block is now wrong and needs
   updating once a parser exists, but the picker/crawl path is the primary
   consumer; the clipboard path is secondary.
5. **Rewrite `swimCloudTeamMeetSwimsToSwimmerResults`'s duplicate handling**:
   once an event-page parse is available for a swim's event, resolve
   `roundSwam` (and, for A/B Final rows, the real `pdfPoints`/meetScore)
   from it instead of excluding the group. Keep the §4
   `'ambiguous-round-duplicate'` exclusion as the fallback for a swim whose
   event page was not captured or not parseable — never regress to
   guessing when the real data is simply absent from this capture.
6. Update/extend `tests/swimCloudMeetImportBridge.test.ts` and add a new
   parser test file against F9, following the existing real-capture-test
   pattern.

This is core-complexity, scoring-correctness and extraction-pipeline work —
route it through `executor` per this repo's delegation contract, briefed
directly off this document's §2 and §6 plus the F9 fixture's own header
rather than re-derived from scratch.

## Files touched this pass

- `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` — the fix (§4).
- `tests/swimCloudMeetImportBridge.test.ts` — updated real-capture
  assertions + new synthetic unit tests for the new logic.
- This document.

No changes to `packages/swimcloud/src/parser.ts` this pass — the underlying
parse of each row was already correct and already documented as
round-blind; the fix belongs at the conversion-to-scoring layer, which is
where the false assumption ("place = field place", "no round = fully
scoring") actually lived.
