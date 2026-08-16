# 09 — Performance

`docs/reference/PERFORMANCE_NOTES.md` (2026-08-03) documents a real optimisation pass —
`convertTimeToSeconds` memoisation, referential stability in `TeamRosterPanel`,
transitions in the import panel. That work stands and is not repeated here.

This section covers what has changed since, measured **in the running app** with a
`PerformanceObserver` on `longtask`, which reports actual main-thread blocking
rather than wall-clock waiting.

---

## 1. The arbitrage scan blocked the main thread for 8.3 seconds

> **✅ FIXED 2026-08-15** — `15a0d293`. Recorded in full because the shape of the
> mistake matters more than the fix.

**Measured before the fix**, opening each Manager step:

| Step | Wall | Main thread blocked | Longest single task |
| ---- | ---- | ------------------- | ------------------- |
| Source | 2,776 ms | 0 ms | 0 ms |
| Lineup | 3,157 ms | 716 ms | 230 ms |
| Relays | 2,789 ms | 0 ms | 0 ms |
| **Optimize** | 11,057 ms | **33,208 ms** | **8,302 ms** |

An 8.3-second single task is a frozen tab: no scrolling, no clicks, no typing.

### How it happened

`f3355927` fixed the fabricated arbitrage number by delegating to
`rankExactSwaps`, which is correct but expensive, and left it in a `useMemo` — so
it ran during render, synchronously, every time the step opened.

**A wrong number was replaced with a locked UI.** Neither is shippable. This is
worth naming as a pattern: the correctness fix and the performance consequence
arrived in the same change, and only the first was verified before shipping.

### Where the time goes

| Team | Candidates | Time | Per candidate |
| ---- | ---------- | ---- | ------------- |
| Henderson State (fast path) | 849 | 6,035 ms | 7.11 ms |
| Henderson State (`forceFullRescore`) | 849 | 6,253 ms | 7.37 ms |
| Ouachita Baptist | 0 | 26 ms | — |
| Delta State | 0 | 21 ms | — |

> **✅ FIXED 2026-08-16 — the fast path now works, 5.7× faster.**
>
> | Team | Candidates | Full re-score | Fast path | Speedup |
> | ---- | ---------- | ------------- | --------- | ------- |
> | Henderson State, men | 849 | 5,117 ms | **895 ms** | **5.7×** |
>
> Equivalence verified: `rankExactSwaps` output is sha256-identical between the
> fast path and `forceFullRescore: true` for every team and gender in both
> workspaces.
>
> **The cause was a counting bug that silently disabled the optimisation.**
> `TeamScoreGroup.ptsEach` awarded points **per distinct name**, but
> `scoreIndividualsInEvent` awards them **per row** while consuming pool weight
> per name. The two diverge whenever a team holds more rows than distinct
> swimmers at one placement — an athlete carried as both a recruit row and an
> active optimizer plan for the same event. That under-counted those groups, so
> the context's own **self-validation check failed**, and the fast path fell back
> to a full re-score wholesale. It failed *closed*: correct but slow, which is why
> it went unnoticed for a month.
>
> Renamed to `ptsTotal`, summed over rows. The dead `npById` map was confirmed
> unread and removed. `scripts/test_fast_swap_context.mjs` guards that the
> self-validation stays satisfied, including a liveness assertion that the
> duplicate-placement case actually moves a total (77 → 94).
>
> The scan button could now be reconsidered — 895 ms is under the 1,000 ms
> single-task budget — but it is left in place: 895 ms is borderline for a render
> path, and the button makes the cost visible.

Two things fall out of this table:

1. **849 candidates × a full field re-score each.** The cost is real work, not a
   missing memo.
2. **The incremental fast path is not faster.** 6,035 ms with it, 6,253 ms with
   `forceFullRescore: true` — a 3.5% difference, well inside noise. Either
   `buildFastSwapContext` is returning null and silently falling back, or its
   incremental path costs about what it saves. **This is a live finding, not yet
   investigated.**

Only Henderson State is expensive; the other two teams have no droppable entries,
so `collectDroppableEntries` returns nothing and the scan is instant. The cost is
proportional to how much roster work a team has, which means it grows exactly as
the tool gets used.

### The fix, and what it costs

The panel now scans on an explicit **"Find point opportunities"** button, with a
`Scanning…` state painted before the blocking work starts, and the result cleared
whenever workspace/gender/team/settings change so a stale scan can never describe
a roster that no longer exists.

Measured after: **Optimize 0 ms blocked, 0 ms worst task.** The scan still takes
~6 s when invoked, but now that is a visible, chosen cost rather than a freeze.

**What it costs:** the cards no longer appear automatically. For a step whose
whole purpose is "find more points", making the user ask is a real downgrade.
It is the right trade against an 8-second freeze, and it is not the end state.

### Follow-up — remove the button

Two candidate routes, in preference order:

- **A: make the fast path engage.** If `buildFastSwapContext` can deliver the
  incremental scoring it was written for, 849 candidates at sub-millisecond each
  is ~100 ms and the scan can go back to being automatic. Start by finding
  whether it returns null on this workspace and why. **This is the right fix.**
- **B: move it to the existing worker.** `useWorkspaceScoring` already runs
  scoring in a Web Worker. Arbitrage could join it, keeping the UI responsive
  regardless of cost. More plumbing, but it removes the whole class of problem.

A third option — capping the candidate set — should be resisted unless it is
surfaced. Silently scanning only the top N athletes would make the panel's
"opportunities" incomplete without saying so, which is the failure mode
[01](01-fabricated-values.md) exists to prevent.

---

## 2. The Lineup step blocks ~700 ms

**Measured:** 716 ms total blocking, 230 ms worst task, on the meet workspace;
330 ms / 98 ms on the roster-only workspace.

Below the 8-second catastrophe but above the ~100 ms threshold where interaction
starts to feel sticky. `TeamRosterPanel` (873 lines) and the compliance checklist
both run over the full roster on this step.

`docs/reference/PERFORMANCE_NOTES.md` §2 already stabilised `merged` here and notes the row body
is windowed past a threshold. The remaining 230 ms is likely
`buildTeamLineupAudit` plus the per-row `getAthleteProfile` calls — and
`getAthleteProfile` got **more** expensive on 2026-08-14, since it now derives the
meet program and computes a quality ratio per event.

**Not yet profiled.** Worth a React Profiler session before guessing. **Effort:**
~half a day to measure and fix properly.

---

## 3. Bundle sizes are healthy

From `npm run build`:

| Chunk | Raw | Gzip |
| ----- | --- | ---- |
| `vendor-charts` | 368.50 kB | 108.05 kB |
| `shared-suite` (js) | 421.90 kB | 111.51 kB |
| `vendor-react` | 233.25 kB | 74.69 kB |
| `applet-manager` | 212.98 kB | 51.23 kB |
| `vendor-motion` | 128.70 kB | 42.29 kB |
| `applet-matrix` | 95.19 kB | 23.03 kB |
| `applet-metrics` | 64.48 kB | 17.83 kB |
| `scoringWorker` | 186.14 kB | — |
| `shared-suite` (css) | 82.93 kB | 15.33 kB |

Applets are already split and lazily loaded (`appletPrefetch.ts`), with an idle
prefetch of the last-used one. **No action.** `vendor-charts` at 108 kB gzipped
is the largest single item and is inherent to Recharts.

---

## 4. What is worth measuring next

Nothing here should be optimised before it is measured — the 8-second block went
unnoticed precisely because nobody had a number.

1. **A `longtask` budget in CI.** The harness used above is ~30 lines of
   Playwright. Asserting "no step blocks the main thread for more than 500 ms"
   would have caught §1 on the commit that introduced it. Cheap, and it is the
   only guard in this document that prevents rather than describes.
2. **Profile the Lineup step** (§2).
3. **Time a full PDF parse** end to end. The Python sidecar path has never been
   measured and is the one operation a coach waits on at a meet.
4. **Measure with a larger workspace.** Everything here is two workspaces of
   ~500 and ~280 rows. A season of meets in one workspace is the growth case, and
   `athleteHistory` is already 871 swims.
