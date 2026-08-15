# 06 — Testing and verification

Current baseline: **46 passed / 0 failed / 3 skipped** (`npm test`), 13 unit
tests (`npm run test:unit`), lint clean across 7 packages, build exit 0.

The suite is genuinely good for a project this size — 46 scenario tests over
scoring, relays, cutlines, aliasing, persistence parity. What follows is where it
does not prove what it appears to.

---

## 1. Three tests are permanently skipped

**Severity: P1.**

```
SKIP  test_individual_scoring.mjs (needs tests/test_nsisc_output.json)
SKIP  test_relay_scoring.mjs (needs tests/test_nsisc_output.json)
SKIP  PostgreSQL round-trip test (set PG_TEST_URL to run)
```

The first two are **the scoring tests** — the ones that would verify individual
and relay points against a known-good NSISC output. They have been skipping long
enough that the fixture is not in the tree, so the two most important assertions
in the suite have never run in this checkout.

Every scoring change today (four commits touching the scoring path) was verified
against *other* tests and live-data probes. That worked, but it is not the same
as having the reference fixture.

**Proposed:** generate `tests/test_nsisc_output.json` from the loaded NSISC meet
once, review it by hand against the published results PDF (which is archived),
then commit it. From then on the two tests are a genuine regression guard on team
totals.

- **Effort:** ~2 hours, most of it the hand-check.
- **Caveat:** the fixture must be checked against the **PDF**, not against the
  app's current output, or it just freezes whatever the app does today —
  including any bug.

---

## 2. The chart bundle test shells out to `npm ls`

**Severity: P1 (flaky).** `scripts/test_chart_bundle.mjs:49`

```js
execSync('npm ls recharts --all')
```

On a fresh clone this failed with an npm-internal error
(`Cannot read properties of null (reading 'edgesOut')`) — nothing to do with the
project. The test's actual intent (recharts must not be duplicated / must be
bundled once) is sound; the mechanism is fragile because it depends on npm's tree
state rather than on the build output.

**Proposed:** assert against `dist/assets/*.js` directly — the bundle is the
thing being claimed about, and `test_chart_bundle` already has access to it.
**Effort:** ~1 hour.

---

## 3. No test drives the production server

**Severity: P1.** This is how `7af56513` reached `main`.

`playwright.config.ts` starts `npm run dev`. Every e2e test therefore exercises
the **dev** path (`tsx server.ts`). The production path (`node dist/server.js`,
`NODE_ENV=production`) — the one `Start-OmniSwim-Suite-Prod.bat` uses and the one
a synced laptop runs — was never executed by CI or by any test.

Its `PROJECT_ROOT` resolved one directory too high, so it served 404 on every
page and seeded an empty database. Found only by cloning the repo fresh and
running the launcher by hand.

**Proposed:** one smoke test against the built server:

```
npm run build
NODE_ENV=production PORT=3101 node apps/shell/dist/server.js
  → GET /            expect 200 and a non-trivial body
  → GET /api/workspaces  expect the seeded workspaces
```

- **Effort:** ~2 hours including CI wiring.
- **Value:** disproportionate. This is the only test that would have caught a
  total product failure, and it is ~20 lines.

---

## 4. Encode the prose rules as tests

**Severity: P1. Highest value-per-hour in this folder.**

`CLAUDE.md` states four rules that are currently enforced by review only. Three
of today's four bugs violated one of them and shipped anyway.

| Rule (prose today) | Proposed mechanical check | Would have caught |
| ------------------ | ------------------------- | ----------------- |
| *"No `?? 0` / `\|\| 0` on any race value"* | Lint rule over `packages/core/src/lib`, allowlist the legitimate accumulators | the `scenarioDiff` cases in [01](01-fabricated-values.md#3--0-on-competition-values--audit-do-not-assume) |
| *"Unknown division ≠ D1"* | Ban `divisionForTeam` outside `data/teamDivisions.ts` | [01#2](01-fabricated-values.md#2-an-unmapped-team-is-still-scored-against-the-d1-table) |
| *"Every value traces to a primary source"* | Every `CONVERSION_FACTORS` key must round-trip through `normalizeEventLabel` unchanged | **the IM bug** (`ad616e69`) |
| *"Absent ≠ empty"* | Every `compareTimeToCutline` caller must branch on `status`, not just `achieved` | latent cut-tag misreporting |

The third is 15 minutes of work and is the exact assertion that would have caught
57 fabricated conversions.

**Effort:** ~1 day for all four. **Recommendation:** do the conversion-key one
today; it is the cheapest guard in the whole plan.

---

## 5. No test asserts the units of a user-facing number

**Severity: P1.** The direct lesson of
[01#1](01-fabricated-values.md#1-arbitrage-points-are-not-points).

`buildArbitrageCards` emits a field called `arbitragePts` whose value can be
**58.7** when the maximum any individual event awards is **20**. No test noticed,
because the tests check that cards are produced and ordered — not that the
numbers are dimensionally possible.

> **Correction, 2026-08-14.** The first bullet below is **wrong** and was
> rejected in practice — see [WORKLOG-01 §5](WORKLOG-01-arbitrage-units.md).
> `max(SCORING_POINTS)` bounds *one swim's* points, not a *team-total* delta:
> moving a swimmer out of an event promotes every teammate behind them, so a
> legitimate swap can move a team total by more than any single event awards
> (measured: +40.5, verified reproducible). The assertion that holds is internal
> consistency — `deltaPoints === newTotal - baseTotal`, and applying the swap
> reproduces it. Implemented in `scripts/test_arbitrage_units.mjs`.

**Proposed:** a "sanity envelope" test per user-facing quantity:

- ~~no individual-event point delta exceeds `max(SCORING_POINTS)`~~ (see correction)
- no projected team total exceeds `events × max points × relay multiplier`
- no converted SCY time is faster than the world record for that event
- no ratio-to-standard is below ~0.85 (would imply a swim well past NCAA A cuts)

These are crude bounds, deliberately. They cannot verify correctness, but they
catch an entire class of unit and scaling errors for very little code.

**Effort:** ~half a day.

---

## 6. Testing environment notes worth recording

Two things cost time today and will cost it again:

- **Path casing on Windows.** Cloning into a directory whose path differs only in
  case from another resolved React twice, producing
  `Invalid hook call … more than one copy of React`. Two tests failed for purely
  environmental reasons. If CI ever runs from a generated temp path, expect this.
- **Headless tabs freeze `requestAnimationFrame`.** Any assertion that waits on a
  motion transition will hang in a hidden tab. Relevant to
  [04#5](04-architecture-complexity.md#5-two-animatepresence-modewait-wrappers-gate-content-on-animation).

Both belong in a short `docs/testing-gotchas.md` rather than being rediscovered.
