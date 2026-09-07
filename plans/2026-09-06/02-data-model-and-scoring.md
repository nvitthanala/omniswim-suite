# Data model & scoring

## 1. Confirmed SwimCloud URL/ID scheme

From live search results and prior-art scraper source (SwimScraper,
maflancer/ACC-Swimming-Data) — not independently re-verified by direct fetch
today (blocked by the Cloudflare challenge, see
[01](01-legal-and-access-strategy.md) §2), but consistent across every
independent source found:

| Entity | URL pattern | Example |
| ------ | ----------- | ------- |
| Team | `/team/{id}/` | `/team/10028935/` |
| Team roster | `/team/{id}/roster/?page=&gender=&season_id=` | — |
| Team meet list | `/team/{id}/results/?page=&year=` | — |
| Swimmer | `/swimmer/{id}/` | `/swimmer/3646504/` |
| Meet/results | `/results/{meetId}/`, per-event `/results/{meetId}/event/{n}/` | `/results/193735/` = 2026 NSISC Championships |
| Conference | `/country/usa/college/conference/{slug}/` | `/conference/nsisc/` |

IDs are plain integers assigned roughly chronologically (an older team was
seen at ID 405); conferences use readable slugs. A 2024-era scraper fix noted
event IDs in swimmer time-history views gained a course-type suffix
(`L`/`S`/`Y` for LCM/SCM/SCY) — confirms course type needs to be a first-class
field on Event, not inferred from event name alone. **Open item**: confirm
these patterns against a live, human-navigated page (via Track A) before
building the URL classifier — see [04](04-phasing.md) open questions.

## 2. Entity model

No single open-source project has a complete schema for this domain. The
closest structural precedent is the W3C OpenTrack Community Group's Open
Athletics Data Model (track & field, structurally close to swimming):
Competition → UnitCompetition → Competitor → Performance → Result, with
relay legs modeled as nested sub-races rather than a text blob. Adapting that
shape, layered onto this repo's existing provenance rules (`CLAUDE.md` §"Data
provenance"):

- **Conference** — governs a set of Teams; carries its own scoring-ruleset
  override (matches the existing NSISC preset pattern).
- **Team** — one program per *sponsored gender*, per the repo's existing
  `sponsoredGenders` rule — a SwimCloud team page is not automatically "the"
  team; it's one gender's program. Carries division/affiliation and a
  status/history, same shape as the existing `teamDivisions.ts`.
- **Athlete** — belongs to a Team for a season; class year; feeds the
  existing alias/name-variant linking (`suggestAliasCandidates`) rather than
  a new one — a SwimCloud-imported athlete is just another candidate row into
  that existing suggestion flow.
- **Meet** — an occasion at a venue/date range. Typed
  (dual / tri / quad / relay-only / invitational / championship) plus a
  ruleset reference (NCAA/NAIA/NFHS/conference-custom) and lane count
  (6+ vs ≤5 changes the NCAA point table — see §3). This typing is what
  selects the point table; it must be captured at import time, not guessed
  downstream.
- **Session** — sub-occasion of a Meet (prelims/finals, day 1/2). Needed
  because championship scoring treats championship-final and
  consolation-final placement as strictly separate pools (§3) — merging them
  post hoc is exactly the kind of silent-wrong-number bug this repo's
  provenance rules exist to prevent.
- **Event** — one contested race within a Session; individual or relay;
  course type (LCM/SCM/SCY) as its own field, not inferred from the label.
- **Heat** — a physical race within an Event; needed for raw Meet-Manager
  ingestion (seeding is heat/lane based) even if not always shown on
  SwimCloud's own results view.
- **Entry** — an Athlete's (or, for relays, a Team relay unit's)
  registration in an Event, pre-result. Corresponds to `.cl2`-style
  Meet-Manager entry data if that ingestion path is ever added.
- **Result** — the post-meet outcome for an Entry: time, place, DQ/scratch/
  exhibition flags. **Points are a derived field**, computed from
  (place, DQ status, exhibition flag, ties, resolved point table) — never
  stored as an authoritative import value. This mirrors the repo's existing
  discipline around `cutlines.ts`: a wrong number should be absent or
  recomputed, not silently trusted from a scrape.
- **Relay** — not a fifth top-level swimmer table. It's a Team-level Entry/
  Result whose leg list is an ordered `(Athlete, splitTime?)` collection —
  the split, if present, is itself a small Performance record per leg,
  echoing OpenTrack's nested-race pattern. Whether SwimCloud's results pages
  expose relay leg splits at all is **unverified** — flagged as an open
  question in [04](04-phasing.md), not assumed either way.

## 3. Scoring rules — config-driven, not NSISC-only

Source: NCAA Swimming & Diving Rule 7, read in full
([PDF](https://meets.swimdna.org/media/ncaascoring.pdf)).

- **Dual meet, 6+ lanes**: individual 9-4-3-2-1-0 (best 3 scorers/team);
  relay 11-4-2-0 (best 2 relays/team).
- **Dual meet, ≤5 lanes**: individual 5-3-1-0 (best 2/team); relay 7-0.
- **Double-dual/triangular/quadrangular**: individual 9-4-3-2-1 (max 3
  scorers/team); relay 11-4-2 (max 2/team) — same table regardless of heat
  count.
- **Relay-only meets**: 14-10-8-6-4-2, every event.
- **Invitationals**: point table is whatever the host publishes — not fixed
  by rule; must be a configurable override, never assumed.
- **Championship finals**: scale with field size, with a *separate* table
  for finals-only invitees (6/8/12/16/18/24-competitor variants); places 1–6
  score from the championship final only, 7–12 from the consolation final
  only — **never merged by time across the two finals**. Full tables are in
  the fetched PDF; transcribe them with a source citation when this is
  implemented, per the repo's provenance rule (no hand-typed competition
  values without a traced source).
- **No-show/forfeit**: a no-show within 30 minutes scores nothing at all; a
  coach-initiated forfeit scores 11-0 — these are two different states, not
  interchangeable.
- **DQ** — **correction, 2026-09-06, verified against the primary source
  (see below): this bullet originally said the opposite of what the rule
  states.** Rule 7-7 (both the nonchampionships text, Article 1, and the
  championships text, Article 2) reads: the DQ'd competitor scores nothing,
  and **all other competitors may advance in position**, scoring "according
  to the places they achieve with the disqualified competitor(s) removed
  from consideration" — mechanically identical, word-for-word construction,
  to how exhibition swims are handled (below). What's "lost from the meet"
  is the *trailing* place nobody is left to fill, not the DQ'd swimmer's own
  place. A championships-final DQ has one added constraint: competitors may
  not advance higher than the highest place actually being contested in that
  final.
- **Exhibition swims**: excluded before computing who scores; the field
  behind an exhibition swimmer advances into their place exactly as it does
  for a DQ, per the identical rule construction above — an exhibition 2nd
  place doesn't consume a scoring slot, but this is re-ranking, not a
  "remove and leave a gap" operation.
- **Ties**: tied competitors split the combined points for the places they
  occupy, evenly.

NFHS (high school) dual-meet scoring is commonly 6-4-3-2-1-0 individual /
8-4-2-0 relay with a 3-entries/team cap — meaningfully different from NCAA's
tables. NAIA scores 1st–16th at its national championship per its 2025-26
Coaches Manual, but the exact table wasn't fully extracted this round.
**Conclusion: the ruleset (NCAA/NAIA/NFHS/conference-custom) must be a
first-class, per-Meet config value** — exactly the axis the existing NSISC
preset / `mergeScoringSettings` pattern in `packages/core` already models for
one conference; this generalizes it rather than replacing it.

SwimCloud's own "Meet Simulator" runs a Dual Meet simulation and a separate
13-individual-event + 5-relay Championship simulation, layered under a
proprietary "Performance Points" cross-context ranking system whose internals
aren't published — treat that as a UX idea to emulate (a project-team lineup
against real point tables), not a formula to reverse-engineer, since it isn't
public.

## 4. Prior art — reference only, not a dependency

- `SwimComm/hytek-parser` (PyPI `hytek-parser`) and `jgolliher/hyparse` parse
  Hy-Tek `.hy3`/`.hyv`/`.xls` files (results/entries) — reverse-engineered,
  no official spec; small, single-maintainer, stable but not evolving. Worth
  reading for field coverage if raw Meet-Manager files ever become an
  ingestion path (they'd sidestep SwimCloud entirely for hosts that publish
  them), not worth depending on directly.
- `maflancer/SwimScraper` and `maflancer/ACC-Swimming-Data` — thin, stale
  (last real update 2024-09; the 2024 PR shows SwimCloud's own UI changes
  broke swimmer-time scraping and it's *still* reported broken post-fix).
  Useful only as confirmation of URL/ID shape (§1); not a library to import.
- A "AquaQuant" project (SwimCloud → SQLite, roster reconstruction, meet
  simulation) was referenced in a search-engine summary but **no actual
  repository could be located** — treat as unverified/likely hallucinated,
  not as prior art.
