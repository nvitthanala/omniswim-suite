# Decisions on record

Format follows [`plans/2026-09-06/01-legal-and-access-strategy.md`](../2026-09-06/01-legal-and-access-strategy.md)
§4: what was decided, when, by whom, what was shown before deciding, and
what was explicitly accepted.

## D1 — The extension auto-fetches. Decided 2026-09-08, by the user, directly.

**What.** After one click, `extensions/swimcloud-companion` issues further
HTTP requests to swimcloud.com on its own, from the user's own logged-in
browser session, without the user navigating to each page.

**What the user was shown first.** That `extensions/swimcloud-companion/README.md`
calls the current zero-network extension "Track A" and says, verbatim, that
a version which grows an auto-import mode "would be a materially different
thing — Track B, not Track A." That `plans/2026-09-06/03-architecture.md`
§2 says the same and calls out this exact scenario. That
`01-legal-and-access-strategy.md` §3 quotes the SwimCloud Terms clause —
"Use any robot, spider, or other automatic device, process, or means to
access the Website for any purpose" — with no personal-use carve-out.

**What was accepted.** That an auto-fetching extension is Track B by this
repo's own definition, and carries Track B's recorded contract risk. The
2026-09-06 acceptance of that risk covered a different mechanism (the
Playwright fetcher). This is a fresh, separate acceptance for a new
mechanism.

**Consequence recorded in the docs, not just here.** The extension is
henceforth **Track A′** — a browser-session Track B. The README's "never
fetches anything on its own" paragraph becomes false the day this ships and
must be rewritten in the same commit, not later.

**Politeness discipline: adopted in full, and reused rather than re-typed.**
The extension's crawl uses the same `SwimCloudPoliteFetcher` object the
Playwright track uses, actually imported, not re-implemented. This is
possible, and was verified rather than assumed: `packages/swimcloud/src/fetcher.ts`'s
only *value* import is `./urlClassifier`. Its imports from `./cache`,
`./entities` and `./parser` are all `import type`, which erase at build.
Both files use nothing from Node. So `fetcher.ts` + `urlClassifier.ts`
bundle to a browser target with zero Node dependencies and zero runtime
dependencies. That gives, for free and without drift:

- the robots.txt denylist checked through `classifySwimCloudUrl` **before
  every request**, with `forbidden` as a hard throw;
- `minDelayMs` (default 3000) enforced across the whole crawl, one instance
  per crawl, never concurrent;
- cache read-through, so a page already stored is never re-requested, and a
  `'final'` page throws rather than silently re-fetching.

**Why not just import the npm package?** It cannot be imported as-is. A
Manifest V3 content script here is an unbundled classic script —
`content.js` already duplicates the clipboard payload shape by hand for
exactly this reason, and its README documents the duplication.
`packages/swimcloud/src/html.ts`'s header says its primitives are "exported
because the browser extension will need the same ones," but **that wiring
does not exist**: there is no build step in `extensions/`, no bundler
config, and `content.js` imports nothing. So this round adds the missing
wiring — a small esbuild step producing
`extensions/swimcloud-companion/vendor/omniswim-swimcloud.js` from
`urlClassifier.ts`, `fetcher.ts` and a new pure `crawlPlan.ts`. A test
asserts the bundle is current by rebuilding and diffing, so it cannot drift
the way `buildPayload()` can.

`cache.ts`, `playwrightFetcher.ts` and `parser.ts` are **excluded from the
bundle**. `cache.ts` dynamically imports `node:fs/promises`; `playwrightFetcher.ts`
needs `playwright-core`; and `docs/INVARIANTS.md` already records the
package-root import trap that dragging those into a browser build creates
(`WORKLOG-03`, commit `ad736c7f`). The extension gets its own
`chrome.storage.local`-backed `SwimCloudCacheStore` implementation — the
interface is four methods and is already the abstraction the fetcher
depends on.

**Why not use the already-scaffolded Playwright track instead.** Four
reasons, in order of weight:

1. `PlaywrightSwimCloudFetcher` has never fetched a real page from anywhere.
   Its own header says so, and `plans/STATE.md` names it as "one thing
   still genuinely unverified." Making a 300-page crawl its first live run
   is the worst possible first run.
2. It has to pass Cloudflare's Managed Challenge cold, then keep a
   `storageState` warm. Neither has been proven once. The extension already
   sits inside a session that provably works — the three real fixtures in
   `tests/fixtures/` exist because of it.
3. Risk posture. A headless bot with a stored cookie jar is the archetype
   the ToS clause describes. Requests issued by the user's own browser, in
   the user's own session, after the user's own click, are still automated
   access — but they are nearer the line the case law in
   `01-legal-and-access-strategy.md` §3 tracks ("one coach's personal tool"
   vs "a bulk scraper") than a headless fleet is.
4. Cost of being wrong. If the extension's fetches come back challenged, the
   crawl stops and one page is lost. If Playwright's session handling is
   wrong, the failure is silent and produces plausible partial data.

The Playwright track is not retired. It stays scaffolded, unused, and still
unverified.

## D2 — Captures are stored locally, machine-global, gitignored, never committed. Decided 2026-09-08.

Full design in [02-capture-store.md](02-capture-store.md). The location
choice is the part that is a decision rather than a detail: **a
machine-global user-data directory, not a repo-relative one.**

Three reasons:

1. **Worktrees.** This session runs from a git worktree sharing a stash
   stack with the main checkout and other worktrees. A repo-relative
   capture directory is per-worktree. A capture made while working in one
   worktree would be invisible from the main checkout. Captures are meant
   to accumulate across seasons; the tool that reads them must not depend
   on which worktree the app was started from.
2. **`git clean -xdf` deletes gitignored files.** A capture archive is
   irreplaceable — re-creating it means re-crawling SwimCloud, which is
   exactly the load this design is trying to bound. Putting it anywhere
   inside the repo makes a routine cleanup command destroy it.
3. **Precedent.** `~/.claude` is machine-global rather than per-checkout for
   the same reason: it is user data, not project data.

**Location, by platform**, with an env-var override matching the repo's
existing `OMNI_PORT` / `OMNI_HOST` convention:

| Platform | Default |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Omniswim\swimcloud-captures\` |
| macOS | `~/Library/Application Support/Omniswim/swimcloud-captures/` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/omniswim/swimcloud-captures/` |
| Override | `OMNI_SWIMCLOUD_CAPTURE_DIR` |

A `data/swimcloud-captures/` entry still goes in `.gitignore`, as a guard
for anyone who points the override into the repo.

**Relationship to `CLAUDE.md`'s Data provenance section.** That section is
about competition cut standards, and this store is not one. But three of
its rules apply by spirit and are adopted explicitly, because the SwimCloud
code already follows that ethos through `SwimCloudParseFailure` /
`SwimCloudParseWarning` / `SwimCloudParseConfidence`:

- **Rule 1 (archive with `{url, sha256, retrievedAt}`)** is adopted
  literally. `SwimCloudCacheEntry` already has all three fields; `sha256`
  is optional and nothing computes it today. The server route computes it
  on write.
- **Rule 3 (fail loudly)** — a page that 403s is stored as an explicit
  failed-page record, never omitted.
- **Rule 4 (absent ≠ empty)** — a capture never claims completeness it
  cannot prove. See [02-capture-store.md](02-capture-store.md)'s
  `completeness` field, which has no `'complete'` value reachable by
  inference.

One rule is adopted as a prohibition: the cut-standard badges the swims list
prints (`SwimCloudCutStandardLabel`) stay informational forever. That
type's own doc comment already says resolving a scraped badge into a cut
decision "is how a swimmer gets told they made a cut they did not make."
Nothing in this pipeline may change that.

## D3 — Capture scope per button, asymmetric. Decided 2026-09-08.

**From a meet page:** the full meet — every competing team, both genders,
every page of each team's swims list.

**From a team page (not meet-scoped):** that team's current-season meets and
its results at each, plus every roster member's swimmer profile, men and
women kept separate throughout.

**Status difference, and this is the important part.** The meet scope is
buildable now: every URL it needs is confirmed-real
(`urlClassifier.ts`'s "Four of these patterns ARE now confirmed
(2026-09-08)"), and its one parser is `real-capture-verified`. The team
scope is **not** buildable now — see [04-parsers-and-fixtures.md](04-parsers-and-fixtures.md)
and [08-open-questions.md](08-open-questions.md). It is designed here and
gated behind real captures.

### Correction to the original brief's premise for the meet scope

The original brief for this plan stated the meet root's Teams table
"already lists every competing team's id (confirmed in the real capture)."
**That is not what the capture confirms.**
`tests/fixtures/swimcloud-real-meet-landing-356467.html`'s own header says,
verbatim:

> Teams card: summary only (top 3 + a "–" row for a team with 0 score)

and its sibling cards are labelled "top-5 swimmers only, NOT the full meet"
and "top-5 SWIMS only." The High point card carries a `More` link to
`/results/356467/topswimmers/`. **The Teams card carries no `More` link at
all.** For a 4-team meet, 4 rows may well be everything. For a 20-team
conference championship, nothing in the capture says whether the card
truncates. Additionally, the meet root is gender-scoped — its dropdown
offers `?gender=M` (default) and `?gender=F` — so even a complete card is
complete for one gender.

What is confirmed is narrower and still useful: every
`/results/{meetId}/team/{teamId}/` href on that page is real and
well-formed, and it appears in three places (Teams, High point,
Performances), not one.

So team discovery is designed as: fetch the meet root at `?gender=M` **and**
`?gender=F`, take the **union of every** `/results/{meetId}/team/{teamId}/`
**link on both**, and record `teamDiscovery.completeness: 'unproven'` on the
capture. The extension shows the discovered teams as a confirmable
checklist before the crawl starts, so a coach who knows a team is missing
can add it by pasting its link. The capture record never says "all teams."
This is open question **OQ-1** in
[08-open-questions.md](08-open-questions.md), and it is the one that blocks
execution.

### OQ-1 update, 2026-09-08: partially resolved by a second real capture

The user captured a second, larger meet (379295, Mountain Pacific Sports
Federation Championships, 13 competing teams —
`tests/fixtures/swimcloud-real-meet-landing-379295-gender-m.html` and its
`-gender-f.html` sibling) specifically to settle this question. Result: the
Teams card **does** truncate on a real meet — it shows exactly 5 of 13
teams — and, unlike the 4-team/4-shown 356467 capture, this one's Teams
card carries a "More" link:

```
/results/{meetId}/topteams/?gender={M|F}
```

This is a new, previously-unmodelled resource — a meet's full
team-standings page, gender-scoped, following the same "More"-link
convention already confirmed for `topswimmers/` and `topswims/`. **Team
discovery is redesigned around it**, primary mechanism first:

1. Fetch `/results/{meetId}/topteams/?gender=M` and `?gender=F` (new
   `meetTopTeams` resource — needs adding to `urlClassifier.ts`).
2. Parse with a new `parseMeetTopTeamsHtml` — **not yet real-capture-
   verified**, since only the link to this page is confirmed real, not its
   markup. Blocked on fixture **F1b** (see
   [06-testing-and-verification.md](06-testing-and-verification.md)).
3. **Fallback, not primary**: if `topteams` itself 404s, is malformed, or
   its own row count looks suspiciously low against the ld+json
   `competitor` list length, fall back to the original design — union the
   meet-root Teams-card links from both gender pages — and mark
   `teamDiscovery.source: 'meet-root-links-fallback'` plus
   `completeness: 'unproven'` so the capture record is honest about which
   mechanism actually ran.

### OQ-1b, also resolved 2026-09-08: `topteams` is the real, complete list

The user captured both gender variants of the `topteams` page directly
(`tests/fixtures/swimcloud-real-meet-topteams-379295-gender-{m,f}.html`).
Result: **it lists every team, unconditionally.** Both captures show all 13
teams from the meet's own ld+json `competitor` list — 6 (men) / 10 (women)
with a real score and numeric rank, the remaining 7 / 3 with rank **and**
score both rendered as an em dash, but still present as rows, never
dropped. This is the opposite failure mode from the meet-root Teams card:
that card truncates by omission; `topteams` does not omit a team just
because it scored nothing.

Markup is structurally identical to the meet-root Teams card — same table
classes, same row shape (rank cell, team link, team name, score cell).
`parseMeetTopTeamsHtml` can reuse `parseMeetTeamsHtml`'s row-extraction
logic directly; the differences are page-level (no "More" caption, the
gender/sort dropdowns point at `/topteams/?gender=` instead of the bare
meet root) not row-level.

**Consequence: team discovery for the meet subject is now fully buildable,
not just designed.** `parseMeetTopTeamsHtml` earns `real-capture-verified`
confidence directly — see [04-parsers-and-fixtures.md](04-parsers-and-fixtures.md).
Phase 1 is no longer blocked on this path at all. The meet-root-links-union
fallback stays in the design (§3 of [03-extension-crawler.md](03-extension-crawler.md))
as defense-in-depth for a `topteams` 404/malformed case, but is no longer
load-bearing for the common case.

One caveat worth stating plainly: "13 of 13" is one data point. It is
strong evidence for *this* meet, not a proof that `topteams` never
paginates on an even larger field (a 40-team invitational, say). Nothing in
this plan currently needs that larger case to be true — the crawl plan
should still cap and confirm with the user (OQ-8) rather than assume
unlimited completeness.

Secondary finding from the same captures, unrelated to team discovery: the
events sidebar on meet 379295 shows a nested-id URL shape never seen
before — `/results/379295/event/41/0/` and `/results/379295/event/41/1/`,
two different events sharing printed number "41". `urlClassifier.ts`'s
`meetEvent` resource models only the one-segment form and would classify
this as `unrecognized`. Not fixed here (this crawl never visits `meetEvent`
pages), but recorded — see [08-open-questions.md](08-open-questions.md)
OQ-9 — so it isn't rediscovered from scratch later.
