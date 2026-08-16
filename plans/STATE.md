# Current state — one page

Last updated 2026-08-16 after `fae4da46`. **Start here.** 132 KB across 19 files
sits behind this page; everything below links into it.

Baseline: lint clean (7 packages), `npm test` **56 passed / 0 failed / 3 skipped**,
`npm run build` exit 0.

---

## Do this next

| # | Item | Why now |
| - | ---- | ------- |
| 1 | **Guard the optimiser** — [12](2026-08-14/12-optimizer-destroys-score.md) | It takes the primary workspace **1277 → 0**. It already computes `previousTotal` and `projectedTotal` and never compares them. Guard first, diagnose second. |
| 2 | Disable the seven locked NSISC settings controls — [02 §2b](2026-08-14/02-data-quality-aliasing.md) | A coach can edit them, save, and watch nothing happen. Diagnosis is done; this is the leftover UI defect. |
| 3 | Fast-path perf — [09 §1](2026-08-14/09-performance.md) | Unblocked by the arbitrage split. Live lead: a `Map` built per fast-swap context and never read. |
| 4 | Branded `CanonicalEvent` — [04 §3](2026-08-14/04-architecture-complexity.md) | The structural bet. Four defects were the same bug: a value keyed on one identity, looked up by another. |
| 5 | Conversion-factor provenance — [02 §1](2026-08-14/02-data-quality-aliasing.md) | **Blocked on an open question**: does any governing body publish these factors? If not, the whole table is indicative, not official. |

---

## Shipped

| Commit | What |
| ------ | ---- |
| `fae4da46` | Round 3 docs |
| `f7054e00` | Resolver reaches the UI; inert cap diagnosed; destructive optimiser found |
| `ef98abe0` | Alias-aware rosters + entry limits; parse plausibility; arbitrage split |
| `07703e20` | Docs reorganised; `INVARIANTS.md`; `CHANGELOG.md`; two questions closed |
| `2559e429` | Network exposure; unmapped-division cuts; tests that could not fail |
| `15a0d293` | Arbitrage scan moved off the render path (8.3 s freeze) |
| `f3355927` | Arbitrage cards state real points, or state nothing |
| `350a42a7` | Events ranked by quality, not by raw elapsed time |
| `ea8ad61e` | The loaded meet decides which events an athlete can enter |
| `7af56513` | Production launcher served 404 and seeded an empty DB |
| `ad616e69` | IM conversion factor; Manager dead-ends; layout clipping |

## Open findings, by severity

**P0** — [12](2026-08-14/12-optimizer-destroys-score.md) optimiser destroys a
roster-driven projection.

**P1** — [02 §2b](2026-08-14/02-data-quality-aliasing.md) seven settings controls
editable but ignored · [02 §1](2026-08-14/02-data-quality-aliasing.md) conversion
table has no provenance · [09 §1](2026-08-14/09-performance.md) fast path no
faster than a full re-score · [09 §2](2026-08-14/09-performance.md) Lineup step
blocks ~700 ms · [04 §3](2026-08-14/04-architecture-complexity.md) event identity
is stringly-typed · [06 §1](2026-08-14/06-testing-verification.md) two scoring
tests permanently skipped · [03 §1](2026-08-14/03-scoring-model-depth.md) relays
ranked by nothing.

**P2** — [05](2026-08-14/05-ux-workflow.md) explain the ranking, tap targets ·
[07](2026-08-14/07-packaging-offline-ops.md) pip-installs at first boot, no
version stamp, unattended backups · [04 §2](2026-08-14/04-architecture-complexity.md)
`utils.ts` junk drawer.

**Reported, not fixed** — dead `npById` per fast-swap context ·
`CapVoidSummary.byAthlete` dead · `individualStrokeDistance` lacks label hygiene
(latent, 0 live rows) · two competing alias mechanisms, neither canonical ·
points awarded per row not per distinct name.

---

## Open questions only you can answer

1. **Does any governing body publish course-conversion factors?** Blocks item 5.
   If not, the honest label for the whole table is "indicative".
2. **Who is the second user?** Governs how much the UI must explain.
3. **`Afonso` or `Alfonso` Campanico?** One source is misspelled.
4. **Is the desktop-copy launcher flow still real?** Mentioned only in a `.bat` echo.
5. **Should `data/meets.json` be a curated demo set** rather than a snapshot of live
   working state? They are the same file today.
6. **Is anything backing up `data/omniswim.db`?**

Answered from data, no longer open: HSU fields **zero** divers (rivals field 13,
worth 360 points); time trials **already** earn cut tags correctly (4 of 18).

---

## How this work runs

1. **Disjoint scopes.** No two agents edit the same file. The integrator owns
   `scripts/run-tests.mjs` and all cross-scope wiring.
2. **Evidence over assertion.** Anything that moves a number carries a before/after
   from the live workspaces.
3. **A guard is not trusted until it has been seen to fail.** Every new test gets a
   deliberate mutation, then the mutation is reverted.
4. **Report, don't fix, outside scope.** Latent bugs become findings, not diffs.
5. **Corrections are recorded in place.** Six review claims have been wrong so far;
   each is struck through with the measurement that disproved it, because the
   correction is usually more informative than the original.
6. **Assess partial work, never trust it.** Three agents died mid-edit on 2026-08-16;
   one left the tree uncompilable. Only compiling them told the good from the bad.

## Layout

- `plans/2026-08-14/` — the **review**: what is wrong and why. `00` is the summary,
  `11` is the ordering.
- `plans/2026-08-16/` — the **execution**: what was done, including where the review
  turned out to be wrong.
- `docs/INVARIANTS.md` — things true of this codebase that are written nowhere else.
- `CHANGELOG.md` — user-visible behaviour changes.
