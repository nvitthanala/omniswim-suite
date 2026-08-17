# Current state — one page

Last updated 2026-08-16. **Start here.** 132 KB across 19 files sits behind this
page; everything below links into it.

Baseline: lint clean (7 packages), `npm test` **61 passed / 0 failed / 3 skipped**,
`npm run build` exit 0.

---

## Do this next

| # | Item | Why now |
| - | ---- | ------- |
| 1 | **Commit the meet results PDF** — [13](2026-08-14/13-official-score-mismatch.md) | `loadedMeet.pdfFilename` names `2026_NSISC_Championships_Final_Results.pdf`; the file is not in the repo. It blocks **all three** inactive scoring checks and every open question in 13. Five minutes of answer, currently unreachable. |
| 2 | **Time-trial tagging in `backend/pdf_parser.py`** — [13](2026-08-14/13-official-score-mismatch.md) | Two untagged time-trial rows invent 20 points each. Three modules re-derive "is this a time trial" from the event label and all three were defeated by one bad label. Fix the label, not the readers. |
| 3 | **Rank collapse on roster-only workspaces** — [12 §2](2026-08-14/12-optimizer-destroys-score.md) | `prepareRecruitsForScoring` returns every recruit at rank 1 when there are no comparators, so an event scores as a 281-way tie. No longer destructive, but it is not what a coach is looking at. |
| 4 | Branded `CanonicalEvent` — [04 §3](2026-08-14/04-architecture-complexity.md) | The structural bet. Four defects were the same bug: a value keyed on one identity, looked up by another. |
| 5 | Conversion-factor provenance — [02 §1](2026-08-14/02-data-quality-aliasing.md) | **Blocked on an open question**: does any governing body publish these factors? If not, the whole table is indicative, not official. |

**Done since this page was written:** the optimiser guard (1277 → 0 became
1277 → 1395), the NSISC settings lock, the fast path (**5.7×**, cause was a
per-row/per-name counting bug that silently disabled it), the **`every()`
tie-group gate** (roster workspace best result 1395 → **1407.27**, and the
`scorers` stage alone 213 → **1270**), and the Delta State diagnosis below.

### The Delta State mismatch is diagnosed — and the engine is exonerated

`calculatePoints` reproduces `backend/point_calculator.py`'s stored points
**exactly**, row by row, every event, both genders. Two independent
implementations agree with each other and disagree with the meet, so the defect
is upstream of both, in extraction. Three extraction defects found:

- **Women +20 is fully explained.** One untagged time-trial row (`Event 938`,
  `prelimsTime: "NT"`, last row of the array) wins a phantom one-swimmer event.
  936 − 20 = **916 = official, exactly**.
- **Men −1 is a net.** The mirror row (`Event 939 Boys …`) adds 20; a genuinely
  dropped row in Event 13 (B-final winner, rank 9) removes 9; the residual −21
  is not closed. Two seductive candidates were **eliminated** — Event 39 rank 8
  is a DQ-vacated place, Event 22 ranks 11–16 are a sparse B final. Recorded so
  nobody re-spends that hour.
- **`officialTeamScores` was destroyed for every half-point total** — ✅ fixed.
  pdfplumber splits `1,029.50` into `1,029. 50`, and the lazy regex took the
  school name to be `… 1,029.` scoring `50`. It corrupted exactly the two teams
  whose scores end in .50, and stored the wreckage under a *different key* than
  the clean rows, so nothing could tell corrupt from missing.

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

**P0** — none open. [12](2026-08-14/12-optimizer-destroys-score.md) is closed:
guarded last round, root cause fixed this round (**213 → 1270**, and the stage
that produced the 0.00 wipeout is now the best answer at **1407.27**).

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

**Reported, not fixed** — two untagged time-trial rows score 20 points each
([13](2026-08-14/13-official-score-mismatch.md)) · a duplicated row in Event 39 ·
the `Boys`/`Girls` carve-out in `utils.ts` makes HyTek gender-token events score,
unadjudicable without the PDF · dead `npById` per fast-swap context ·
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
