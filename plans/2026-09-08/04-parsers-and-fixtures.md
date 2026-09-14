# Parser and entity work

## Reused unchanged

**`parseTeamMeetSwimsHtml`** — the only `real-capture-verified` parser, and
the one the meet crawl depends on entirely. No changes. Its `pagination`
output is already exactly what the crawl planner needs.

**`swimCloudTeamMeetSwimsToSwimmerResults`** and **`mergeSwimCloudResults`**
in `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` — no changes. The
import path stays identical; only the source of the HTML changes. This
matters: the `Pts`-is-a-power-index finding and the `'meet-score-column'`
default are hard-won and must not be re-derived.

## New, buildable today

**`parseMeetTeamsHtml(html, context)`** in `parser.ts`. Extracts every
distinct `/results/{meetId}/team/{teamId}/` link and its printed team name
from a meet-root capture, classified through `classifySwimCloudUrl` (never
regex-matched by hand), plus the page's active gender word using the same
`readActiveGenderWord` helper `parseTeamMeetSwimsHtml` already uses.

Its confidence reporting is deliberately split in two, and this is the
honest form:

- `confidence: 'real-capture-verified'` — its selectors are exercised
  against `tests/fixtures/swimcloud-real-meet-landing-356467.html`, which is
  real markup.
- A separate `discoveryCompleteness: 'unproven'` on the returned value —
  because "these links are real" and "these are all the teams" are
  different claims and only the first has evidence.

This mirrors `parseTeamMeetSwimsHtml`'s own precedent, whose doc comment
already says reporting `real-capture-verified` "does not say the page holds
every swim."

**`crawlPlan.ts`** — pure planner, described in
[03-extension-crawler.md](03-extension-crawler.md). New module, no parser
changes.

## New, buildable today (added 2026-09-08, F1b resolved)

**`parseMeetTopTeamsHtml`.** `/results/{meetId}/topteams/?gender=` — the
full team-standings page discovered via the meet-root Teams card's "More"
link (OQ-1) and now directly captured on both genders
(`tests/fixtures/swimcloud-real-meet-topteams-379295-gender-{m,f}.html` —
see [01-decisions.md](01-decisions.md)'s OQ-1b resolution). Its row shape
is the same table `parseMeetTeamsHtml` already reads on the meet-root
landing page — same classes, same rank/link/name/score columns — so this
parser reuses that row-extraction logic rather than duplicating it. Both
fixtures show every one of the meet's 13 teams, including the ones with a
rank/score of "–" (zero-scoring, not omitted).

`confidence: 'real-capture-verified'`, no caveat needed on the row
extraction itself. One honest caveat stays on *completeness*: "13 of 13
matches the ld+json count" is one meet's evidence, not proof this page
never truncates on a much larger field — see OQ-1b's note in
[01-decisions.md](01-decisions.md) and OQ-8 (page-cap) in
[08-open-questions.md](08-open-questions.md).

Also needed: a new `meetTopTeams` resource kind in `urlClassifier.ts` for
this path, alongside the existing `meetTeam`/`meetTeamSwims` kinds — same
shape, new leaf segment. Not yet written; straightforward given the
pattern is confirmed.

## Needs real markup before it can be trusted

| Thing | Status | Blocked on |
| --- | --- | --- |
| `parseTeamRosterHtml` | `synthetic-fixture-only`. Never seen a real roster page. | A real `/team/{id}/roster/` capture |
| `parseSwimmerProfileHtml` | `synthetic-fixture-only`. Never seen a real profile. | A real `/swimmer/{id}/` capture |
| `teamResults` season listing | **No parser exists at all.** `/team/{id}/results/?year=` is an unconfirmed URL pattern with unconfirmed markup. | A real capture, plus a second one at a different `?year=` |
| "current season" definition | **Cannot be written.** | The above |

On "current season": the user asked for a concrete, real-verified
definition. **There is none available, and inventing one is out of
bounds** — `urlClassifier.ts`'s `SwimCloudTeamResultsQuery` says the `year`
parameter is "carried verbatim as strings and not interpreted," and its
header says the whole `/team/` family is unconfirmed. Nobody has seen
whether `?year=` takes `2026`, `2026-2027`, a season id, or something else,
or what the page prints when the parameter is omitted. Candidate
definitions to test *against a real capture*, never to pick blind:

- (a) the page's default view with no `?year=` — if SwimCloud's own default
  is the current season, that is the answer and it needs no logic;
- (b) the highest `?year=` value the page's own season selector offers;
- (c) the season containing today's date under a stated academic-year rule.

(a) is most likely and cheapest, and it makes the crawl bound itself with no
client-side season arithmetic. But it is a guess until someone captures the
page. This is **OQ-2** in [08-open-questions.md](08-open-questions.md).

Until then, the team-subject crawl bounds itself the only honest way
available: the extension shows the meets it found and the user confirms
which ones to capture, with the page's own default view pre-selected. One
click never walks a program's whole history, because the crawl only ever
fetches from a confirmed list.

## Retired

**`parseMeetResultsHtml`.** Proven not to describe any real SwimCloud page:
`parser.ts`'s header, `index.ts`'s header, and a pinned regression test
(`tests/swimcloudParser.test.ts`, "regression: its page shape is not real")
all record it.

Retirement in three steps, deliberately not one commit:

1. **Re-point the one live call site.**
   `packages/manager/src/components/RosterImportWizard.tsx`'s
   `handleClipboardMeetResults` calls it today. Re-point it at
   `parseTeamMeetSwimsHtml`, and route the resulting
   `SwimCloudTeamMeetSwim[]` through the Manager bridge the way
   `swimCloudMeetResultsToHistoricalSwims` handles the old shape. **This is
   the last user-reachable path to the dead page shape and is the only part
   of this plan that is strictly a bug fix.** Do it first, independent of
   everything else.
2. Mark `parseMeetResultsHtml` `@deprecated` with the reason and the date.
   Keep the export for one round — `CLAUDE.md`'s additive-API rule.
3. Delete it, `SwimCloudMeetResultsParse`, `SwimCloudMeetResultsParseOptions`,
   `SwimCloudParsedEvent`, `swimCloudMeetResultsToSwimmerResults`,
   `swimCloudMeetResultsToHistoricalSwims`, and the three synthetic
   fixtures, in a later, separate commit.

One thing to check before step 3, flagged so it is not discovered as a
surprise: the synthetic meet-results fixtures are currently the main
exercise of the generic table reader and the points/place-token edge cases
(a printed `"0"` place, a contradictory course column, an empty event).
Deleting them may drop real coverage of shared helpers. Either re-home those
cases onto the real fixtures first, or keep the synthetic fixtures with a
header saying they test the helpers, not a page shape.
