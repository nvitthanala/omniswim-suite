# Improvement backlog (2026-10-09)

This backlog is built from the docs, the vault, a TODO and skip scan, and the
session state file `docs/reference/SESSION_2026-10-09_STATE.json` (S10-09).
Status shows what this session did with each item. "User" marks a decision
the user must make.

## Tier A: correctness and data provenance

| # | Item | Evidence | User | Status |
|---|---|---|---|---|
| A1 | Parsing turns a missing or unparseable rank and calculated points into `0`, and a missing gender into a default | `parsingPipeline.ts:99-115,133-147` (audit 10-02, finding 2) | N | done: `8b294c0b` (ParsedRowError, 422) |
| A2 | The Python scorer falls back to D2 when settings are absent. Python and TypeScript disagree on malformed point strings | `backend/point_calculator.py:9,124-129,213-224` (findings 5, 6) | N | done: `ee466bf6` (ScoringSettingsMissing, D2 fallback removed) |
| A3 | Preset IDs are joined into file paths without the ID validator on create and update | `scoringPresetRoutes.ts:179-180,325-333` (finding 3) | N | done: `c8e39242` (userPresetFilePathIn, InvalidPresetIdError) |
| A4 | Undo fingerprint omits `relayLegOverrides`. Unproven: needs a failing test first | `useSwimEditUndo.ts:46` | N | done: optimizer Undo fixed (`e0be7d0c`); swim-edit Undo not reproducible; `removeProjectedSwim` now prunes unresolvable fills |
| A5 | An estimated relay earns a real cut tag. The split inspector shows estimates as "Known (PDF)" | `teamCardView.ts:53-63`, `RelaySplitInspector.tsx:21` | N | done: `010c3022`, `c215b244` |
| A6 | Season analytics sums theoretical points. The cap caveat is dropped when no relay program exists | `seasonAnalytics.ts:128-149`, `theoreticalMeetSeeds.ts:1501` | N | done: `c215b244`, `010c3022` |
| A7 | Saved theoretical relay rows hold estimated times in `relayLegSplit` | S10-09 T2b | N | open (architect) |
| A8 | Save-sequence numbers live in memory. The Postgres update is read-then-write. Restore resets the version | S10-09 T3 risks | Y | open |
| A9 | The old `RELAY_DESIGNATOR` never matches real pages. A relay row with no legs gives no warning | S10-09 T1 | N | fixed: parenthesised designator read, `relay-row-without-legs` warning; `tests/relayRowWithoutLegs.test.ts` |
| A10 | Tied relays each get full place points. Tied individual swims split them | `utils.ts` `scoreRelaysInEvent` | **Y** | waiting on user |
| A11 | `presetIdForConference` matches by substring ("Sectional" picks a preset via "SEC") | `scoringDefaults.ts:508-518` | Y | waiting on user |
| A12 | The `/times/` id join is not verified on a live capture | S10-09 T1 | Y | needs a live capture |
| A13 | A relay fill naming a swimmer who still has other rows but no row the fill resolves to shows `—` at the held clock, unflagged, not vacant (cause: `resolveRelayLegs` falls back to the held leg time, `utils.ts` ~3187) | bug-hunter probe 2026-10-10 | N | done: named fill that stops resolving reads vacant; time-only clock hold kept |
| A14 | The A and B relay `relay_needs_fill` messages are identical, so a coach cannot tell which entry needs a leg | lineup audit | N | done: message names round and place |

## Tier B: test and infra gaps

| # | Item | Evidence | User | Status |
|---|---|---|---|---|
| B1 | Check that the e2e step really runs in CI. Add `npm run test:harness` | `.github/workflows/ci.yml:60-90` | N | done: e2e, unit suite, skip budget and harness all run in CI (green run 38013108804) |
| B2 | Tests skip silently when local fixtures or `pdftotext` are absent. Report the skip count and fail when it grows | `tests/eventFirstImport.test.ts:126` | N | done: `scripts/check_skip_budget.mjs`, `tests/skip-budget.json` |
| B3 | The meet 356467 regression guard depends on crawl state. Commit minimal redacted fixtures | vault 04, 2026-10-04 | Y | open |
| B4 | The harness redirect scenario is `test.fixme` | `tests/harness/extension.harness.spec.ts:229` | N | kept as fixme with the reason documented (`569a40c8`); unit-covered |
| B5 | `main-thread-budget` e2e times out over many local workspaces | S10-09 | N | fixed: measures a seeded workspace plus named real ones; budget unchanged |
| B6 | The Postgres v8 DDL has never run | `relayLegCreditsPersistence.test.ts` | N | done: ran green in CI run 38013108804 (Postgres 16) |
| B7 | `apps/shell/dist/server.js` goes stale | S10-09 T3, T8 | N | rebuilt by `run-tests.mjs` |
| B8 | Seed and migrate scripts write to the real `data/` with no guard | `seed_hsu_roster.mjs:29-30`, `seed_obu_roster.mjs:38-39`, `migrate-json-to-sqlite.mjs:18` | N | fixed: `scripts/lib/dataDir.mjs` (OMNI_DATA_DIR + running-server guard), `scripts/test_data_dir_guard.mjs` |
| B9 | The real DB holds 39 test workspaces, and an old server runs on port 3000 | S10-09 T8 | Y | waiting on user |
| B10 | Confirm the `optimizeWithArbitrage` never-loses test exists | `scripts/test_arbitrage_never_loses.mjs` | N | done: exists and runs in `run-tests.mjs` |
| B11 | Two lint complexity warnings remain | `swimCloudMeetImportBridge.ts` | N | open |
| B12 | 13 scripts need the untracked `data/meets.json`, so CI skips them whole. Split out checks that need no local data (for example the static cut labels in `test_cutlines.mjs`) so CI runs them | `scripts/run-tests.mjs` (`be982fe1`) | N | done: 12 of 13 scripts now run their local-free checks in CI through `scripts/lib/localMeets.mjs`. Each skipped part prints `LOCAL-ONLY SKIPPED`, and the runner lists them. `test_relay_overrides.mjs` stays local-only (every check reads the real relay data). Still local-only: `test_roster_optimizer.mjs` self-skips on the same file (not in the 13) |

Done this session: Playwright no longer reuses a server on the port unless
`PLAYWRIGHT_REUSE_SERVER=1` is set (`docs/INVARIANTS.md` §4).

## Tier C: UX and product

| # | Item | User | Status |
|---|---|---|---|
| C1 | Open a PR for the branch | N (authorised) | done: PR #6 |
| C2 | Capture the NSISC `/teams/` page. Run one live multi-team crawl | Y | waiting on user |
| C3 | Record which events were removed in a theoretical meet. Add sourced relay programs beyond NSISC | Y | open |
| C5 | One-click "All teams" apply. Lineup Remove behaviour | Y | waiting on user |
| C6 | Place-point tables seed `[0]` and pad with 0 when they grow | Y | waiting on user |
| C7 | A "relays per swimmer, at most N" setting | N | done: `010c3022` |

Done this session: the theoretical banner gate, the `/metrics` comparison
skip, `teamDivisionTag` by season, and the double-create guard.

## Tier D: cleanup and doc debt

| # | Item | Status |
|---|---|---|
| D1 | `plans/STATE.md` is stale (body from 2026-08-16) | partly: current header added (`d190c306`); the body is still layered history (plan item H1) |
| D2 | `AUDIT_2026-09-02.md` still lists ROCK/INDY/LU as open (fixed in `07fb5ae5`) | done: `d190c306` |
| D3 | Vault `04-Known-Issues` is a layered history | vault pass |
| D4 | Dead references to the retired fleet harness | done: one live instruction marked retired (`docs/video/VIDEO_ANALYSIS_MASTERPLAN.md`) |
| D5 | Dead code: `npById`, `CapVoidSummary.byAthlete` | done: `npById` already gone; `byAthlete` removed |
| D6 | Remote branch `cloud/c1-team-names-harness` | user |

The next plan is `docs/reference/IMPROVEMENT_PLAN_2026-10-10.md`. It carries every open item above forward.
