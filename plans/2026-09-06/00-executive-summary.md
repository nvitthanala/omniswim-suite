# Executive summary

## The ask

Paste a SwimCloud link — meet, team, athlete, or conference — and get
structured data (roster entries, meet results, team scores, swims logged) into
this suite's existing roster/scoring pipeline, instead of pasting text by
hand. Framed by the user as "reverse-engineer the SwimCloud meet simulator,
plus coach tools: roster building, relay building, arbitrage logging."

## What research changed about the plan

The original framing treated "Cloudflare protection" as the main obstacle.
It isn't. SwimCloud's `robots.txt` is largely permissive for a generic client
(`Allow: /`, with only four disallowed paths). The real constraint is its
**Terms of Use**, which flatly prohibits *any* automated access, for *any*
purpose, with no personal-use carve-out — see
[01](01-legal-and-access-strategy.md) for the exact clause and source. That
finding was put to the user directly, before any code was written, and the
user chose to proceed on both an ToS-compliant track and a knowingly
ToS-breaching track. Both are in scope; which one runs for a given fetch is a
visible, explicit choice in the UI, not something the code picks silently.

## Scope

**In scope:**
- Parse a pasted SwimCloud URL (team/swimmer/results/conference) and classify
  it.
- Two acquisition tracks feeding one shared parser (see
  [03](03-architecture.md)):
  1. A browser extension the user clicks while viewing a SwimCloud page in
     their own logged-in browser (no autonomous fetching).
  2. An on-demand automated fetch (Playwright) triggered by pasting a link
     into the app — accepted-risk track, single-operator, local-only.
- Structured entities: Conference, Team, Athlete, Meet, Session, Event, Entry,
  Result, Relay — see [02](02-data-model-and-scoring.md).
- A general, config-driven scoring engine (NCAA/NAIA/NFHS/conference point
  tables), not a NSISC-only one — extends the existing scoring-settings
  pattern already in `packages/core`/`packages/matrix`.
- Wiring into the existing `RosterImportWizard` / `AthleteHistoryImportPanel`
  paste-and-preview UX (Round 3, `docs/archive/2026-08/`), not a parallel
  import path.

**Out of scope for this round:**
- Scheduled/background re-sync (e.g. auto-refreshing a live meet). On-demand
  only, per the recorded decision.
- Multi-coach SwimCloud access (shared sessions, per-coach attribution). The
  *data model* supports multiple teams/coaches; the *import mechanism* does
  not need multi-user auth yet.
- Anything that redistributes or republishes fetched SwimCloud data outside
  this user's own local workspace — the ToS explicitly bars redistribution
  regardless of which access track is used, and nothing here proposes
  crossing that.

## Explicit non-goals (hard boundary, not a phase-2 item)

Regardless of which access track: no CAPTCHA-solving automation, no IP
rotation / residential proxies to evade blocks, no user-agent spoofing to
impersonate a named crawler, no bulk/crawl-scale fetching, no scraping of the
robots.txt-disallowed paths (`/api/`, `/jsonapi/`, `/team/*/facilities/`,
`/tz_detect/`) under any circumstance. These are enforced in code (see
[03](03-architecture.md) "politeness wrapper"), not left to discipline.
