# Production readiness — the suite minus Metrics

**Opened:** 2026-09-20 · **Deadline:** Saturday 2026-09-26 (a self-imposed
timeline marker, not a specific meet — confirmed with the user 2026-09-20)

**Goal, in the user's words:** the roster manager and meet-scoring simulator
are "operational with proper wiring and minimal bugs", the SwimCloud ingest
logic is "sorted", the crawler is faster, the UI is easy to navigate, and
nothing is hardcoded to one division, team, scoring rule or meet format.
Video analysis (Metrics) is out of scope.

This plan is the entry point. Live status lives in
`docs/reference/PRODUCTION_READINESS_STATE.json` — **read that first when
resuming**, not this file. This file explains *why*; the state file records
*where we are*.

---

## Decisions already taken with the user (2026-09-20)

| # | Question | Answer |
| - | -------- | ------ |
| 1 | What must work by Saturday | Pre-meet lineup planning · opponent scouting/projection · post-meet reconciliation. **Not** live in-meet scoring. |
| 2 | Reconciliation behaviour | Compare **only** when official results *and* pulled team/swimmer history are both present. Gate it; never compare against half the data. |
| 3 | Crawl speed posture | Caching and fewer pages first. **Do not** relax the 3000 ms sequential floor. |
| 4 | Scoring formats | Full in-app preset authoring **and** ship more built-in presets. |
| 5 | Metrics applet | Stays visible, clearly marked experimental / not meet-ready. |
| 6 | Delegation | **Claude agents only.** The cross-provider "fleet" is a superseded self-built tool — disregard `fleet-routing` and `.fleet.json` guidance in `CLAUDE.md`. |
| 7 | Repo visibility | Private. **Done** 2026-09-20. |

---

## Baseline, measured 2026-09-20 (not inherited from a doc)

- `npm run lint --workspaces` (tsc) — clean, 8 workspaces, exit 0
- `npx vitest run` — **803 passed / 0 failed**, 45 files
- `node scripts/run-tests.mjs` — **81 passed / 0 failed / 1 skipped** (Postgres, needs `PG_TEST_URL`), Playwright e2e included
- Every branch is already merged to `main`. Only uncommitted work in the tree:
  5 files in the `chinook` worktree (Obsidian-vault instructions + 4 agent defs).

Nothing is on fire. This is a completeness, correctness-of-coverage and
speed job, not a triage job.

---

## Finding 1 — the Rule 7 engine exists and is wired to nothing

`packages/core/src/lib/ncaaScoringRules.ts` is **1,401 lines** implementing
NCAA Rule 7 in full: 14 meet formats, exhibition isolation (7-10-1), DQ
place advancement (7-7), tie division (7-8), lost-place accounting, and
per-format `maxScorersPerTeam`. It has an **864-line test file**. Its source
PDF is archived at `data/scoring_rules/sources/ncaascoring.pdf` with a
manifest.

**Verified this session:** the archived PDF is byte-identical to the live
document — sha256 `5b98f8f69470606ea179b053b86d7fb4451f61a874c0fff5d8d18b369d6bb92e`
matches a fresh fetch of `https://meets.swimdna.org/media/ncaascoring.pdf`
and the manifest's recorded hash. The provenance is real.

**And it is dead code in the product.** A grep for every export across the
monorepo returns exactly two consumers: `tests/ncaaScoringRules.test.ts` and
a re-export in `packages/core/src/index.ts`. No applet, no engine, no import
path calls it. The product scores through `calculatePoints` in `utils.ts`
against the legacy `ScoringSettings` shape.

### Why that matters more than it looks

`ScoringSettings` models relay scoring as `relayMultiplier: number` — a
scalar applied to `scoringPoints[]`. For every championship field size that
is exactly right; all six rulebook tables were checked:

| Field | Individual | Relay | Relay ÷ individual |
| ----- | ---------- | ----- | ------------------ |
| 6 | 7-5-4-3-2-1 | 14-10-8-6-4-2 | 2× |
| 8 | 9-7-6-5-4-3-2-1 | 18-14-12-10-8-6-4-2 | 2× |
| 12 | 16-13-12-11-… | 32-26-24-22-… | 2× |
| 16 | 20-17-16-15-… | 40-34-32-30-… | 2× |
| 18 | 22-19-18-17-… | 44-38-36-34-… | 2× |
| 24 | 32-28-27-26-… | 64-56-54-52-… | 2× |

It is **wrong for every non-championship format**:

| Format (Rule) | Individual | Relay | 2× would give |
| ------------- | ---------- | ----- | ------------- |
| Dual, 6+ lanes (7-1-1) | 9-4-3-2-1 | **11-4-2** | 18-8-6 ✗ |
| Dual, ≤5 lanes (7-1-2) | 5-3-1 | **7** | 10 ✗ |
| Relay meet (7-3) | — | 14-10-8-6-4-2 | n/a |

A dual meet is the most common format in college swimming and **this app
cannot represent one today.** The three dual *diving* tables (7-1-4) are
likewise inexpressible: diving is modelled only as `diverScorerWeight`, a
fractional cost against the scorer pool, not as its own place-value table.

That single fact is the largest gap between where the suite is and "usable
for all divisions/teams/scoring rules and formats."

---

## Finding 2 — the crawler's real cost, measured

From the user's own archived 234-page capture
(`data/swimcloud-captures/captures/meet-356467.json`, 4 teams, 2026-09-10):

| Pass | Pages | Wall time | Pacing |
| ---- | ----: | --------: | ------ |
| `meetTeamSwims` | 42 | **122 s** | sequential, 2981 ms observed gap |
| `teamRoster` | 8 | **21 s** | sequential, 3002 ms observed gap |
| `swimmerTimes` | 184 | **75 s** | pooled, 409 ms observed gap (3 lanes / 400 ms stagger) |
| **Total** | **234** | **~218 s** | |

Two conclusions the numbers force:

1. **50 sequential pages cost more wall-clock than 184 pooled ones.** The
   3000 ms floor, not page count, is the crawl's dominant cost. The user has
   ruled out relaxing it, so speed must come from elsewhere.
2. **Every page is `cacheStatus: "provisional"` — all 234 of them.** Nothing
   is ever promoted to durable, so a re-crawl of the same meet re-fetches
   everything. This is where the speed actually is, and it costs no new
   traffic-pattern exposure at all. It is strictly *less* traffic.

---

## Finding 3 — SwimCloud import silently drops prelims/finals swimmers

Recorded in `plans/2026-09-10/01-SWIMCLOUD-SCORING-CORRECTNESS.md` and still
current. SwimCloud's team-swims page has no round column, so a swimmer who
made finals appears as two near-identical rows whose `Place` column is a
*per-round* placement (proven: a faster swim marked 2nd, a slower one marked
1st). The fix that landed excludes **the whole group, in full**, from the
import.

That was the right call at the time — guessing a winner is exactly what this
repo's provenance rules forbid. But the consequence is that **the better a
swimmer is, the more likely they are to vanish from an import**: on the one
measured page, 13 of 30 rows (43%) were in such a group. For the opponent-
scouting job the user named as a Saturday requirement, that is a serious
silent under-count. Worth re-opening with the `meetEvent` pages, which do
carry round context, as a disambiguation source rather than a guess.

---

## Phases

Ordering is by dependency, not by size. `executor` = Opus-tier (correctness
and schema), `worker` = Sonnet-tier (UI against a reported API), `finisher`
= Haiku-tier (verification only). Briefs stand alone; no agent shares this
conversation.

### P0 — Consolidation and governance *(direct, no subagent)*
Repo private (**done**). Land the `chinook` agent-definition changes. Prune
merged branches and stale worktrees. Rewrite `CLAUDE.md`'s delegation
section to drop the superseded fleet layer per decision 6. Refresh the four
agent definitions for this round's work. Stand up the state file.

### P1 — Scoring generalisation *(executor, serial — everything depends on it)*
Make `ScoringSettings` able to express every Rule 7 format, sourcing the
numbers from `NCAA_FORMAT_RULESETS` so there is still exactly one place the
tables live. Generate built-in presets from it. Add preset CRUD to the
server with validation. Kill `presetIdForConference`'s hardcoded conference
string matching. See the open decision below before starting.

### P2 — Preset authoring UI *(worker, after P1 reports its API)*
Create / duplicate / edit / delete / import / export a rule set in-app.
Must preserve the existing settings-lock explanation rather than implying
edits take effect when they don't.

### P3 — SwimCloud ingest and crawl speed *(executor, parallel with P2)*
Durable capture cache with skip-unchanged on re-crawl. Job-scoped page
selection — stop fetching `swimmerTimes` for a job that only needs meet
results. Re-open the prelims/finals disambiguation (Finding 3). Gate
reconciliation on both sources present (decision 2).

### P4 — UI navigability *(worker)*
Against the 2026-09-10 diagnosis docs, re-measured first — several of their
findings are already fixed (Badge hand-rolling is 9 files → 1;
`crossCourseArbitrageSections.tsx` is deleted). Still open and confirmed
today: **122 hand-rolled `<button>` elements**, the team `<select>`
duplicated across **11 files**, and four stacked navigation idioms. Mark
Metrics experimental (decision 5).

### P5 — Adversarial bug hunt *(executor + finisher)*
Explicitly **not** "add tests until the number is big". Every new guard gets
mutation-tested — inject the bug, watch the test fail, revert — per this
repo's existing rule 3 in `plans/STATE.md`. Plus a real click-through of the
running app, which is what caught the duplicate-React-key bug the unit suite
never saw.

### P6 — User guide
How to *use* the app, written for a coach, not a developer. Parameterised by
format and division throughout — no HSU/NSISC-specific instructions.

---

## Open decision for the user

**How should the Rule 7 engine and `ScoringSettings` converge?** See the
state file's `openDecisions` entry. Recorded here so a resumed session finds
it without re-deriving the trade-off.
