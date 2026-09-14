# Open questions

Each needs a real page capture. None may be closed by reasoning, per this
package's own discipline.

**OQ-1 — RESOLVED (2026-09-08), with a follow-up.** The meet root's Teams
card does truncate on a real meet: a 13-team capture (379295, MPSF
Championships) shows only 5 rows, and — unlike the original 4-team capture
— carries a `More` link to a previously-unmodelled resource,
`/results/{meetId}/topteams/?gender={M|F}`. See
[01-decisions.md](01-decisions.md)'s "OQ-1 update" for the full finding.
This settles the *does it truncate* question and gives team discovery a
real primary mechanism instead of only a fallback.

**OQ-1b — RESOLVED (2026-09-08).** Does the `topteams` page itself list
literally every competing team, and what is its markup? Both gender
variants were captured directly
(`tests/fixtures/swimcloud-real-meet-topteams-379295-gender-{m,f}.html`).
Result: yes — 13 of 13 teams on both, including 7 (men) / 3 (women)
zero-scoring teams shown with rank/score "–" rather than omitted. Markup
is the same table shape `parseMeetTeamsHtml` already reads on the meet
root. `parseMeetTopTeamsHtml` is now buildable at
`real-capture-verified` confidence — see
[01-decisions.md](01-decisions.md) and
[04-parsers-and-fixtures.md](04-parsers-and-fixtures.md). Team discovery
for the meet subject no longer blocks Phase 1 at all; the meet-root-links
fallback remains only as defense-in-depth for a `topteams` failure case.
Residual caveat (not blocking, just honest): "13 of 13" is one meet's
evidence that this page doesn't truncate — see OQ-8 on capping crawls
regardless.

**OQ-2 — What does `/team/{id}/results/` actually look like, and what does
`?year=` take?** Blocks the entire team subject and the "current season"
definition. No parser, no fixture, an unconfirmed URL pattern. Needs two
captures: the default view and one with `?year=` set.

**OQ-3 — Real roster markup.** `parseTeamRosterHtml` is synthetic-only.
Needs `/team/58/roster/`, plus one with a gender filter applied, to settle
the `gender` parameter encoding that `SwimCloudTeamRosterQuery` explicitly
refuses to guess.

**OQ-4 — Real swimmer-profile markup.** `parseSwimmerProfileHtml` is
synthetic-only, and `WORKLOG-03` already found it importing a relay leg's
split as a personal best.

**OQ-5 — RESOLVED BY DESIGN (2026-09-08), replaced by a sharper residual
question.** The original question — do extension fetches carry the
SwimCloud session — assumed the crawl might run from the background service
worker. It doesn't: see
[03-extension-crawler.md](03-extension-crawler.md)'s "Where the crawl loop
actually runs" correction. The crawl loop runs in the content script,
fetching same-origin URLs from the page it's already injected into — this
is definitionally the user's own session, no different from clicking a
link, and needs no empirical test to confirm.

**What remains open, and genuinely can't be resolved by reasoning:** could
SwimCloud's own anti-automation detection distinguish a burst of same-origin
`fetch()` calls from a loaded page from the same URLs reached by normal
click-navigation? Some sites fingerprint request timing/headers/patterns,
not just origin and cookies. The 3-second `SwimCloudPoliteFetcher` pacing
(reused unchanged, per D1) is the mitigation already in the design; whether
it's sufficient is answerable only by running the first real crawl and
watching for a challenge page or a block. Record the answer in the Phase 3
worklog the first time this runs for real.

**OQ-6 — Does the pagination widget shape change on the last page?**
`nextPageHref` is documented as absent on the last page, but only page 1
has been seen. Fixture F3 settles it.

**OQ-7 — Send the SwimCloud permission email?** Carried forward from
`plans/2026-09-06/04-phasing.md` open question 3, and now weightier: this
round multiplies request volume by roughly 60×. The ToS's own escape hatch
(`support@swimcloud.com`) is the actual fix for the risk D1 accepts.

**OQ-8 — Should there be a hard per-crawl page cap?** Not decided. A
40-team invitational could plan 640 pages / 32 minutes. A cap is the
difference between a bounded tool and a crawler. Recommended default: 400
pages per crawl, requiring explicit confirmation to exceed — but this is a
user decision, not a planning decision.

**OQ-9 — New, minor, non-blocking.** Meet 379295's events sidebar shows a
nested-id URL shape, `/results/{meetId}/event/{n}/{subIndex}/` (e.g.
`/event/41/0/` and `/event/41/1/`, two different events sharing printed
number "41"), which `urlClassifier.ts`'s `meetEvent` resource does not
model — it only handles the one-segment form and would classify this as
`unrecognized`. Does not block this plan (the crawl never visits
`meetEvent` pages), but whoever next touches that resource kind should
know it undercounts real event-page shapes.
