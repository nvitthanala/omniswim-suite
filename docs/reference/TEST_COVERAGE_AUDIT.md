# Test Coverage Audit

Audited 2026-08-30. Every test file in the repo was read in full and judged on
one question: would a plausible regression in the code under test make it fail?

A passing test is not evidence. Several files here pass because they cannot fail.

---

## 1. Summary

| Suite | Files | Cases / assertions |
| --- | --- | --- |
| `tests/*.test.ts` (vitest) | 6 | 35 cases, ~185 `expect()` calls |
| `scripts/test_*.mjs` | 69 on disk, **63 in the runner** | ~16,200 lines, ~1,470 assert-ish statements |
| `tests/e2e/*.spec.ts` (playwright) | 3 | ~26 `expect()` calls |
| **Total** | **78** | **~1,680 assertions** |

Verdicts across the 75 unit and script files, one bucket each:

| Verdict | Count | Meaning |
| --- | --- | --- |
| Solid | 64 | A real regression makes it fail. |
| Weak | 6 | Asserts something real, but too little, or against data that can vanish. |
| Pushover | 5 | Cannot fail, or asserts a tautology. |

The 3 playwright specs are counted separately: they are sound but cannot run
here, because the browsers are not installed.

Skippability cuts across those buckets. Ten files skip under some condition; two
of them — `test_individual_scoring.mjs` and `test_relay_scoring.mjs` — are
permanently skipped on any clean checkout *and* are pushovers. See §2.

Four weak or pushover files were repaired during this audit. The fifth pushover
cannot be fixed without an implementation change, and is documented instead.

### The single biggest gap

**`optimizeWithArbitrage` has no never-loses guard, and no test covers it.**

The repo already fought this exact bug once. `scripts/test_optimizer_never_loses.mjs`
documents it as a P0: `optimizeRosterForTeam` scored its own output, never
compared it to the starting total, and returned a lineup that took Henderson
State men from 1277.00 to 0.00 with no warning. That function was fixed and is
now covered by 29 assertions.

`optimizeWithArbitrage` in `packages/core/src/lib/rosterArbitrage.ts` is a second
optimizer entry point with the same original shape. It computes `previousTotal`,
computes `projectedTotal`, and returns unconditionally. It never compares them.
It reports no `outcome` and no `appliedStages`, so a caller cannot tell a refusal
from an improvement. It calls `optimizeScorersForTeam` — the exact stage the
never-loses test proves is destructive on a recruit-only workspace.

Reproduction, using the fixture from `scripts/test_optimizer_never_loses.mjs`
unchanged:

```
optimizeRosterForTeam  (GUARDED)            400.45 -> 400.45   outcome=unchanged
optimizeWithArbitrage  (individual_first)   400.45 -> 380.45   LOWERED THE TEAM TOTAL
optimizeWithArbitrage  (relay_first)        400.45 -> 380.45   LOWERED THE TEAM TOTAL
```

Same workspace, same settings, same seconds. The guarded path refuses the losing
candidate. The unguarded twin hands back a lineup worth 20 points less and calls
it an optimization. This is the failure mode `CLAUDE.md` warns about: nothing
throws, and a coach may act on the result.

Why no test caught it:

- `scripts/test_optimizer_never_loses.mjs` only exercises `optimizeRosterForTeam`.
- `scripts/test_roster_arbitrage.mjs` was the only file touching
  `optimizeWithArbitrage`. It asserted `meetEntryPlans.length >= 0`, which is
  true of every array in JavaScript.

**This is an implementation fix and belongs in a separate task.** Do not treat a
green suite as evidence that the arbitrage optimizer is safe. The fix is to give
`optimizeWithArbitrage` the same guard and the same `outcome` / `appliedStages`
contract, then extend `test_optimizer_never_loses.mjs` to loop over both entry
points instead of naming one.

### Second finding: computed team totals disagree with the official results

`scripts/test_nsisc_team_totals.mjs` checks the engine against all seven
published 2026 NSISC team totals. **It is not in `scripts/run-tests.mjs`, so it
never runs — and it currently fails.**

```
OK    Women University of West Florida  1239.00   official 1239     delta   0.00
FAIL  Women Delta State University       936.00   official  916     delta +20.00
OK    Women Ouachita Baptist University  536.00   official  536     delta   0.00
OK    Women Henderson State University   476.00   official  476     delta   0.00
OK    Men   Henderson State University  1056.00   official 1056     delta   0.00
OK    Men   Ouachita Baptist University 1029.50   official 1029.5   delta   0.00
FAIL  Men   Delta State University       874.50   official  875.5   delta  -1.00
```

Five of seven match exactly, including both half-point totals. Delta State does
not. This reproduces identically against the committed `data/meets.json` and the
working copy, so it is not caused by the roster seeding done today.

The scorer cap is **not** the cause. Delta State men show 19 distinct scoring
names against a documented cap of 18, but four of them are divers and
`diverScorerWeight` is 1/3, so the real slot count is 15 + 4/3 = 16.33 — inside
the cap. The cap binds correctly in both `roster` and `points_pool` modes.

CI does check one official total: `scripts/test_dq_scoring.mjs` pins Henderson
State men at 1056. That is 1 of 7. Both wrong totals sit in the unchecked 6.

Adding `test_nsisc_team_totals.mjs` to the runner would turn `npm test` red
today, so it must land together with the scoring fix, not before it.

---

## 2. Cross-cutting findings

### Six test files never run

These are on disk but absent from `TESTS` in `scripts/run-tests.mjs`:

| File | State |
| --- | --- |
| `scripts/test_nsisc_team_totals.mjs` | Good test. **Fails.** See above. |
| `scripts/test_roster_catalog.mjs` | Good test. Passes. Should be added. |
| `scripts/test_eligibility_toggle.mjs` | Good test. Passes. Should be added. |
| `scripts/test_conference_pdfs.mjs` | Weak. Needs PDFs in the repo root. |
| `scripts/test_post.mjs` | Not a test. Manual poke at a live server. |
| `scripts/test_acc_post.mjs` | Not a test. Manual poke at a live server. |

`test_roster_catalog.mjs` and `test_eligibility_toggle.mjs` are free coverage
being thrown away. Both pass right now.

### Test independence: clean

No test writes to `data/meets.json` or `data/omniswim.db`. The only two files
that write at all — `test_sqlite_roundtrip.mjs` and `test_workspace_scope.mjs` —
write to `os.tmpdir()`. `test_roster_catalog.mjs` and `test_eligibility_toggle.mjs`
use `fs.mkdtemp`. The suite is idempotent and does not contaminate the seeded
HSU and OBU roster workspaces.

### Coupling to live user data

Fourteen files read `data/meets.json` as a fixture. That file is user-editable, so
a lineup edit can change what these tests assert against. Most handle it well and
skip loudly. Two do not:

- `scripts/test_chart_data.mjs` — `if (!hasData) continue`. If every workspace
  lost its results, the loop would assert nothing and the file would still pass.
  It throws only when the array is empty, not when the workspaces are.
- `scripts/test_relay_overrides.mjs` — line 178 prints
  `SKIP autofill/double-book: no eligible candidate` **mid-file** and keeps going.
  The runner only counts a skip when stdout *starts* with `SKIP`, so this block
  can vanish while the file still reports `PASS`. It does run today.

The better pattern is already in the repo: `test_optimizer_never_loses.mjs` and
`test_scoring_settings_effect.mjs` both build hermetic fixtures in-process and say
so in their headers.

### Tests that skip cleanly

A green `npm test` currently hides these seven:

| File | Skips when |
| --- | --- |
| `test_individual_scoring.mjs` | `tests/test_nsisc_output.json` absent — **it is absent, so this never runs** |
| `test_relay_scoring.mjs` | Same fixture — **never runs** |
| `test_pg_roundtrip.mjs` | No `PG_TEST_URL` / `DATABASE_URL` |
| `test_nsisc_psych.mjs` | Fixture PDF absent (present today, so it runs) |
| `test_team_rankings_parser.mjs` | Python not on PATH |
| `test_chart_bundle.mjs` | `dist/` not built — the bundle scan silently drops |
| `test_relay_overrides.mjs` | No men's relay with a senior leg in `meets.json` |

The two fixture-gated scoring tests are the notable ones: both are permanently
skipped on any clean checkout, and both are pushovers anyway (see below).

### Suite status at the time of writing

`node scripts/run-tests.mjs` reports **59 passed, 2 failed, 3 skipped**. Neither
failure comes from this audit:

- `test_cross_course_arbitrage.mjs` — fails at line 459, a fast-path vs full-rescore
  parity check (`meet-pool: deltaPoints Alpha Two|100 Freestyle|50 Freestyle`). It
  passed at the start of this audit and broke when a concurrent agent edited
  `packages/core/src/lib/utils.ts` and `rosterOptimizer.ts`. Flagged for whoever
  owns that change.
- `playwright e2e` — pre-existing environment problem. The browsers are not
  installed (`npx playwright install`). All three e2e specs are unrunnable here.

`npx vitest run` is green: 6 files, 35 tests. `npm run lint` is clean.

---

## 3. Per-file verdicts

### `tests/*.test.ts` — vitest

| File | What it actually verifies | Verdict |
| --- | --- | --- |
| `tests/raceAnalysis.test.ts` | `analyzeRace` on two hand-built races. Pins ~60 computed values to 6 decimals, checks units, `absent` vs `value`, `provenance`, and that splits sum to race time. Covers missing turn tags, unresolvable length order, zero-interval denominators. | **Solid** — the model file |
| `tests/workspaceSelectionStability.test.ts` | `SuiteWorkspaceProvider` against a fake server. Asserts on the *commit log*, so a flapping selection is caught rather than hidden by the final value. Covers rejected DELETE and failed list refetch. | **Solid** |
| `tests/athleteHistory.test.ts` | `parseSwimCloudMultiProfile` block splitting against header lines copied from `oburoster202627.txt`. Tests both directions: a club line must not become an athlete, and a real name must not be swallowed. Pins that a diver's five diving scores import as zero swims, not as times. | **Solid** (first case strengthened — see §4) |
| `tests/seasonAnalytics.test.ts` | `buildSeasonTrends` best-time selection, cross-workspace merge, progression ordering, relay exclusion, and minutes-vs-seconds comparison. | **Solid** (rewritten — see §4) |
| `tests/reportBuilder.test.ts` | `buildMeetReportHtml` row rendering, the empty state, result counts, and HTML escaping of the name and every cell. | **Solid** (rewritten — see §4) |
| `tests/raceAnalysisPurity.test.ts` | Greps `packages/core/src/lib/raceAnalysis` for `?? 0`, `\|\| 0`, `?? 1`, most `Math.*`, and the word `fatigue`. A source-text guard, not a behaviour test, but it is the right tool for "no silent fallback constant crept back in". | **Solid** (narrow by design) |

### `tests/e2e/*.spec.ts` — playwright

| File | What it actually verifies | Verdict |
| --- | --- | --- |
| `tests/e2e/main-thread-budget.spec.ts` | No Manager wizard step blocks the main thread past a budget. Contains one legitimate `test.skip` when the browser lacks `PerformanceObserver` longtask support. | **Conditionally skipped** — cannot run, no browsers |
| `tests/e2e/matrix-chart.spec.ts` | The Matrix timeline renders an SVG with no `ResponsiveContainer` and no `-1` sizing warnings. | **Conditionally skipped** — cannot run, no browsers |
| `tests/e2e/production-server.spec.ts` | The built server serves the app. | **Conditionally skipped** — cannot run, no browsers |

### `scripts/test_*.mjs` — pushovers and weak files

| File | Problem | Verdict |
| --- | --- | --- |
| `scripts/test_relay_scoring.mjs` | **Zero assertions.** 57 lines of `console.log`. Exits 0 no matter what the engine returns. Also gated on `tests/test_nsisc_output.json`, which is absent, so it has never run here. | **Pushover** |
| `scripts/test_individual_scoring.mjs` | One check: `eventEvents.size < meetEvents.size * 0.5`. A smoke ratio, not an invariant — meet-scope and event-scope scoring could both be badly wrong and still sit within 2x. Everything else is logging. Also permanently fixture-skipped. | **Pushover** |
| `scripts/test_roster_optimizer.mjs` | Asserts `Array.isArray(result.overrides)` and `typeof result.projectedTotal === 'number'`. Both pass for `{overrides: [], projectedTotal: NaN}` — `NaN` is a number. An optimizer that returns an empty, losing, or nonsense lineup passes. | **Pushover** |
| `scripts/test_post.mjs` | Not a test. POSTs a PDF to `localhost:3000` and logs the team list. Catches every error and prints it, exiting 0. Not in the runner. | **Pushover** |
| `scripts/test_acc_post.mjs` | Identical to the above with a different PDF. | **Pushover** |
| `scripts/test_conference_pdfs.mjs` | The main loop logs `PARSE FAIL` / `SCORE FAIL` and `continue`s — a parser that fails on all four PDFs reports nothing wrong. Only the final SEC block sets a non-zero exit. Not in the runner, and needs four PDFs in the repo root. | **Weak** |
| `scripts/test_chart_data.mjs` | Assertions are shape-level (`timelineData.length > 0`, `Object.keys(row).length < 3`). `topTeam.totalPoints > 0` is the only numeric check. `if (!hasData) continue` lets the whole file pass vacuously if the workspaces lose their results. | **Weak** |
| `scripts/test_relay_overrides.mjs` | Real assertions with a custom accumulator and a correct non-zero exit. Loses points for the mid-file skip that still reports `PASS`. | **Weak** |
| `scripts/test_athlete_history.mjs` | Mixes a strong exact check (`blaiseResult.swims.length === 15`, badge assertions) with loose ones against live `meets.json` (`history.length > 0`, `merged.length >= ...`). The loose half proves little. | **Weak** |
| `scripts/test_athlete_lineup_editor.mjs` | Sound characterization test of the drawer's rendered output. Its banner claimed the file had never been executed; that was stale and is corrected (see §4). Still pins current behaviour, not intended behaviour. | **Weak** by nature (characterization) |
| `scripts/test_team_colors.mjs` | 21 exact colour lookups, with well-chosen near-miss pairs (Ohio State vs Ohio, Indiana vs Indiana of Pennsylvania). Values are hand-typed with no source, but team colours are not competition data, so the provenance rule does not bite hard. | **Weak** (values uncited) |
| `scripts/test_team_rankings_parser.mjs` | Strong on the real point: half-point totals surviving pdfplumber's split, and a loud raise on an unsplittable line. Pins a doubled school key (`"Henderson State University Henderson State University"`), so a future fix to name doubling will break it. | **Solid**, with one brittle expectation |

### `scripts/test_*.mjs` — solid files

These 50 files pin real computed values, specific error codes, or specific
shapes, and would fail on a plausible regression. Grouped by area.

**Provenance and cut standards**
`test_cutlines.mjs` (spot-checks published times, re-hashes every archived PDF
against `manifest.json`, bans `proj_*` fields, and requires every event label in
`meets.json` to resolve or sit on an explicit expected-absent list) ·
`test_cutline_tags.mjs` (unmapped team must not read as D1; discontinued and
unsponsored programs render unknown) · `test_cut_division_absent.mjs` (picks a
swim the D1 and D2 tables disagree about, so the wrong table is visible in the
answer) · `test_parse_plausibility.mjs` (rejects the real `375 Freestyle`
artefact while proving the whole live event census still parses) ·
`test_conversion_keys.mjs` · `test_course_conversion.mjs` · `test_team_aliases.mjs`

**Scoring engine**
`test_optimizer_never_loses.mjs` (asserts the fixture reproduces the bug *before*
testing the guard, so it cannot pass vacuously) · `test_tie_group_scoring.mjs` ·
`test_scoring_settings_effect.mjs` (proves which settings the NSISC lock discards,
and disproves two wrong theories in code) · `test_settings_lock.mjs` ·
`test_dq_scoring.mjs` (pins HSU men at the official 1056 and a DQ at 0 points) ·
`test_event_identity_scoring.mjs` · `test_scoring_theory.mjs` ·
`test_entry_limits.mjs` · `test_entry_limits_aliases.mjs` · `test_relay_splits.mjs` ·
`test_relay_swaps.mjs` · `test_prelims_projection.mjs` · `test_psych_projection.mjs` ·
`test_momentum_series.mjs` · `test_scenario_diff.mjs` (checks swimmer deltas sum
to the total delta) · `test_swim_editor.mjs` · `test_lineup_audit.mjs` ·
`test_eligibility_toggle.mjs` *(orphaned)* · `test_nsisc_team_totals.mjs`
*(orphaned, failing)*

**Aliasing and identity**
`test_athlete_aliases.mjs` · `test_alias_scorer_roster.mjs` ·
`test_athlete_autolink.mjs` (real HSU duplicates, tier rules, hard blockers) ·
`test_duplicate_athletes.mjs` · `test_roster_removal.mjs`

**Import and parsing**
`test_multi_profile_import.mjs` · `test_history_import_roster.mjs` ·
`test_meet_program_events.mjs` · `test_nsisc_psych.mjs` ·
`test_compact_event_label.mjs` (15 exact label transforms) ·
`test_event_quality_ranking.mjs`

**Arbitrage**
`test_arbitrage_units.mjs` (catches the bug where seconds were labelled points) ·
`test_cross_course_arbitrage.mjs` *(currently failing — concurrent change)* ·
`test_cross_course_arbitrage_view.mjs` · `test_drop_add_analysis.mjs` ·
`test_fast_swap_context.mjs` (guards a fail-closed optimization that would
otherwise silently stop engaging) · `test_roster_arbitrage.mjs` *(rewritten, §4)*

**Persistence and infrastructure**
`test_sqlite_roundtrip.mjs` · `test_pg_roundtrip.mjs` ·
`test_persistence_parity.mjs` (diffs the two hand-written SQL bodies so a column
added on one side cannot be dropped on the other) · `test_workspace_scope.mjs`
(cross-tenant delete) · `test_roster_catalog.mjs` *(orphaned)* ·
`test_server_binding.mjs` · `test_workspace_naming.mjs` ·
`test_working_copy_changes.mjs` · `test_meet_source.mjs` ·
`test_workspace_scoring_debounce.mjs` · `test_chart_render.mjs` ·
`test_chart_shell.mjs` · `test_theme_css.mjs` · `test_chart_bundle.mjs`

---

## 4. Changes made during this audit

Test-only. No implementation file was touched.

| File | Change |
| --- | --- |
| `scripts/test_roster_arbitrage.mjs` | Rewritten. Dropped `meetEntryPlans.length >= 0` and the bare `Array.isArray(cards)`. The old fixture had one team, so `buildArbitrageCards` returned `[]` from its early exit and the card path never ran. Now uses a one-team fixture and a two-team fixture to separate "no point value can be stated" from "no swap gains anything". Totals are checked with `Number.isFinite`, not `typeof === 'number'`, so `NaN` fails. Also checks that no `activeEntryIds` entry dangles and that the input workspace is not mutated. Carries a header documenting the unguarded-loss defect that is deliberately **not** asserted, because asserting it would turn the suite red. |
| `tests/reportBuilder.test.ts` | Rewritten. The old test built a report from an empty workspace and checked only the name and doctype, so deleting the whole results table would have passed. Now covers row rendering, best-time selection, the empty state, result counts, and HTML escaping. |
| `tests/seasonAnalytics.test.ts` | Rewritten. The single case was named "across workspaces" but passed one workspace. Adds a real cross-workspace merge, progression ordering, non-merging of different swimmers and events, relay exclusion, and a minutes-vs-seconds case that a string comparison would fail. |
| `tests/athleteHistory.test.ts` | First case strengthened. It asserted `swims.length > 0` and `swims[0].event` matching `/Freestyle\|Breaststroke/` — an alternation that cannot tell the two rows apart. Now pins both rows field by field, and asserts `computedCut` stays null for a team with no known division. |
| `scripts/test_athlete_lineup_editor.mjs` | Retired the stale `!! UNVERIFIED — NEVER EXECUTED !!` banner. The file is in the runner and has been green for weeks. Replaced with an accurate note that it is a characterization test. |

---

## 5. How to add a real test here

Follow `scripts/test_optimizer_never_loses.mjs` and `scripts/test_cutlines.mjs`.
They are the two best files in the repo and they do different jobs well.

**From `test_optimizer_never_loses.mjs` — prove the fixture reproduces the bug first.**
Before testing that a guard works, it asserts the *unguarded* path still destroys
the workspace:

```js
assert.ok(rosterResult.previousTotal > 0, 'roster fixture must score before optimizing');
assert.ok(rosterResult.unguardedTotal < rosterResult.previousTotal,
  'fixture no longer reproduces the defect');
```

Without those two lines the whole file would pass against a workspace that never
scored — the silent-empty failure mode. Then it checks that a refusal returns the
caller's original state untouched, that every stage selector is guarded and not
just `'all'`, and that the optimizer does not mutate its input.

**From `test_cutlines.mjs` — make upstream drift break CI.**
It re-hashes every archived PDF and compares against `manifest.json`, so a swapped
or truncated source cannot quietly back a "verified" number. It then requires every
event label in `data/meets.json` to either resolve to a published row or appear on
an explicit `D2_EVENTS_WITHOUT_A_PUBLISHED_STANDARD` list. Nothing is allowed to
resolve to nothing by accident.

The checklist both files satisfy:

1. **Build the fixture in-process.** Do not read `data/meets.json` unless the test
   is specifically about live data. State that in the header, as both files do.
2. **Assert the fixture is non-degenerate before asserting the behaviour.** A
   total must be positive before you test that something reduces it.
3. **Pin exact values, not shapes.** `toBeCloseTo(2.375, 6)` catches a regression;
   `typeof x === 'number'` accepts `NaN`. Use `Number.isFinite`.
4. **Separate absent from empty.** A lookup that matches nothing must be
   distinguishable from a real negative. `test_cut_division_absent.mjs` picks an
   input the two candidate tables disagree about, so the wrong answer is visible.
5. **Test the true-positive direction too.** `test_parse_plausibility.mjs` spends
   most of its length proving the new gate does not over-reject real events.
6. **Write the defect into the header.** Every strong file here opens with the bug
   it pins, the measured numbers, and what breaks if someone "simplifies" it away.
7. **Fail loudly.** Use `node:assert/strict` or a non-zero exit. `console.assert`
   writes to stderr and exits 0; the runner has a guard against it at
   `scripts/run-tests.mjs:118`, which exists because three files once used it and
   reported `PASS` regardless of what they found.
