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

## Status: IN PROGRESS

## Checklist

- [ ] **1a — NCAA scoring ruleset engine** (`packages/core`) — not started
  - Pure-function point-table engine for dual (6+/≤5 lane)/tri-quad/
    relay-only/championship-final-by-field-size, DQ/tie/exhibition handling,
    per [02-data-model-and-scoring.md](02-data-model-and-scoring.md) §3.
  - Additive only — existing `ScoringSettings`/`scoringTheory.ts` pipeline
    untouched.
  - Agent: executor. Commit: _pending_.
- [ ] **1b — `packages/swimcloud` package: entities, URL classifier, parser skeleton** — not started
  - New workspace package. Entity types from
    [02-data-model-and-scoring.md](02-data-model-and-scoring.md) §2. URL
    classifier per §1 of that file. Parser/normalizer contract + hand-built
    fixture tests (explicitly flagged unverified against live SwimCloud
    markup — no real fixture exists yet, see open question #2/#4 in
    [04-phasing.md](04-phasing.md)).
  - Disjoint from 1a: does not touch `packages/core` or `packages/db`.
  - Agent: executor. Commit: _pending_.
- [ ] **Verify + commit 1a**
- [ ] **Verify + commit 1b**
- [ ] **Update this file + `plans/STATE.md` with final status**

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
  Briefs told each not to run git commands — orchestrator verifies + commits
  each independently as it lands. If this file still says IN PROGRESS with
  both boxes unchecked and no commits in `git log`, neither agent had landed
  before the session ended — re-read the two briefs in the "How to resume"
  section context (not reproduced here; if lost, re-derive from
  `04-phasing.md` Phase 1 and this file's checklist descriptions) and
  re-spawn.
