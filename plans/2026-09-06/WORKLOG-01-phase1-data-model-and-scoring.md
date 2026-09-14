# Worklog — Phase 1: data model & scoring

**Purpose of this file:** if this session gets cut off (5-hour usage limit or
otherwise), read this file first. It says exactly what's landed (with commit
hashes), what's in flight, and the next concrete action — so a fresh session
can resume without re-deriving context. Update it at every checkpoint, not
just at the end of a run.

Working from [`04-phasing.md`](04-phasing.md) Phase 1. Scope for *this* round
was narrowed from that doc's original phase-1 description — see "Descoped
from phase 1" below — to keep each piece independently landable and verified
before the next starts.

## Status: PHASE 1 COMPLETE (with one deliberate descope — see below)

## Checklist

- [x] **1a — NCAA scoring ruleset engine** (`packages/core`) — commit `e582c0b8`
  - `packages/core/src/lib/ncaaScoringRules.ts`, exported from package root.
  - Point tables for dual (6+/≤5 lane, incl. diving-only), tri/quad,
    relay-only, invitational (host-published, no default), and championship
    finals for field sizes 6/8/12/16/18 (24 deliberately left throwing —
    Rule 7-6-6 publishes the point table but not the place-range split; see
    the commit and `02-data-model-and-scoring.md` §3).
  - **Found and fixed a real bug in the plan doc, not just the code**: the
    original `02-data-model-and-scoring.md` said a DQ'd place is "not bumped
    up." The primary source (archived at
    `data/scoring_rules/sources/ncaascoring.rule7.txt`, independently
    re-verified by the orchestrator before correcting) says the opposite —
    the field re-ranks with the DQ'd swimmer removed from consideration,
    identically to how exhibition swims are handled. Doc corrected in this
    commit.
  - 41 tests (`tests/ncaaScoringRules.test.ts`), full suite green at commit
    time.
- [x] **1b — `packages/swimcloud` package: entities, URL classifier, parser skeleton** — commit `c8d5771f`
  - Entities, `classifySwimCloudUrl`, HTML extraction primitives, and
    `parseTeamRosterHtml`/`parseMeetResultsHtml` — all per
    [02-data-model-and-scoring.md](02-data-model-and-scoring.md) and
    [03-architecture.md](03-architecture.md) §1.
  - **This agent hit the account's Opus rate limit mid-run** (session-limit
    429, reset scheduled for 12am America/Chicago) and its process was
    killed before it could write `tests/swimcloudParser.test.ts` or report
    back — the exact scenario this worklog exists for. Its file edits
    (already on disk, since edits land synchronously, not just at an
    agent's end) were **not** discarded: the orchestrator picked the work
    back up directly rather than waiting for quota to reset or re-spawning
    a fresh (likely still-rate-limited) executor.
  - What "picking it back up" actually found, so the pattern is on record:
    `npm run lint -w @omniswim/swimcloud` failed with ~10 errors, all one
    root cause — `extractTableRows` was fully implemented in `html.ts` but
    never added to `parser.ts`'s import list, so two call sites and their
    type-inference cascade broke. One-line fix. The design underneath it
    (entities, classifier, parser contract, all four synthetic fixtures)
    was already sound — this was a genuinely mid-edit interruption, not a
    wrong turn. Separately, one already-written classifier test had a real
    bug (`toStrictEqual` on two results including the verbatim `input` echo
    field, which necessarily differs between two different input strings) —
    fixed by comparing without that field.
  - `tests/swimcloudParser.test.ts` (18 tests) then written from scratch by
    the orchestrator: read `parser.ts`'s control flow by hand against each
    of the four synthetic fixtures, wrote the assertions predicted by that
    reading, then ran once. All 18 passed on the first run — real
    verification, not iterating a test to match whatever the code happened
    to do.
- [x] **Verify + commit 1a** — lint (8/8 workspaces) + full vitest (135/135)
  green before commit.
- [x] **Verify + commit 1b** — same, after the import fix and the new test
  file; commit `c8d5771f`.
- [x] **Lockfile sync** — commit `e58a5d06`. 1a's `npm install` (run because
  `node_modules` wasn't present) left `package-lock.json` unregistered for
  the new `@omniswim/swimcloud` workspace; `npm ci` would have failed.
  Regenerated and committed separately from the feature commits.
- [x] **Update this file + `plans/STATE.md` with final status** — this edit.

## Descoped from phase 1 (recorded, not dropped) — unchanged from original scope-cut

`04-phasing.md` phase 1 also names `packages/db` schema additions for the new
entities. Still deferred, for the same reason recorded when this file was
created: real persistence/migration wiring (SQLite + Postgres parity,
`test:roundtrip`/`test:parity`) is its own blast-radius and shouldn't ride
alongside a first cut of brand-new entity types now that both are proven out
in-memory. Pick this up as its own piece of work — see
[04-phasing.md](04-phasing.md) Phase 2/3 for what depends on it.

## Where this leaves the plan

Phase 1's non-network, fixture-testable scope (entity model, NCAA scoring
engine, URL classifier, parser contract) is done and green on
`nvitthanala/swimcloud-data-ingest` at commit `e58a5d06`. Not started:
Phase 2 (Playwright fetch service + politeness wrapper + status-keyed cache)
and Phase 3 (browser extension + import-UI wiring) from
[04-phasing.md](04-phasing.md) — both still blocked on the open questions
listed there (Track A transport decision; confirming the meet-ID/URL
patterns and relay-leg-split question against one real, human-captured
SwimCloud page, since nothing in this repo has ever seen one).

## Descoped from phase 1 (recorded, not dropped)

`04-phasing.md` phase 1 also names `packages/db` schema additions for the new
entities. Deferred out of *this* round: real persistence/migration wiring
(SQLite + Postgres parity, `test:roundtrip`/`test:parity`) is its own
blast-radius and shouldn't ride alongside a first cut of brand-new entity
types. `packages/swimcloud` ships as in-memory types only this round; DB
wiring is a follow-up once the shapes have proven out. Noted so it isn't
silently forgotten — add it back to the checklist above when picked up.

## How to resume if this file says IN PROGRESS with unchecked items

1. `git log --oneline -10` — see what's actually committed vs. what this file
   claims. Trust git over this file if they disagree; then fix this file.
2. `npm run lint --workspaces --if-present && npm test` — confirm baseline is
   still green before starting anything new.
3. Pick up the first unchecked box. If an executor agent was mid-run when the
   session ended, its edits (if any) are already in the working tree
   (uncommitted) — check `git status` before re-spawning the same agent, to
   avoid duplicating work.

## Log

- **2026-09-06** — Worklog created. Plan docs (00–04) finalized this session,
  no code yet. About to spawn 1a and 1b in parallel.
- **2026-09-06** — Both 1a (NCAA scoring ruleset engine, `packages/core`) and
  1b (`packages/swimcloud` entities/URL classifier/parser skeleton) spawned
  as executor agents, running in parallel (disjoint scopes: 1a never touches
  `packages/swimcloud`; 1b never touches `packages/core`/`packages/db`).
- **2026-09-07** — 1a completed cleanly (full report, all commands green).
  Orchestrator independently re-verified (own lint + test run, and
  independently re-fetched the DQ-rule quote from the archived source before
  trusting 1a's correction) before committing as `e582c0b8`.
- **2026-09-07** — 1b was killed mid-run by an Opus session-limit 429 (reset
  12am America/Chicago) — this is the exact "hit the 5-hour limit" scenario
  this worklog was built for. On `git status`, its files were already on
  disk (packages/swimcloud/ scaffolded, urlClassifier + its 63-test suite
  complete, parser.ts and 4 synthetic fixtures written, tsconfig.base.json's
  path entry added) — nothing was lost, because file edits land as they
  happen, not at an agent's completion. `npm run lint -w @omniswim/swimcloud`
  showed the tree was genuinely mid-edit (10 errors, one missing import),
  confirming the repo's standing rule that partial agent work is assessed,
  never trusted, before being treated as done. Orchestrator fixed the
  import, fixed one real bug in an already-written test, wrote the missing
  parser test file by hand-tracing the code first, ran it once (18/18 green
  first try), then committed as `c8d5771f`. Lockfile drift 1a had flagged
  (found because `packages/swimcloud` didn't exist yet when 1a ran its
  `npm install`) fixed and committed separately as `e58a5d06`.
- **2026-09-07** — Full tree verified clean: `npm run lint` 8/8 workspaces,
  `npx vitest run` 135/135 across 8 files. Phase 1 (this file's original
  scope) is done. See "Where this leaves the plan" above for what's next.
