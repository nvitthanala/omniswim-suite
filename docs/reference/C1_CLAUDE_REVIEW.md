# C1 review (Claude lead, 2026-10-31)

Target: `packages/engine/src/report/index.ts`, `tests/engineReport.test.ts`,
the C1 export lines in `packages/engine/src/index.ts`. Codex wrote it.
Spec: `plans/2026-10-25/D6-DASHBOARD.md` sections 2 and 4.

**Verdict: reject until fixed.** The parsers are sound. Five defects and the
code style block it.

## Blocked on me

None.

## Found

### HIGH 1. `diffResults` has the wrong shape (`report/index.ts:116-117`)

D6 2 asks for the shape of `ScenarioDiffResult` (`lib/scenarioDiff.ts:55-101`):
per-swimmer rows (events added, removed, changed, points then and now), per-event
rows, and team totals, each with `inThen` and `inNow`. The build returns one
team total. Also:
- An absent side must read `null`, never 0 (D6: "an absent side is never
  zero"). Use `number | null` for each "then" and "now" value.
- The meet-key check (`line 117`) repeats one condition twice. Throw a typed
  error (for example `ReportDiffError` with code `meet_key_mismatch`), not a
  bare `Error`.
- Relay rows: keep the relay as one row, as `ScenarioSwimmerDiff.isRelay`
  does.

### HIGH 2. A dive score prints as a time (`report/index.ts:124`)

`entryCsv` formats a `score` seed with `formatTime`. A dive score of 250.00
(25000 hundredths) prints "4:10.00". Print a score as points with two
decimals ("250.00"). Add a test.

### MEDIUM 3. `not_convertible` is missed for unpinned entries (`report/index.ts:66`)

With no `seedSwimId`, the reason is always `no_time`, even when the swimmer's
only swims in the event are `not-convertible`. Use `not_convertible` when
every swim of the swimmer in that event is `not-convertible`. Add a test.

### MEDIUM 4. A second class-year type (`report/index.ts:59`)

`ClassYearCode` repeats the union at `model/meet.ts:34`. User question E1
(FR/SO/JR/SR/GR against the legacy HS) is open, so two copies would split
the answer. Derive it: `MeetModel['swimmers'][number]['classYear']`, or
export one named type from `model/meet.ts` and reuse it. Keep the exported
name `ClassYearCode`.

### MEDIUM 5. Silent fallbacks in the CSV

- A missing swimmer name falls back to the swimmer id (`names[id]?.name ?? id`).
  Report it as a `CsvIssue` ("name missing") instead of writing the id under
  "Full Name". A stripped export (no SwimCloud data) has no display block, so
  the CSV must say why the names are empty, not guess.
- An entry with no result row writes empty Place and Points. Report it as
  an issue too.

### MEDIUM 6. Style and lint (`report/index.ts`, whole file)

- The file packs whole functions onto single lines (up to about 1,500
  characters). The rest of `packages/engine` writes one statement per line
  with doc comments. Rewrite it in that style.
- Split the module by function: `parse.ts`, `facts.ts`, `progression.ts`,
  `points.ts`, `diff.ts`, `csv.ts`, plus `index.ts` re-exports.
- Remove both `eslint-disable-next-line complexity` lines by splitting the
  functions (`tests/eslintDisableReasons.test.ts` fails on them).
- The `\u0001` text marker in `entryCsv` is fragile. Build each row as typed
  cells (`{ kind: 'text', value } | { kind: 'number', value }`) and guard
  only the text cells.

### LOW 7. Excel reads "1:52.34" as a time

A quoted "1:52.34" is still parsed by Excel as a clock time. D6 acceptance
(U-d) needs it to read back as written. Do not fix it here. Keep "Seed" a
text cell, and add a comment pointing at U-d's Excel check.

## Tests to add or strengthen

Each rule in D6 2 and 4 needs its own named test, as the brief said. The
19 tests are too thin to cover them. At least:
- progression: each placement rule, the ordering rules, unplaced switches
  the whole chart, each team has a series, series end equals team points
  (1e-9 and exact quarters);
- `swimmerPoints`: relay quarters, and per-team sums;
- `diffResults`: the new shape, absent side null, meet-key mismatch;
- facts: every seed equals `resolveLineup(...).value` on config C, recorded
  beats converted on a tie, `not_convertible`;
- CSV: dive score, name-missing issue, quoting, formula guard on text
  cells only, BOM, CRLF and final CRLF, one row per relay leg, points sum to
  the team total, "José".
