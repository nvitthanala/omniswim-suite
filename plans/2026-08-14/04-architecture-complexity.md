# 04 — Architecture and complexity

Structure that makes the correctness work in [01](01-fabricated-values.md) and
[02](02-data-quality-aliasing.md) more expensive than it needs to be.

## Current shape

Largest files in the tree (excluding `node_modules`):

| Lines | File |
| ----- | ---- |
| 2,255 | `packages/core/src/lib/crossCourseArbitrage.ts` |
| 1,749 | `packages/core/src/lib/utils.ts` |
| 1,477 | `packages/core/src/lib/athleteAliases.ts` |
| 1,096 | `packages/core/src/lib/cutlineTags.ts` |
| 1,056 | `packages/matrix/src/components/TeamCard.tsx` |
| 923 | `apps/shell/server.ts` |
| 873 | `packages/manager/src/components/TeamRosterPanel.tsx` |
| 871 | `packages/manager/src/components/CrossCourseArbitragePanel.tsx` |
| 799 | `packages/core/src/lib/athleteHistory.ts` |
| 749 | `packages/core/src/data/teamDivisions.ts` |

For context, the prior round already split `AthleteLineupEditorPanel` 1,314 → 577
and `CrossCourseArbitragePanel` 1,064 → 871. That work was real and should
continue, but the top of this list is now **core logic, not UI**.

---

## 1. The 2,255-line module

**Severity: P1.** `crossCourseArbitrage.ts`

It currently owns at least four distinct jobs, exported separately:

| Concern | Exports |
| ------- | ------- |
| Cross-course comparison table | `buildCrossCourseTable`, `buildCoverageGaps` |
| Exact-swap ranking | `rankExactSwaps`, `applyExactSwap` |
| Drop/add analysis | `rankDropOnly`, `rankAddOnly`, `applyEntryDrop`, `applyEntryAdd` |
| Relay leg swaps | `rankRelayLegSwaps`, `applyRelayLegSwap`, `buildRelayLegTimeIndex` |

Only the first is "cross-course" in any meaningful sense. Today I had to edit
**two separate call sites inside this one file** for the same conversion-guard
fix, and they had drifted: one filtered on `canonicalProgramEvent`, the other on
`individualStrokeDistance`, for the same underlying question.

### Proposed split

```
lib/arbitrage/
  crossCourseTable.ts     # the actual cross-course comparison
  exactSwaps.ts
  dropAdd.ts
  relayLegSwaps.ts
  shared.ts               # history→program projection, used by all four
```

The `shared.ts` piece is the real win: **all four jobs begin by projecting an
athlete's history onto the meet's program**, and today each does it slightly
differently. That shared step is exactly where two of today's four bugs lived.

- **Effort:** ~1 day, mechanical, behind existing tests
  (`test_cross_course_arbitrage`, `test_relay_swaps`, `test_drop_add_analysis`).
- **Risk:** low — pure move, no behaviour change, tests already cover each job.
- **Do it before** the arbitrage re-score work in
  [01](01-fabricated-values.md#1-arbitrage-points-are-not-points), not after.

---

## 2. `utils.ts` is a junk drawer

**Severity: P2.** 1,749 lines holding at least: time parsing/formatting, course
conversion, the scoring engine (`calculatePoints`), name normalisation, event
sorting, team-name heuristics, round-tier classification, relay detection.

`calculatePoints` — the single most important function in the product — lives in
a file called `utils`. It is genuinely hard to find; I looked in
`scoringEngine.ts` first today and it was not there.

### Proposed

Extract by concern, keeping `utils.ts` re-exporting for compatibility so nothing
breaks in one step:

- `lib/time.ts` — parse/format/convert seconds
- `lib/courseConversion.ts` — `convertToSCY`, `convertSwimToSCY`,
  `hasConversionFactor` (and read the new manifest from
  [02](02-data-quality-aliasing.md#1-the-conversion-table-has-no-provenance))
- `lib/scoringEngine.ts` — `calculatePoints` and friends, joining the file that
  already has the name
- `lib/names.ts` — normalisation and institution heuristics

**Effort:** ~1 day. **Risk:** low with re-exports. **Value:** mostly
discoverability, which is why it is P2 — but it compounds with everything else.

---

## 3. Event identity is the recurring fault line

**Severity: P1 — this is the structural finding.**

Four bugs fixed today were all the same shape: *a value keyed on one identity,
looked up by another.*

| Bug | Keyed as | Looked up as |
| --- | -------- | ------------ |
| IM conversion | `'200 IM'` | `'200 Individual Medley'` |
| Profile events | raw history label | meet's HyTek label |
| Arbitrage field lookup | canonical `'500 Freestyle'` | `'Event 22 Men 500 Yard Freestyle'` |
| Duplicate profile entries | both spellings coexisting | — |

Every one produced a *plausible* wrong answer rather than an error: a slightly
wrong time, an empty field list, a phantom extra event. There are currently
**three** functions doing overlapping canonicalisation:

- `normalizeEventLabel` (athleteHistory) — expands `Fly`→`Butterfly`, `IM`→`Individual Medley`
- `canonicalProgramEvent` (eventIdentity) — strips HyTek, then whitelist-filters
- `canonicalMeetEventLabel` (athleteHistory, added today) — strips HyTek, no whitelist
- plus `normalizeEventForCutline` (cutlineEventNames) — a fourth, for cut lookup

### Proposed: make event identity a type, not a string

```ts
type CanonicalEvent = string & { readonly __canonical: unique symbol };
function canonicalise(raw: string): CanonicalEvent | null;
```

A branded type means `CONVERSION_FACTORS[raw]` stops compiling — every lookup
must pass through `canonicalise` first. That is a compile-time guarantee against
the entire bug class, not a test that has to imagine the failure.

- **Effort:** ~1–2 days; the branding is cheap, threading it through call sites
  is the work.
- **Risk:** medium — touches a lot of surface. Do it after the
  `crossCourseArbitrage` split, and behind the full suite.
- **Payoff:** high. This is the single change that would have prevented four of
  today's defects.

**Interim (cheap, do now):** one test asserting every `CONVERSION_FACTORS` key
round-trips through `normalizeEventLabel` unchanged. ~15 minutes, catches the
exact IM failure. Listed in [06](06-testing-verification.md#4-encode-the-prose-rules-as-tests).

---

## 4. `server.ts` at 923 lines mixes four responsibilities

**Severity: P2.** Route definitions, Python sidecar management, venv
bootstrapping (`pip install` at runtime), Vite dev middleware, and static
serving.

The `PROJECT_ROOT` bug fixed today (`7af56513`) was a direct consequence: a path
constant at the top of a 900-line file, correct for one of two entry paths, with
no test exercising the production one.

**Proposed:** extract `lib/pythonSidecar.ts` (venv bootstrap + spawn) and
`routes/` per concern. **Effort:** ~half a day. The higher-value half is the
sidecar extraction, because that is the part with real environmental failure
modes — see [07](07-packaging-offline-ops.md).

---

## 5. Two `AnimatePresence mode="wait"` wrappers gate content on animation

**Severity: P2, latent.** `MatrixApp.tsx:24`, `ManagerApp.tsx:291`,
`App.tsx:153`.

`mode="wait"` holds the outgoing subtree until its exit animation completes
before mounting the incoming one. Content correctness therefore depends on an
animation finishing.

I hit this today: in a browser tab where `document.hidden === true`,
`requestAnimationFrame` never fires, the exit never completes, and **the Matrix
screen showed the previous workspace's data indefinitely.** In a normal visible
tab it resolves in 200 ms and is invisible.

That specific trigger is a headless-testing artefact, not something a demo will
hit. But the coupling is real, and `prefers-reduced-motion` is already honoured
elsewhere (`App.tsx:156` checks `preferences.reducedMotion`) while these two do
not.

**Proposed:** key the content on workspace id directly and let the animation be
decorative — or at minimum honour `reducedMotion` in both applets as the shell
already does. **Effort:** ~1 hour. **Risk:** low.
