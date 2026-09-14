# Phasing & delegation

Follows this repo's standing model (`CLAUDE.md`): land core correctness first,
lint+tests green, before UI is built against a reported API. Disjoint scopes
per phase, one integrator, evidence over assertion — same rules as
`plans/2026-08-16/README.md`'s "How this work runs."

## Phase 1 — `executor` (Opus): data model & scoring, no network

Pure, network-free, fixture-testable. Blocks everything else.

- Entities from [02](02-data-model-and-scoring.md) §2, added to
  `packages/core`/`packages/db` schema, additive (no breaking change to
  existing roster/scoring types).
- Config-driven scoring ruleset: NCAA Rule 7 tables (dual 6+/≤5, tri/quad,
  relay-only, championship-finals-by-field-size), transcribed with the PDF
  citation from [02](02-data-model-and-scoring.md) §3 — every table value
  traces to that source, per this repo's provenance rule. NAIA/NFHS tables
  can land as a follow-up once fully extracted; NCAA is the one with enough
  sourcing to build now.
- URL classifier (`packages/swimcloud`, §1.1 of
  [03](03-architecture.md)) — pure function, tested against the URL patterns
  in [02](02-data-model-and-scoring.md) §1, plus adversarial inputs
  (malformed IDs, non-SwimCloud domains, the four denylisted paths — must
  classify but flag as forbidden, never silently accept).
- Parser/normalizer (§1.3 of [03](03-architecture.md)) against **manually
  captured fixture HTML** (saved from a real, human-navigated page via Track
  A during this phase, or a Wayback snapshot) — not against live fetches.
  This is what makes phase 1 buildable without Track B existing yet.
- **Acceptance**: lint clean, new tests green, existing scoring tests
  unaffected, `calculatePoints`-equivalent for the new ruleset config
  reproduces the NCAA point tables exactly for a hand-built fixture meet
  (dual + one championship-final scenario, ties, one DQ, one exhibition swim
  — the edge cases §3 calls out).

## Phase 2 — `executor` (Opus): fetch service (Track B) + cache

Depends on phase 1's parser/normalizer contract, not on Track A.

- Politeness wrapper (§1.2 of [03](03-architecture.md)): denylist, rate
  limit, honest UA — with a test that deliberately tries to hit
  `/api/`/`/jsonapi/`/etc. and asserts it's rejected before any request
  fires (same "prove the guard bites" discipline as
  `plans/2026-08-16/README.md` rule 3).
- Status-keyed cache (§1.4): a test that marks a page `final`, attempts a
  re-fetch, and asserts the cache is served instead of the network.
- Playwright integration: headless fetch, `storageState()` reuse. Needs a
  **real, human-supervised run** against live SwimCloud (not just fixtures)
  to confirm Playwright actually clears the Cloudflare challenge — this is
  the one place in the whole plan that can't be fully verified without
  touching the live site once, deliberately and manually.
- **Acceptance**: one real end-to-end fetch of a real meet/team/swimmer URL,
  supervised, output diffed against the phase-1 fixture parser's expected
  shape.

## Phase 3 — `worker` (Sonnet): extension + import UX wiring

Depends on phase 1's parser/normalizer *reported API* (types/exports), built
against that report rather than reading phase 1's diff directly, per the
delegation contract in `CLAUDE.md`.

- `extensions/swimcloud-companion/` — Manifest V3 extension per
  [03](03-architecture.md) §2. Needs the transport decision (§5 of that doc)
  resolved first — see open questions below.
- `RosterImportWizard`/`AthleteHistoryImportPanel` extension: paste-link
  input, URL classification feedback, the two-track choice UI with the
  persistent (not one-time) Track B risk indicator, and the
  Parse → checkbox preview → Add selected flow reused from Round 3.
- **Acceptance**: existing paste-text import flow unaffected (regression
  check, not just new-feature tests); new paste-link flow produces the same
  preview/edit/add UX as the existing one.

## Phase 4 — `finisher` (Haiku): verification pass

- Lint/typecheck/test run across all touched packages.
- Edge cases: malformed/partial SwimCloud URLs, an athlete import that
  collides with an existing alias, a meet import where the ruleset can't be
  determined (must surface as "unknown ruleset," never silently default to
  NCAA or NSISC).
- No design decisions — anything found that needs one goes back to phase 1/3
  as a reported finding, not a fix made in place.

## Open questions only the user can answer

1. **Track A transport** ([03](03-architecture.md) §5): localhost HTTP
   endpoint vs. watched file vs. clipboard-paste. Affects both extension and
   Tauri-backend scope in phase 3.
2. **Confirm the meet ID.** `/results/193735/` was reported as "2026 NSISC
   Championships" by a research agent from search results, not verified by
   direct fetch (blocked by the Cloudflare challenge). Worth confirming by
   hand (Track A, once it exists, or just opening the link in a browser)
   before it's hardcoded into any fixture test.
3. **Send the SwimCloud permission email?** ([01](01-legal-and-access-strategy.md)
   §4) — doesn't block Track B, but removes its ongoing risk if answered
   favorably. Whose name/address does the request go out under, and does the
   user want to send it before or after Track B ships?
4. **Relay leg splits on SwimCloud results pages** — unverified either way
   ([02](02-data-model-and-scoring.md) §2). Confirm once a real results page
   fixture is captured in phase 1; determines whether the Relay entity's leg
   splits are ever populated from this source or stay null until a
   Meet-Manager-file ingestion path exists.
5. **NAIA/NFHS point tables** — not fully extracted this round (NCAA was).
   If NSISC or another conference the user cares about scores under one of
   these, phase 1's ruleset table needs that source before it can be built,
   not a placeholder.
