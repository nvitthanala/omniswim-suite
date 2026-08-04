# Video Analysis Suite — Masterplan

**Status:** plan authored 2026-08-02, revised after a verification pass the same day. No implementation started.
**Branch:** `feat/roster-management-overhaul` (working tree dirty — see §11).
**Scope decisions already made:** gamepad/X-Box input is **out** (user, 2026-08-02).

---

## 0. What the verification pass changed

Everything in §10 was checked against the actual repo rather than assumed. Four assertions in
the first draft were **wrong** and would each have cost a round trip:

| # | First draft said | Verified reality | Blast radius |
| - | ---------------- | ---------------- | ------------ |
| 1 | Engine tests live in `packages/core/src/lib/raceAnalysis/__tests__/` | `vitest.config.ts` has `include: ['tests/**/*.test.ts']` — **only** the repo-root `tests/` directory. A test under `packages/` is never collected. | A1 would have shipped tests that silently never ran. |
| 2 | B2 adds a `race_analyses` table with typed columns and bespoke CRUD methods | The db uses a generic **child-table** pattern: `(workspace_id, position, data TEXT)` + a `CHILD_TABLES` list + `assembleWorkspace`. Race analyses are a field on `Workspace`. | B2 would have built a parallel, non-idiomatic persistence path. |
| 3 | B2 adds a REST surface in `packages/core/src/api/` | Not needed. `PUT /api/workspaces/:id` already round-trips the whole workspace, so a new `Workspace` field persists with zero new routes. | Dead code, plus an unnecessary `apps/shell/server.ts` edit outside every declared scope. |
| 4 | Worktrees are cut from HEAD, so agents can't see uncommitted work; phases need commits | `cartographer.ts` **seeds each worktree with `git diff HEAD --binary` and commits it**, so agents see the real dirty tree. Phase gates need `fleet_apply_patch` only — **no commit required**. | Would have forced 3 unnecessary commits onto a dirty feature branch. |

Also newly specified, because leaving them implicit is how a one-pass build fails: the
per-length stroke model for IM (§2.8), what a "cycle" means per stroke and that it is
operator-set rather than assumed (§2.4), a structured problem taxonomy (§4), floating-point
assertion rules (§6.0), and **two fully worked numeric fixtures with every expected value
hand-computed** (§6) so no agent has to invent a test expectation.

---

## 1. Source of truth

All logic traces to Swimcloud's published race-analysis documentation, retrieved
**2026-08-02**. These are the *only* external references this suite may cite.

| # | Article | URL |
| - | ------- | --- |
| S1 | How to Analyze Your Race | `https://support.swimcloud.com/hc/en-us/articles/360008864433-How-to-Analyze-Your-Race` |
| S2 | Analyzing the Data | `https://support.swimcloud.com/hc/en-us/articles/360008576693-Analyzing-the-Data` |
| S3 | Race Analysis Keyboard Shortcuts | `https://support.swimcloud.com/hc/en-us/articles/17944467746195-Race-Analysis-Keyboard-Shortcuts` |
| S4 | Using an X-Box Controller to Analyze Races | `https://support.swimcloud.com/hc/en-us/articles/33846066645395-Using-an-X-Box-Controller-to-Analyze-Races` |
| S5 | Visualizing the Data | `https://support.swimcloud.com/hc/en-us/articles/360008428994-Visualizing-the-Data` — **no textual content**; embedded media only. Cite nothing from it. |

> **On S1.** The article the request pointed at is a four-step UI walkthrough
> ("Select the video → Tag In Video → Analyze Race → play and start analyzing"). It contains
> **no metric definitions**. The analytical substance is in S2 (definitions + reference bands)
> and S3 (the tag state machine, published as two keyboard images — both were downloaded and
> read). This plan is built on S2 + S3.

### 1.1 Verbatim reference values from S2

The **only** numeric benchmarks published in the source. They are coaching reference bands,
not thresholds.

| Metric | Published value (S2, verbatim) |
| ------ | ------------------------------ |
| Start | "Start - .75 to 1.00 avg." |
| 15 metre time | "world-class swimmers get there in under 6 seconds. Senior kids should shoot for 6-7 seconds or better." |
| Underwater limit | "you can only legally go 15 meters underwater." |
| Turn time | "Generally speaking you are trying to keep the turn at 1.0 to 1.2 or less." |
| Finish segment | "5 yard/meter finish – measured when the head paces under the flags until the finish." *(sic — "paces" in source; read as "passes")* |
| Breakout distance / DPS | "Please keep in mind this value is an approximation." — stated **twice**, once for breakout distance and once for distance per stroke/cycle. |

### 1.2 Qualitative rules from S2 that shape the UI

1. Breakout time and breakout distance "tell a bigger story" **together** — never surface one alone.
2. Stroke rate: watch consistency, and specifically whether it **drops off** — "which could show a sign of lack of conditioning."
3. Stroke tempo should **increase into walls**; a slowdown into a turn or finish is the finding.
4. Cycle count: "fewer strokes while maintaining speed, means less energy and more efficiency" — only meaningful next to velocity.
5. Splits: "The first segment will always be faster because you are starting from a dive instead of a pushoff" — length 1 is not comparable to the rest and must never be pooled into an evenness statistic without saying so.

### 1.3 The landmark tagging sequence (S3)

Three keys. `S` and `D` are **sequential** — each press advances a per-length state machine.
`A` is a one-shot marker.

```
S  →  Start → Entry → Breakout → Stroke (repeating)
D  →  Turn Start → Turn End → (last length) Finish
A  →  15m Mark
```

| Length | Sequence, exactly as published |
| ------ | ------------------------------ |
| **First length** | `S` Start · `S` Entry · `S` Breakout · `S` Strokes (×n) · `D` Turn Start · `D` Turn End |
| **Middle lengths** | `S` Breakout · `S` Strokes (×n) · `D` Turn Start · `D` Turn End |
| **Last length** | `S` Breakout · `S` Strokes (×n) · `D` Finish |

**Gamepad input is out of scope** (user, 2026-08-02). S4's mapping (`RT`=`S`, `LT`=`D`) is
retained here only as corroboration that `S` and `D` are the two sequential keys. S4
self-labels "experimental functionality"; nothing in this plan builds against it.

**Consequences the state machine must encode:**

- Exactly **one** `Start` and **one** `Entry`, both on length 1.
- Every length has exactly one `Breakout`.
- Every length except the last ends with a `Turn Start` / `Turn End` pair.
- The last length ends with `Finish` and has **no** turn.
- Length count = `raceDistance / poolLength`, known before tagging begins.
- `15m` is optional and unordered relative to the `S` chain.

### 1.4 OmniSwim additions (clearly not Swimcloud)

Three tags the source does not define. Each must be labelled in the UI as an OmniSwim
addition so no one mistakes it for the published method.

| Tag | Key | Why |
| --- | --- | --- |
| `Signal` | `R` | The starting horn/strobe. Without it **reaction time is not computable** — only flight time is. S2 quotes a "Start" band but publishes no tag for the signal. |
| `Flags` | `G` | S2 defines a "5 yard/meter finish … measured when the head passes under the flags", but S3's key map has no flags key. |
| `Kick` | `K` | Underwater dolphin kicks. Enables kick tempo; entirely optional. |

---

## 2. Metric definitions

`t(x)` = video timestamp of tag `x`, seconds. `L` = pool length. `n` = 1-based length index.
✅ derivable from tags alone · ⚠️ needs an operator-supplied distance, approximate per S2 ·
❌ not derivable, emit absent.

### 2.1 Start block

| Metric | Formula | Unit | Status |
| ------ | ------- | ---- | ------ |
| Reaction time | `t(Start) − t(Signal)` | s | ✅ **only** with a `Signal` tag; else absent |
| Flight time | `t(Entry) − t(Start)` | s | ✅ |
| Time to breakout, length 1 | `t(Breakout₁) − t(Start)` | s | ✅ |

**The `.75 to 1.00` band is labelled "Start" and S2 does not define its endpoints.** It is
ambiguous between reaction time and start-to-entry flight. Render it as a cited reference band
attached to the **start phase as a whole**, with the quote in the tooltip. Do **not** bind it
to one computed metric and colour-code pass/fail against it.

**Relay takeoffs are out of scope.** A rolling start makes reaction and flight
non-comparable to a flat start. If the operator marks the race as a relay leg, reaction and
flight render absent with reason `"relay takeoff — not comparable to a flat start"`.

### 2.2 Underwater / breakout

| Metric | Formula | Unit | Status |
| ------ | ------- | ---- | ------ |
| Breakout time, length 1 | `t(Breakout₁) − t(Start)` | s | ✅ |
| Breakout time, length n>1 | `t(Breakoutₙ) − t(Turn Endₙ₋₁)` | s | ✅ |
| Breakout distance | operator-entered per length, read off a pool reference | m or yd | ⚠️ approximate (S2) |
| Underwater velocity | `breakoutDistanceₙ / breakoutTimeₙ` | m/s or yd/s | ⚠️ absent when distance absent |
| Kick count | count of `Kick` tags within the length's underwater phase | count | ✅ if tagged, absent otherwise |
| Kick tempo | `60 × (kickCount − 1) / (t(lastKick) − t(firstKick))` | kicks/min | ✅ if ≥2 kick tags in that length |

Legality guard: `breakoutDistance > 15 m` raises a **warning** (S2: "you can only legally go
15 meters underwater"). Warn — never clamp, never drop, never reject the analysis.

**Breaststroke note.** The pullout means the underwater phase is a pull-and-kick, not a
dolphin sequence. Kick tagging stays stroke-agnostic: count what the operator tagged. Zero
kick tags means **absent**, not `0`. The prototype's `'Breaststroke' ? 0 : 160` is exactly
the conflation this rule exists to prevent.

### 2.3 15 metre mark

| Metric | Formula | Unit | Status |
| ------ | ------- | ---- | ------ |
| 15 m time (length 1) | `t(15m₁) − t(Start)` | s | ✅ |
| 0–15 m velocity (length 1) | `15 / (t(15m₁) − t(Start))` | m/s | ✅ |
| 15 m time (length n>1) | `t(15mₙ) − t(Turn Endₙ₋₁)` | s | ✅ |

A 15 m tag is permitted **once per length** — the underwater limit applies off every wall,
not only the start. But the S2 reference band ("under 6 seconds" / "6-7 seconds") is a
**start** benchmark: attach it to length 1 only, and to no other length.

**Course guard.** 15 m is a metric distance. In an **SCY** pool a 15 m line is not guaranteed
to exist. All 15 m metrics are absent unless the caller passes
`fifteenMetreReferenceConfirmed: true`, which the UI surfaces as an explicit operator
checkbox. Never derive a 15 m reading from a yard landmark.

### 2.4 Stroke rate, cycle count, distance per cycle

**A "cycle" is operator-defined, recorded with the analysis, and never assumed.** The
conventional readings differ by stroke and two analysts who disagree produce numbers that
differ by exactly 2×. The engine takes `cycleDefinition` as required config and stores it:

| Stroke | Conventional cycle | Default offered |
| ------ | ------------------ | --------------- |
| Freestyle, Backstroke | alternating arms — one cycle = two arm strokes (tag same-hand entry) | `'same-hand'` |
| Butterfly, Breaststroke | simultaneous arms — one cycle = one pull | `'single-pull'` |

The chosen definition is displayed next to every stroke-rate and distance-per-cycle figure,
and is stored with the saved analysis. **A comparison between two analyses with different
`cycleDefinition` values is refused, not silently rendered** (see C2).

| Metric | Formula | Unit | Status |
| ------ | ------- | ---- | ------ |
| Cycle time, between cycle *i* and *i+1* | `t(Strokeᵢ₊₁) − t(Strokeᵢ)` | s | ✅ |
| Stroke rate, instantaneous | `60 / cycleTime` | cycles/min | ✅ |
| Stroke rate, length n mean | `60 × (cycleCountₙ − 1) / (t(lastStrokeₙ) − t(firstStrokeₙ))` | cycles/min | ✅ if ≥2 stroke tags on that length |
| Cycle count, length n | number of `Stroke` tags on length n | count | ✅ |
| Distance per cycle, length n | `(L − breakoutDistanceₙ − finishApproachₙ) / cycleCountₙ` | m or yd | ⚠️ absent without breakout distance |

**Two off-by-one traps, both live in the prototype:**

1. `n` stroke tags give `n − 1` intervals. A mean over `n` is wrong.
2. **Never average stroke gaps across a wall.** The gap between the last stroke of one length and the first of the next is not a cycle. Segment by length first, then average within the length.

`finishApproachₙ` = 0 for every length except the last, where it is the flag distance if a
`Flags` tag exists (§2.6), else 0 — and when it is 0 on the last length, that length's
distance-per-cycle is marked lower-confidence rather than silently equal to the others.

### 2.5 Turns

| Metric | Formula | Unit | Status |
| ------ | ------- | ---- | ------ |
| Turn time, turn n | `t(Turn Endₙ) − t(Turn Startₙ)` | s | ✅ |

**Do not invent a distance convention.** The published method defines a turn purely by the two
operator tags. It specifies **no** 5 m-in/10 m-out, 7.5 m, or 15 m window. The UI states the
operative definition on screen — *"turn time is measured between your Turn Start and Turn End
tags"* — so two analysts are only comparable when they tag alike. Recording each operator's
tagging convention as a note is in scope; a hardcoded distance window is not.

Reference band, verbatim: "1.0 to 1.2 or less" (S2).

### 2.6 Splits, finish, velocities

| Metric | Formula | Unit | Status |
| ------ | ------- | ---- | ------ |
| Length split, n | `Turn Start` boundary (see below); final split ends at `Finish` | s | ✅ |
| Cumulative time | running sum of splits | s | ✅ |
| Length mean velocity | `L / splitₙ` | m/s or yd/s | ✅ |
| Race time | `t(Finish) − t(Start)` | s | ✅ |
| Race mean velocity | `raceDistance / raceTime` | m/s or yd/s | ✅ |
| Finish segment time | `t(Finish) − t(Flags)` | s | ✅ only with a `Flags` tag |
| Finish segment velocity | `flagDistance / finishSegmentTime` | m/s or yd/s | ✅ only with a `Flags` tag |

**Split boundary.** The published tag set has no wall-touch tag; it has `Turn Start`. Use
`Turn Start` as the boundary, **state it on screen**, and:

- a tagged split is **not** an official split — it is systematically early by however long the swimmer takes from turn initiation to wall contact;
- when the operator also enters official splits, show both and **flag the divergence**;
- never overwrite either with the other. They are separate provenance classes (§3).

**Flag distance is confirmed, not assumed.** S2 states "5 yard/meter finish" descriptively and
cites no rulebook. Default the field to 5 yd in SCY and 5 m in SCM/LCM, but require an
explicit operator confirmation before any finish-segment velocity is computed.

### 2.7 Explicitly absent — emit nothing

Common in commercial products, **not derivable** from this tag set. Each renders as an
explicit "not measured" state with a one-line reason. Never `0`, never an estimate.

1. **Reaction time** without a `Signal` tag.
2. **Breakout distance, dive distance, distance-per-cycle** without an operator-entered reference distance.
3. **Instantaneous velocity between landmarks.** The tags give times at points, not a position track. The velocity "profile" is a **step function over segments** and must be drawn as steps or discrete points — never a smooth curve.
4. **Fatigue index.** S2 describes stroke-rate drop-off qualitatively and publishes no formula. Replace with the observable: per-length stroke rate, per-length velocity, and a first-vs-last delta labelled as a delta.
5. **Stroke count or DPS for the underwater portion** — undefined.
6. **Anything for a length whose tag set is incomplete.** Absent that length only; never shift onto the next.

### 2.8 Individual medley — per-length stroke

An IM changes stroke mid-race, so `cycleDefinition`, breakout distance, and stroke-rate
interpretation all change per length. The engine therefore takes a **per-length stroke
array**, not a single race stroke.

- For a non-IM race the array is `L` copies of the one stroke.
- For an IM the engine offers a proposal from the standard order **fly → back → breast → free**, split evenly across the lengths (`200 IM` SCY = 8 lengths → 2 each; `200 IM` LCM = 4 lengths → 1 each; `400 IM` LCM = 8 lengths → 2 each).
- **The proposal is a proposal.** The operator confirms or edits it before tagging. If the length count does not divide evenly by 4, the engine raises a structured problem and refuses to guess.

---

## 3. Provenance model (non-negotiable)

Mirrors the repo's existing `CLAUDE.md` data-provenance section. A wrong race number does not
throw; it produces a plausible, wrong training conclusion a coach acts on.

Every metric is a discriminated union, never a bare `number`:

```ts
type Provenance = 'tagged' | 'entered' | 'derived' | 'official';
type Unit = 'm' | 'yd' | 's' | 'm/s' | 'yd/s' | 'cycles/min' | 'kicks/min' | 'count';

type Measured<T> =
  | { status: 'value'; value: T; provenance: Provenance; approximate: boolean; unit: Unit }
  | { status: 'absent'; reason: string };
```

1. **Absent ≠ 0.** No `?? 0`, no `|| 0`, no default constant on any race value.
2. **Approximate is sticky.** Anything downstream of an ⚠️ input is approximate, and the badge propagates. S2 says this explicitly about breakout distance and DPS — repeat the caveat, do not bury it.
3. **No interpolation, extrapolation, projection, or estimation.** Same rule as cutlines.
4. **Reference bands live in one file** with URL, retrieval date, and verbatim quote. Never inline `0.75`, `6`, `1.0`, `1.2`, `15`, or `5` as bare literals in logic or JSX.
5. **Units are typed.** SCY is **yards**. 1 yd = 0.9144 m exactly. A yd/s value may never carry an `m/s` label. Conversion is explicit, at one boundary function, never implicit.
6. **The state machine fails loudly.** An out-of-sequence tag is rejected with a structured problem, never silently absorbed.

---

## 4. Structured problem taxonomy

Validation returns `Problem[]`, never a thrown string and never a silent skip. Stable codes so
the UI and tests can assert on them.

| Code | Severity | Meaning |
| ---- | -------- | ------- |
| `MISSING_START` | error | No `Start` tag; nothing time-relative can be computed. |
| `MISSING_FINISH` | error | No `Finish` tag; race time and the last split are absent. |
| `MISSING_BREAKOUT` | warning | A length has no `Breakout`; that length's breakout metrics and DPC are absent. |
| `UNPAIRED_TURN` | warning | A `Turn Start` with no `Turn End` (or vice versa); that turn time and that length's split are absent, **and nothing shifts**. |
| `TURN_ON_LAST_LENGTH` | error | A turn tagged on the final length. |
| `FINISH_BEFORE_LAST_LENGTH` | error | `Finish` tagged before the final length. |
| `STROKE_BEFORE_BREAKOUT` | warning | A `Stroke` precedes that length's `Breakout`. |
| `INSUFFICIENT_STROKE_TAGS` | info | Fewer than 2 stroke tags on a length; that length's stroke rate is absent. |
| `NON_MONOTONIC_TAGS` | error | Tag timestamps out of chronological order. |
| `BREAKOUT_EXCEEDS_15M` | warning | Entered breakout distance > 15 m — beyond the legal underwater limit. |
| `LENGTH_COUNT_MISMATCH` | error | Tagged length count ≠ `raceDistance / poolLength`. |
| `FIFTEEN_METRE_UNAVAILABLE` | info | SCY course without `fifteenMetreReferenceConfirmed`; 15 m metrics absent. |
| `IM_LENGTHS_NOT_DIVISIBLE` | error | IM whose length count is not divisible by 4; engine refuses to propose an order. |
| `SPLIT_DIVERGENCE` | info | Tagged split differs from an entered official split; both shown, neither overwritten. |

An `error` means the whole analysis is incomplete. A `warning` scopes to the affected length.
An `info` is displayed but blocks nothing.

---

## 5. Audit of the existing prototype — what must be deleted

`packages/metrics` contains a working-*looking* prototype. **Every number below is
fabricated.** This audit is the acceptance checklist: a grep for each must come back empty.

`packages/metrics/src/MetricsApp.tsx` — `calculateMetricsLocal()`:

| Fabrication | Why it is one |
| ----------- | ------------- |
| `fatigueIndex: 8.4` | Hardcoded constant displayed as a measured percentage. Nothing computes it. |
| `breakDist = 'Breaststroke' ? 8.5 : 'Backstroke' ? 12 : 10` | Invented default breakout distances by stroke. |
| `vel0to15 = avgVelocity * 1.3` | Invented multiplier. |
| `diveVel = max(vel0to15 * 1.3, avgVelocity * 1.8)` | Two invented multipliers. |
| `diveDistance: breakDist + 2.5` | Invented offset. |
| `vel15mToWall: avgVelocity * 0.92` | Invented multiplier, displayed as a measured segment velocity. |
| `firstLengthVel: avgVelocity * 1.15` | Invented multiplier — and this one is actually measurable from tags. |
| `uwtTempo = 'Breaststroke' ? 0 : 160` | Invented tempo; the `0` conflates absent with zero. |
| `strokeRate = 'Butterfly' ? 45 : 55` | Invented stroke rates. |
| `kicksCountVal … 'Breaststroke' ? 1 : 6` | Invented kick counts. |
| `runEnd = … runStart + 50` | Invents a 50-second race when no finish is tagged. |
| `lapTime = (poolLen / avgVelocity) * (i === 1 ? 0.9 : 1.05)` | Invents an entire split set. |
| `poolLen = course === 'SCY' \|\| 'SCM' ? 25 : 50` | **Unit bug.** SCY 25 is *yards*; the quotient is labelled m/s. |
| `for (let i = 1; i < turnEvents.length; i += 2)` | Assumes perfectly paired turn tags; one missed tag silently reassigns every later split. |

`packages/metrics/src/components/VideoPlayer.tsx`:

| Fabrication | Why |
| ----------- | --- |
| `interpolatedPace = data.avgVelocity + Math.sin(currentTime * 2) * 0.1` | Fake live velocity readout. |
| `interpolatedSR = data.strokeRate + Math.cos(currentTime * 1.5) * 2` | Fake live stroke rate. |
| `calculateLiveSPM()` labelled `s/m` | Correct maths, **wrong unit** — it is cycles/min. |
| `runBodyDetect`, `selectLane`, `detectedLanes`, `scanState` | Dead stubs implying automatic detection that does not exist. |
| `fps` defaults to `30`, user-selectable | Not wired to `extractVideoMeta`'s measured fps; frame stepping drifts on 59.94/120 fps footage. |

`packages/metrics/src/components/MetricsDashboard.tsx`:

| Fabrication | Why |
| ----------- | --- |
| `// Generate a simulated velocity point for the chart for visual intrigue` | The comment says it outright. |
| `<Area type="monotone">` on segment velocities | Smooth interpolation between discrete means implies data between landmarks that does not exist. Must become a step chart. |
| `unit="s/m"` on Stroke Rate | Wrong unit. |
| `unit="%"` on Fatigue Index | Wrong, and the value is the hardcoded 8.4. |

Also: `MetricsApp.tsx` hardcodes `goalTime`/`worldRecordTime` (`50.0 / 23.0 / 120.0`,
`46.86 / 20.91 / 110.0`) with no course, gender, or stroke context. `46.86` and `20.91`
resemble real men's LCM freestyle records but are applied to every stroke and both genders.
**Delete.** And `SessionComparePanel.tsx` is a **0-byte file** that is nonetheless part of the
package.

---

## 6. Test fixtures — exact expected values

Both fixtures are **synthetic**, constructed so every quotient is exact. Splits use the
documented `Turn Start` boundary (§2.6) and are therefore *not* official splits. Agents must
use these numbers verbatim and invent no others.

### 6.0 Floating-point rule

Video timestamps are IEEE-754 doubles. `10.680 − 10.000` is `0.6800000000000006`, not `0.68`.

**Every numeric assertion uses `expect(x).toBeCloseTo(expected, 6)`. Never `toBe` or
`toEqual` on a computed float.** Integers (cycle count, kick count, length index, problem
counts) use `toBe`.

**All 43 expected values in §6.1–6.3 were machine-verified in double precision on 2026-08-02**
before this plan was issued; every one agrees to within 1e-9. Worst observed drift is the
Fixture A finish-segment velocity, which lands at `2.0833333333333286` rather than an exact
`2.083333333333333` — a 5e-15 discrepancy. That is the concrete reason for the
`toBeCloseTo(_, 6)` rule: an exact-equality assertion on that one value would fail against a
correct implementation.

### 6.1 Fixture A — 100 LCM Freestyle, 2 lengths

Course LCM (`L` = 50 m), `cycleDefinition: 'same-hand'`, entered breakout distances
**9.5 m** (L1) and **8.0 m** (L2), flag distance **5 m** confirmed.

Tags (seconds):

| Tag | Time |
| --- | ---- |
| Signal | 10.000 |
| Start | 10.680 |
| Entry | 11.400 |
| Kick ×6 | 12.000, 12.400, 12.800, 13.200, 13.600, 14.000 |
| Breakout (L1) | 15.400 |
| Stroke ×16 (L1) | 15.900 then every 1.200 → last 33.900 |
| 15m | 16.500 |
| Turn Start | 35.400 |
| Turn End | 36.500 |
| Breakout (L2) | 40.000 |
| Stroke ×18 (L2) | 40.500 then every 1.250 → last 61.750 |
| Flags | 63.000 |
| Finish | 65.400 |

Expected:

| Metric | Value | Derivation |
| ------ | ----- | ---------- |
| Reaction time | `0.680` s | 10.680 − 10.000 |
| Flight time | `0.720` s | 11.400 − 10.680 |
| Breakout time L1 | `4.720` s | 15.400 − 10.680 |
| Breakout time L2 | `3.500` s | 40.000 − 36.500 |
| Underwater velocity L1 | `2.012711864406780` m/s ⚠️ | 9.5 / 4.720 |
| Underwater velocity L2 | `2.285714285714286` m/s ⚠️ | 8.0 / 3.500 |
| Kick count L1 | `6` | 6 tags |
| Kick tempo L1 | `150.000` kicks/min | 60 × 5 / (14.000 − 12.000) |
| 15 m time | `5.820` s | 16.500 − 10.680 |
| 0–15 m velocity | `2.577319587628866` m/s | 15 / 5.820 |
| Cycle count L1 | `16` | 16 tags |
| Stroke rate L1 | `50.000` cycles/min | 60 × 15 / (33.900 − 15.900) = 900 / 18.000 |
| Cycle count L2 | `18` | 18 tags |
| Stroke rate L2 | `48.000` cycles/min | 60 × 17 / (61.750 − 40.500) = 1020 / 21.250 |
| DPC L1 | `2.531250` m ⚠️ | (50 − 9.5 − 0) / 16 = 40.5 / 16 |
| DPC L2 | `2.055555555555556` m ⚠️ | (50 − 8.0 − 5) / 18 = 37.0 / 18 |
| Turn time | `1.100` s | 36.500 − 35.400 |
| Split L1 | `24.720` s | 35.400 − 10.680 |
| Split L2 | `30.000` s | 65.400 − 35.400 |
| Split sum | `54.720` s | equals race time — assert this |
| Length velocity L1 | `2.022653721682848` m/s | 50 / 24.720 |
| Length velocity L2 | `1.666666666666667` m/s | 50 / 30.000 |
| Race time | `54.720` s | 65.400 − 10.680 |
| Race mean velocity | `1.827485380116959` m/s | 100 / 54.720 |
| Finish segment time | `2.400` s | 65.400 − 63.000 |
| Finish segment velocity | `2.083333333333333` m/s | 5 / 2.400 |
| Problems | `[]` | valid tag set |

Note the reaction time `0.680` sits **below** the S2 band of ".75 to 1.00". Assert that this
produces **no** problem and **no** clamping — the band is display metadata only.

### 6.2 Fixture B — 200 SCY Freestyle, 8 lengths

Course SCY (`L` = 25 **yd**), `fifteenMetreReferenceConfirmed: false`, no breakout distances
entered, no `Signal`, no `Flags`, no `Kick` tags.

Construction (all exact):

- `Start` = 5.000, `Entry` = 5.700
- L1: `Breakout` 8.000; strokes ×10 at 8.500 + 1.000·i (last 17.500); `Turn Start` 20.000; `Turn End` 21.000
- For k = 2…7, with `TurnEnd(k−1)` as that length's origin `T`:
  `Breakout` = T + 2.500; strokes ×10 from T + 3.000 every 1.000 (last T + 12.000);
  `Turn Start` = T + 19.000; `Turn End` = T + 20.000
- Therefore `TurnEnd(k)` = 21.000 + (k − 1) × 20.000 → `TurnEnd(7)` = **141.000**
- L8: `Breakout` = 143.500; strokes ×10 from 144.000 every 1.000 (last 153.000); `Finish` = **160.500**

Expected:

| Metric | Value | Derivation |
| ------ | ----- | ---------- |
| Unit on every distance | `yd` | never `m` |
| Unit on every velocity | `yd/s` | **never `m/s`** — assert no emitted unit string equals `m/s` |
| Reaction time | absent | no `Signal` tag |
| Flight time | `0.700` s | 5.700 − 5.000 |
| 15 m metrics | absent, `FIFTEEN_METRE_UNAVAILABLE` | SCY without confirmation |
| Breakout distance, DPC (all lengths) | absent | none entered |
| Breakout time L1 | `3.000` s | 8.000 − 5.000 |
| Breakout time L2…L8 | `2.500` s each | T + 2.500 − T |
| Cycle count, each length | `10` | 80 total |
| Stroke rate, each length | `60.000` cycles/min | 60 × 9 / 9.000 |
| Turn count | `7` | no turn on L8 |
| Turn time, each | `1.000` s | |
| Split L1 | `15.000` s | 20.000 − 5.000 |
| Splits L2…L7 | `20.000` s each | TurnStart(k) − TurnStart(k−1) |
| Split L8 | `20.500` s | 160.500 − 140.000 |
| Split sum | `155.500` s | 15.000 + 6×20.000 + 20.500 — equals race time |
| Length velocity L1 | `1.666666666666667` yd/s | 25 / 15.000 |
| Length velocity L2…L7 | `1.250` yd/s | 25 / 20.000 |
| Length velocity L8 | `1.219512195121951` yd/s | 25 / 20.500 |
| Race time | `155.500` s | 160.500 − 5.000 |
| Race mean velocity | `1.286173633440514` yd/s | 200 / 155.500 |
| Finish segment | absent | no `Flags` tag |
| Problems | only `FIFTEEN_METRE_UNAVAILABLE` (info) | otherwise valid |

### 6.3 Fixture C — Fixture A with `Turn End` deleted

Take Fixture A, remove the `Turn End` tag at 36.500. Assert **exactly**:

- one `UNPAIRED_TURN` warning
- turn time → absent
- breakout time L2 → absent (its origin was `Turn End`)
- underwater velocity L2 → absent
- **split L1 still `24.720`** and **split L2 still `30.000`** — the missing tag must not shift the split boundaries, because `Turn Start` and `Finish` are both still present
- stroke rate L2 still `48.000` — stroke segmentation must not depend on `Turn End`
- race time still `54.720`

This fixture is the single highest-value test in the suite: it is the regression guard for the
prototype's `i += 2` turn-pairing bug, where one missed keystroke silently corrupts the entire
back half of a race.

---

## 7. Verified repo facts every brief must honour

Checked against the tree on 2026-08-02. Agents must not rediscover these.

| Fact | Detail |
| ---- | ------ |
| **Vitest scope** | `vitest.config.ts` → `include: ['tests/**/*.test.ts']`, `environment: 'node'`, `globals: true`. **Engine tests go in the repo-root `tests/` directory.** A test under `packages/` is never collected. |
| **Test import style** | Existing tests import by relative path — `import { x } from '../packages/core/src/lib/athleteHistory'` — not by package alias. Match it. |
| **Two test systems** | `npm test` runs `scripts/run-tests.mjs` (a list of `.mjs` scripts via tsx). `npm run test:unit` runs vitest. They are separate; do not merge them. |
| **Typecheck** | Each package's `lint` script is `tsc --noEmit -p tsconfig.json`. `npm run lint` runs all of them. `tsconfig.base.json` has `strict: true`, `isolatedModules: true`, `moduleResolution: 'bundler'`, `noEmit: true`. |
| **Path aliases** | `tsconfig.base.json` maps `@omniswim/core` → `packages/core/src/index.ts` and `@omniswim/core/*` → `packages/core/src/*`. `packages/core/package.json` already exports `"./lib/*": "./src/lib/*"`, so `@omniswim/core/lib/raceAnalysis` resolves to the directory's `index.ts`. **A1 must prove this resolves** — see its brief. |
| **Course literals** | `packages/core/src/types.ts` uses the inline union `'SCY' \| 'LCM' \| 'SCM'` in several places; there is no exported named type. The engine defines its own named `RaceCourse` and does not refactor the existing literals. |
| **DB child-table pattern** | Workspace children are generic `(workspace_id, position, data TEXT)` tables listed in `CHILD_TABLES` (`packages/db/src/workspacePersistence.ts`) and assembled by `assembleWorkspace`. **This is the pattern to follow** — not bespoke typed columns. |
| **DB delete loop is duplicated** | `WorkspaceService.writeWorkspaceUnsafe` hardcodes the table list as a literal array rather than importing `CHILD_TABLES`. `PgWorkspaceService` does the same. Both must be updated; forgetting one leaves stale rows on save. |
| **No new REST routes needed** | `PUT /api/workspaces/:id` already round-trips the whole workspace. A new `Workspace` field persists with **zero** changes to `apps/shell/server.ts` and zero new files in `packages/core/src/api/`. |
| **`/api/analyze-video` is a 501 stub** | Reserved for a future Gemini integration. Leave it alone. |
| **UI primitives that already exist** | `ChartShell`, `ChartFrame`, `EmptyState`, `useToast` from `@omniswim/ui`; `useThemeColors` from `@omniswim/core/lib/useThemeColors`; `useSuiteWorkspace` from `@omniswim/core/store/SuiteWorkspaceProvider`. Recharts is already a `packages/metrics` dependency. |
| **No new dependencies** | Nothing in this plan requires a package install. An agent that wants one must stop and report instead. |
| **Tailwind v4** | Use the existing `--ui-*` / `--surface-*` / `--text-*` custom properties. Per the repo's known token-collision issue, **never** introduce an unprefixed global token. |

---

## 8. Target architecture

```
packages/core/src/lib/raceAnalysis/
  types.ts             Measured<T>, Provenance, Unit, RaceTag, TagKind, Problem, ProblemCode
  reference.ts         Cited S2 bands + source manifest (URL, retrievedAt, verbatim quote)
  course.ts            RaceCourse → pool length + unit; the single yd↔m boundary
  tagStateMachine.ts   S/D/A/R/G/K press → next legal tag; legality; undo; validation
  segment.ts           Tags → per-length segments (breakout, strokes, turn, finish)
  metrics.ts           Segments → Measured<> values. Pure. No React, no I/O.
  index.ts             Public surface

tests/
  raceAnalysis.test.ts           Fixtures A, B, C from §6
  raceAnalysisPurity.test.ts     Source-grep guard (see A1 brief)

packages/metrics/src/                 UI ONLY — imports the engine, computes nothing
  components/TagDeck.tsx              Live tag state, key legend, per-length progress
  components/TagTimeline.tsx          Tag markers on the scrubber, click to seek
  components/TagTable.tsx             Editable tag list — nudge ±1 frame, retype, delete
  components/RaceSetupForm.tsx        (rewrite) course/distance/stroke → length count
  components/MetricsDashboard.tsx     (rewrite) Measured<>-aware, absent-aware
  components/VelocityProfile.tsx      Step chart over segments
  components/TempoProfile.tsx         Per-cycle stroke rate + per-length mean overlay
  components/SessionComparePanel.tsx  (currently 0 bytes) two analyses side by side

packages/db/src/                      race_analyses child table, SQLite + Postgres
packages/core/src/types.ts            one optional Workspace.raceAnalyses field
```

Engine in `core`, presentation in `metrics`. The engine must be unit-testable with zero DOM.

---

## 9. Agent DAG

`.fleet.json`: `isolateByDefault: true`, `maxConcurrent: 3`, `fallbackDepth: 4`,
fairness `spread` @ 0.35.

**Cursor is ineligible for every edit assignment here.** `fleet_route_preview` rejects all five
Cursor models — *"cursor cannot be contained in a git worktree (edits escape to the origin
repo)"*. With `isolate: true` mandatory in this repo, the usable fleet is **Claude + Codex
only**. Do not plan around Cursor capacity.

### 9.1 How the phase gates actually work (corrected)

`cartographer.ts` `createWorktree()` cuts a worktree at `HEAD`, then **seeds it with
`git diff HEAD --binary` from the real tree and commits that seed**. Consequences:

1. Agents see the **current uncommitted working tree**, including the 45 dirty roster files. Briefs do not need to warn about a stale checkout.
2. A returned patch is diffed against that seeded state, so it applies onto the current dirty tree.
3. **A phase gate therefore needs `fleet_apply_patch` only — no commit.** Once A1's patch is applied to the working tree, every Phase 2 worktree is seeded with it.
4. Concurrent agents in one phase each seed from the tree as it was **at spawn time**. Spawn a phase's agents together, then apply their patches one at a time, checking each.

### 9.2 The DAG

```
  ┌───────────────────────── PHASE 1 (serial, 1 agent) ─────────────────────────┐
  │ A1  core engine: types, reference, course, state machine, segment, metrics,  │
  │     + tests/raceAnalysis.test.ts (Fixtures A/B/C) + purity guard             │
  └──────────────────────────────────┬──────────────────────────────────────────┘
                    GATE 1 — apply A1 patch, run vitest, read A1's API report
  ┌────────────────────┬─────────────┴─────────────┬────────────────────┐
  │  B1 tagging UI     │  B2 persistence           │  B3 adversarial audit
  │  packages/metrics  │  packages/db + core/types │  read-only, no patch
  └────────────────────┴─────────────┬─────────────┴────────────────────┘
                    GATE 2 — apply B1 + B2 (disjoint), triage B3's findings
  ┌────────────────────┬─────────────┴─────────────┐
  │  C1 visualisation  │  C2 export / compare      │
  └────────────────────┴─────────────┬─────────────┘
                    GATE 3 — apply C1 + C2
                        PHASE 4 — D1 finisher (serial)
```

**Why Phase 1 is serial.** Types, state machine, and formulas are one coupled correctness
problem. Splitting them yields three incompatible `Measured<T>` definitions and a merge that
silently drops a provenance flag — exactly what §3 exists to prevent. Everything after runs wide.

**Why B3 runs concurrently.** Second-opinion pattern. B3 gets the same Phase-1 output but a
different provider, is told to *refute*, and produces findings only. Disagreement between A1
and B3 **is** the finding — surface it, never silently pick a winner.

### 9.3 Routing (from `fleet_route_preview`, `isolate: true`, `cwd` = repo root)

| Assign | Needs | Primary | Fallback chain |
| ------ | ----- | ------- | -------------- |
| A1 | `architect` | `codex/gpt-5.5` | `claude/opus` → `codex/terra` → `claude/sonnet` |
| B1 | `implement` | `claude/sonnet` | `codex/terra` → `claude/opus` → `codex/luna` |
| B2 | `implement` | `claude/sonnet` | `codex/terra` → `claude/opus` → `codex/luna` |
| B3 | `review` | `claude/opus` | `codex/terra` → `codex/gpt-5.5` → `claude/sonnet` |
| C1 | `implement` | `claude/sonnet` (expected) | as B1 |
| C2 | `implement` | `claude/sonnet` (expected) | as B1 |
| D1 | `test` | `claude/haiku` (role-capped to formatter/scout here) | `codex/luna` |

B1 and B2 both score to `claude/sonnet`. With `maxConcurrent: 3` and fairness `spread` at
0.35, the second concurrent assignment falls through to `codex/terra` on its own. Pin only if
the router does something surprising.

**A1 and B3 must not share a provider.** If A1 lands on `codex/gpt-5.5`, force B3 with
`only: ["claude"]`. An audit by the family that wrote the code is not independent.

### 9.4 File ownership — one owner per file, per phase

Overlap is the main way a parallel phase produces conflicting patches. Exhaustive:

| File / glob | Owner | Everyone else |
| ----------- | ----- | ------------- |
| `packages/core/src/lib/raceAnalysis/**` | **A1** | read-only |
| `packages/core/src/index.ts` | **A1** (one export block) | do not touch |
| `tests/raceAnalysis*.test.ts` | **A1** | do not touch |
| `packages/core/src/types.ts` | **B2** (one optional `Workspace` field) | do not touch |
| `packages/db/src/**` | **B2** | do not touch |
| `packages/metrics/src/MetricsApp.tsx` | **B1** | do not touch |
| `packages/metrics/src/types.ts` | **B1** | C1/C2 import, never edit |
| `packages/metrics/src/components/VideoPlayer.tsx` | **B1** | do not touch |
| `packages/metrics/src/components/{TagDeck,TagTimeline,TagTable,RaceSetupForm}.tsx` | **B1** | do not touch |
| `packages/metrics/src/components/{MetricsDashboard,VelocityProfile,TempoProfile}.tsx` | **C1** | do not touch |
| `packages/metrics/src/components/SessionComparePanel.tsx` | **C2** | do not touch |
| `packages/metrics/src/lib/**` | **C2** | B1 may *read* `videoMeta.ts`, never edit |
| `apps/shell/**`, `packages/{manager,matrix,ui}/**` | **nobody** | out of scope entirely |

### 9.5 Rules that go in every brief

1. **Run no git command.** Patch collection is the harness's job.
2. **Install no dependency.** If one seems necessary, stop and report.
3. **Stay inside your declared scope**, even when you spot a bug elsewhere — report it instead.
4. **Report what you could not do.** A partial result that says so beats a complete-looking one that quietly skipped a requirement.
5. **This masterplan is not in your worktree** in a usable form — every brief is self-contained. Do not look for it.

---

## 10. Subplans (lift-and-paste briefs)

### A1 — Core race-analysis engine

> **Goal.** Create `packages/core/src/lib/raceAnalysis/` in the omniswim-suite monorepo: a
> pure, DOM-free TypeScript engine turning operator-placed video tags into swimming race
> metrics, plus its tests.
>
> **Repo facts — do not rediscover these.**
> - `tsconfig.base.json` is `strict: true`, `isolatedModules: true`, `moduleResolution: 'bundler'`, `noEmit: true`. Typecheck with `npx tsc --noEmit -p packages/core/tsconfig.json`.
> - **Vitest only collects `tests/**/*.test.ts` at the repo root.** A test file under `packages/` is never run. Put your tests in `tests/raceAnalysis.test.ts` and `tests/raceAnalysisPurity.test.ts`.
> - Existing tests import by relative path (`import { x } from '../packages/core/src/lib/athleteHistory'`), not by package alias. Match that.
> - Run tests with `npx vitest run tests/raceAnalysis.test.ts tests/raceAnalysisPurity.test.ts`.
> - `packages/core/src/types.ts` already uses the inline union `'SCY' | 'LCM' | 'SCM'`. Define your own named `RaceCourse` type inside your directory; **do not refactor the existing literals** — that file is owned by another agent this phase.
> - Add **no** dependency. Run **no** git command.
>
> **The tag model.** Three operator keys from Swimcloud's published method. `S` and `D` are
> sequential — each press emits the next tag in a per-length state machine. `A` is one-shot.
> - First length: `S` Start, `S` Entry, `S` Breakout, `S` Stroke (×n), `D` Turn Start, `D` Turn End
> - Middle lengths: `S` Breakout, `S` Stroke (×n), `D` Turn Start, `D` Turn End
> - Last length: `S` Breakout, `S` Stroke (×n), `D` Finish
> - `A` = 15 m mark, optional, at most once per length
>
> Three additional tags that are **ours, not Swimcloud's** — mark them as such in code comments:
> `Signal` (starting horn/strobe; without it reaction time is not computable), `Flags` (head
> crossing the backstroke flags on the final length), `Kick` (underwater dolphin kick).
>
> Length count = `raceDistance / poolLength`, known before tagging.
>
> **Provenance types — build these first.**
> ```ts
> type Provenance = 'tagged' | 'entered' | 'derived' | 'official';
> type Unit = 'm' | 'yd' | 's' | 'm/s' | 'yd/s' | 'cycles/min' | 'kicks/min' | 'count';
> type Measured<T> =
>   | { status: 'value'; value: T; provenance: Provenance; approximate: boolean; unit: Unit }
>   | { status: 'absent'; reason: string };
> ```
> Every metric returns `Measured<>`. **Never a bare number.** No `?? 0`, no `|| 0`, no default
> constant anywhere. Uncomputable ⇒ `{ status: 'absent', reason: '<why>' }`.
>
> **Config the engine requires** (all explicit, nothing inferred):
> `course: 'SCY' | 'SCM' | 'LCM'`, `raceDistance`, `strokePerLength: Stroke[]` (length =
> length count), `cycleDefinition: 'same-hand' | 'single-pull'`, optional
> `breakoutDistanceByLength`, optional `flagDistance`, `fifteenMetreReferenceConfirmed:
> boolean`, `isRelayLeg: boolean`.
>
> **Metrics.** `t(x)` = tag time in seconds, `L` = pool length, `n` = 1-based length index.
>
> | Metric | Formula | Unit |
> | --- | --- | --- |
> | Reaction time | `t(Start) − t(Signal)`; absent without `Signal`; absent when `isRelayLeg` with reason "relay takeoff — not comparable to a flat start" | s |
> | Flight time | `t(Entry) − t(Start)`; same relay rule | s |
> | Breakout time L1 | `t(Breakout₁) − t(Start)` | s |
> | Breakout time L n>1 | `t(Breakoutₙ) − t(Turn Endₙ₋₁)` | s |
> | Underwater velocity | `breakoutDistanceₙ / breakoutTimeₙ`; absent without an entered distance; `approximate: true` when present | m/s or yd/s |
> | Kick tempo | `60 × (kickCount − 1) / (t(lastKick) − t(firstKick))`; absent with <2 kick tags in that length | kicks/min |
> | 15 m time L1 | `t(15m₁) − t(Start)` | s |
> | 15 m time L n>1 | `t(15mₙ) − t(Turn Endₙ₋₁)` | s |
> | 0–15 m velocity | `15 / (15 m time)` | m/s |
> | Cycle time i | `t(Strokeᵢ₊₁) − t(Strokeᵢ)` | s |
> | Stroke rate, instantaneous | `60 / cycleTime` | cycles/min |
> | Stroke rate, length n mean | `60 × (cycleCountₙ − 1) / (t(lastStrokeₙ) − t(firstStrokeₙ))`; absent with <2 stroke tags on that length | cycles/min |
> | Cycle count, length n | count of `Stroke` tags on length n | count |
> | Distance per cycle, length n | `(L − breakoutDistanceₙ − finishApproachₙ) / cycleCountₙ`; absent without breakout distance; always `approximate: true`. `finishApproachₙ` = 0 except on the last length, where it is `flagDistance` if a `Flags` tag exists, else 0 | m or yd |
> | Turn time, turn n | `t(Turn Endₙ) − t(Turn Startₙ)` | s |
> | Length split n | boundary is `Turn Start`; final split ends at `Finish` | s |
> | Length mean velocity | `L / splitₙ` | m/s or yd/s |
> | Race time | `t(Finish) − t(Start)` | s |
> | Race mean velocity | `raceDistance / raceTime` | m/s or yd/s |
> | Finish segment time | `t(Finish) − t(Flags)`; absent without a `Flags` tag | s |
> | Finish segment velocity | `flagDistance / finishSegmentTime`; absent unless `flagDistance` was explicitly supplied | m/s or yd/s |
>
> **Correctness rules — each of these is a real bug in the code being replaced.**
> 1. **Never average stroke gaps across a wall.** Segment stroke tags by length first, then average within the length. A gap spanning a turn is not a cycle.
> 2. **`n` stroke tags give `n − 1` intervals.** A mean over `n` is wrong.
> 3. **SCY is yards.** `SCY` → 25 yd, `SCM` → 25 m, `LCM` → 50 m. A yd/s value may never carry an `m/s` label. 1 yd = 0.9144 m exactly; convert only in one explicit boundary function in `course.ts`, never implicitly.
> 4. **The 15 m tag is metric.** When `course === 'SCY'` and `fifteenMetreReferenceConfirmed` is false, all 15 m metrics are absent with problem `FIFTEEN_METRE_UNAVAILABLE`. Never derive 15 m from a yard landmark.
> 5. **Do not assume paired turn tags.** A `Turn Start` without a `Turn End` makes that turn time and that length's *breakout* metrics absent — but must **not** shift any split boundary or any stroke segmentation. See Fixture C.
> 6. **No interpolation, extrapolation, projection, or estimation anywhere.** There is no continuous velocity track, only segment means. Asked for velocity between landmarks: return absent.
> 7. **No fatigue index.** Expose per-length stroke rate, per-length velocity, and a first-vs-last delta labelled explicitly as a delta.
> 8. **`breakoutDistance > 15 m`** raises warning `BREAKOUT_EXCEEDS_15M`. Warn; never clamp, never drop.
> 9. **IM:** `strokePerLength` is supplied by the caller. Export a helper that *proposes* the standard order fly → back → breast → free split evenly across the lengths, and raises `IM_LENGTHS_NOT_DIVISIBLE` when the length count is not divisible by 4. The helper proposes; it never silently applies.
>
> **Reference bands.** `reference.ts` holds the four published bands as data — each with the
> source URL, `retrievedAt: '2026-08-02'`, and the verbatim quote. Display metadata only: **no
> logic branches on them, and no value below appears as a bare literal anywhere else.**
> - Start: `".75 to 1.00 avg."`
> - 15 m time: `"world-class swimmers get there in under 6 seconds. Senior kids should shoot for 6-7 seconds or better."`
> - Turn time: `"Generally speaking you are trying to keep the turn at 1.0 to 1.2 or less."`
> - Underwater limit: `"you can only legally go 15 meters underwater."`
> - URL for all four: `https://support.swimcloud.com/hc/en-us/articles/360008576693-Analyzing-the-Data`
>
> **Problem taxonomy.** Validation returns `Problem[]` — never throws, never silently skips.
> Stable codes, each with `severity: 'error' | 'warning' | 'info'`, a human message, and the
> affected length index where applicable:
> `MISSING_START`, `MISSING_FINISH`, `MISSING_BREAKOUT`, `UNPAIRED_TURN`,
> `TURN_ON_LAST_LENGTH`, `FINISH_BEFORE_LAST_LENGTH`, `STROKE_BEFORE_BREAKOUT`,
> `INSUFFICIENT_STROKE_TAGS`, `NON_MONOTONIC_TAGS`, `BREAKOUT_EXCEEDS_15M`,
> `LENGTH_COUNT_MISMATCH`, `FIFTEEN_METRE_UNAVAILABLE`, `IM_LENGTHS_NOT_DIVISIBLE`,
> `SPLIT_DIVERGENCE`.
>
> **State machine.** `tagStateMachine.ts` exposes: what the next `S` press produces, what the
> next `D` press produces, whether a press is currently legal, `undo()`, and a validator over
> a completed tag set returning `Problem[]`.
>
> **Tests — `tests/raceAnalysis.test.ts`.** Every numeric assertion uses
> `expect(x).toBeCloseTo(expected, 6)`. **Never `toBe`/`toEqual` on a computed float.**
> Integers (counts, indices) use `toBe`. Use these fixtures and these expected values verbatim
> — invent no others.
>
> *Fixture A — 100 LCM Freestyle, 2 lengths, `cycleDefinition: 'same-hand'`, breakout
> distances 9.5 m (L1) and 8.0 m (L2), flagDistance 5 m.*
> Tags: Signal 10.000 · Start 10.680 · Entry 11.400 · Kick 12.000, 12.400, 12.800, 13.200,
> 13.600, 14.000 · Breakout 15.400 · Stroke ×16 from 15.900 every 1.200 (last 33.900) ·
> 15m 16.500 · Turn Start 35.400 · Turn End 36.500 · Breakout 40.000 · Stroke ×18 from 40.500
> every 1.250 (last 61.750) · Flags 63.000 · Finish 65.400.
> Expected: reaction `0.680`; flight `0.720`; breakout time L1 `4.720`, L2 `3.500`; underwater
> velocity L1 `2.012711864406780`, L2 `2.285714285714286`; kick count `6`; kick tempo
> `150.000`; 15 m time `5.820`; 0–15 m velocity `2.577319587628866`; cycle count L1 `16`, L2
> `18`; stroke rate L1 `50.000`, L2 `48.000`; DPC L1 `2.531250`, L2 `2.055555555555556`; turn
> time `1.100`; split L1 `24.720`, L2 `30.000`; length velocity L1 `2.022653721682848`, L2
> `1.666666666666667`; race time `54.720`; race mean velocity `1.827485380116959`; finish
> segment time `2.400`; finish segment velocity `2.083333333333333`; `problems` empty. Also
> assert the split sum equals race time, and that the reaction of `0.680` — below the ".75 to
> 1.00" band — produces **no** problem and **no** clamping.
>
> *Fixture B — 200 SCY Freestyle, 8 lengths, `fifteenMetreReferenceConfirmed: false`, no
> breakout distances, no Signal/Flags/Kick tags.*
> Start 5.000 · Entry 5.700. L1: Breakout 8.000; Stroke ×10 from 8.500 every 1.000 (last
> 17.500); Turn Start 20.000; Turn End 21.000. For k = 2…7 with `T = TurnEnd(k−1)`: Breakout
> `T+2.500`; Stroke ×10 from `T+3.000` every 1.000; Turn Start `T+19.000`; Turn End
> `T+20.000` — so `TurnEnd(7) = 141.000`. L8: Breakout 143.500; Stroke ×10 from 144.000 every
> 1.000 (last 153.000); Finish 160.500.
> Expected: flight `0.700`; reaction absent; all 15 m metrics absent with
> `FIFTEEN_METRE_UNAVAILABLE`; all breakout-distance and DPC values absent; breakout time L1
> `3.000` and L2…L8 `2.500`; cycle count `10` per length (80 total); stroke rate `60.000`
> every length; 7 turns each `1.000`; split L1 `15.000`, L2…L7 `20.000`, L8 `20.500`, sum
> `155.500`; length velocity L1 `1.666666666666667`, L2…L7 `1.250`, L8 `1.219512195121951`;
> race time `155.500`; race mean velocity `1.286173633440514`; finish segment absent.
> **Assert that no emitted unit string anywhere in the result equals `'m'` or `'m/s'`** — this
> race is in yards.
>
> *Fixture C — Fixture A with the `Turn End` at 36.500 removed.* Assert exactly: one
> `UNPAIRED_TURN` warning; turn time absent; breakout time L2 absent; underwater velocity L2
> absent; **split L1 still `24.720` and split L2 still `30.000`**; stroke rate L2 still
> `48.000`; race time still `54.720`. This is the regression guard for a turn-pairing bug in
> the code being replaced, where one missed keystroke corrupted every later split.
>
> **Purity guard — `tests/raceAnalysisPurity.test.ts`.** Read every `.ts` file under
> `packages/core/src/lib/raceAnalysis/` from disk and fail on any occurrence of `?? 0`,
> `|| 0`, `Math.random`, `Math.sin`, `Math.cos`, or `fatigue`.
>
> **Module resolution — prove it.** `packages/core/package.json` already exports
> `"./lib/*": "./src/lib/*"`. Confirm that `import { … } from '@omniswim/core/lib/raceAnalysis'`
> resolves to your `index.ts` by adding a temporary file that imports it that way and running
> `npx tsc --noEmit -p packages/metrics/tsconfig.json`; delete the temporary file afterwards.
> **Additionally** re-export your public surface from `packages/core/src/index.ts` so
> `@omniswim/core` works too. If the subpath does not resolve, say so explicitly in your
> report — the UI agent needs to know which import form to use.
>
> **Done means.** `npx tsc --noEmit -p packages/core/tsconfig.json` clean;
> `npx vitest run tests/raceAnalysis.test.ts tests/raceAnalysisPurity.test.ts` green; and you
> have reported **your full exported API surface — every exported type, function name, and
> signature, plus the working import specifier**, because three later agents build against
> that report without reading your diff.
>
> **Scope boundary.** Touch only `packages/core/src/lib/raceAnalysis/**`, one export block in
> `packages/core/src/index.ts`, and the two new files in `tests/`. Do **not** touch
> `packages/core/src/types.ts`, `packages/metrics`, `packages/db`, `packages/manager`,
> `packages/matrix`, `packages/ui`, or `apps/shell`. Install no dependency. Run no git command.
> If you spot a bug outside your scope, report it rather than fixing it.

---

### B1 — Tagging UI

> **Goal.** Rewrite the tagging half of `packages/metrics` in the omniswim-suite monorepo so a
> coach can tag a race video frame-accurately. **UI only — this package must contain zero
> metric arithmetic.** All maths comes from the `@omniswim/core` race-analysis engine, whose
> exact API is below.
>
> **[Paste A1's reported API surface and working import specifier verbatim here before delegating.]**
>
> **Repo facts — do not rediscover.** Tailwind v4 with the existing `--ui-*` / `--surface-*` /
> `--text-*` custom properties (never add an unprefixed global token). `useSuiteWorkspace` from
> `@omniswim/core/store/SuiteWorkspaceProvider`; `EmptyState`, `useToast` from `@omniswim/ui`.
> Typecheck with `npx tsc --noEmit -p packages/metrics/tsconfig.json`. Add no dependency. Run
> no git command.
>
> **Delete these fabrications.** In `packages/metrics/src/MetricsApp.tsx`, delete the whole
> `calculateMetricsLocal()` function and call the core engine instead; also delete the
> hardcoded `goalTime` / `worldRecordTime` literals (`50.0`, `23.0`, `120.0`, `46.86`, `20.91`,
> `110.0`) — they are applied to every stroke and both genders and are not sourced; render
> absent instead. In `packages/metrics/src/components/VideoPlayer.tsx`, delete
> `interpolatedPace` (a `Math.sin` fake), `interpolatedSR` (a `Math.cos` fake), and the
> `runBodyDetect` / `selectLane` / `detectedLanes` / `scanState` dead stubs; and fix the `s/m`
> unit label on `calculateLiveSPM` — that value is **cycles per minute**.
>
> **Keyboard model — keyboard only.** `S` advances Start → Entry → Breakout → Stroke
> (repeating) within a length. `D` advances Turn Start → Turn End, and on the final length
> produces Finish. `A` marks the 15 m mark (at most once per length). Per-length sequences:
> - First length: `S` Start, `S` Entry, `S` Breakout, `S` Stroke ×n, `D` Turn Start, `D` Turn End
> - Middle lengths: `S` Breakout, `S` Stroke ×n, `D` Turn Start, `D` Turn End
> - Last length: `S` Breakout, `S` Stroke ×n, `D` Finish
>
> Three more keys, each labelled in the legend as an **OmniSwim addition, not a Swimcloud key**:
> `R` = starting signal (horn/strobe — without it reaction time cannot be computed), `G` =
> flags crossing on the final length, `K` = underwater dolphin kick. Plus `Ctrl+Z` = undo the
> last tag.
>
> **Do not implement gamepad or Gamepad API support** — explicitly out of scope.
>
> **Components to build**, all in `packages/metrics/src/components/`:
> 1. `TagDeck.tsx` — current length, what the next `S` press and next `D` press will produce, running per-kind tag counts, and the key legend. Reads its state from the core state machine; holds no rules of its own.
> 2. `TagTimeline.tsx` — colour-coded tag markers on the video scrubber; clicking a marker seeks the video to it.
> 3. `TagTable.tsx` — every tag as an editable row: nudge ±1 frame, retype the kind, delete. Editing re-runs validation and renders the engine's `Problem[]` grouped by severity (error / warning / info).
> 4. `RaceSetupForm.tsx` — rewrite. Course (SCY/SCM/LCM), distance, stroke, swimmer (from `useSuiteWorkspace().rosterNames`). Must additionally collect, because the engine requires them explicitly: the **cycle definition** (`same-hand` for free/back, `single-pull` for fly/breast — show the default, let the operator change it, and display the choice next to every stroke-rate figure); the **per-length stroke array** (for IM, show the engine's proposed fly → back → breast → free order and require confirmation — never auto-apply); optional **per-length breakout distances**; optional **flag distance** with explicit confirmation; an **"is a relay leg"** toggle; and for SCY only, a **"my pool has a visible 15 m reference"** checkbox that gates the `A` key. Display the derived length count.
>
> **Frame accuracy.** `packages/metrics/src/lib/videoMeta.ts` already measures fps via
> `requestVideoFrameCallback` — **read it, do not edit it** (another agent owns `lib/`). Wire
> the measured fps into `VideoPlayer`'s frame stepping instead of the current hardcoded default
> of 30, and show measured-vs-assumed fps in the UI. When fps could not be measured, say so —
> never silently assume 30.
>
> **Done means.** `npx tsc --noEmit -p packages/metrics/tsconfig.json` clean; a grep of
> `packages/metrics/src` for `Math.sin`, `Math.cos`, `Math.random`, `?? 0`, `|| 0` returns
> nothing in the files you own; `calculateMetricsLocal` no longer exists.
>
> **Scope boundary.** Touch only `packages/metrics/src/MetricsApp.tsx`,
> `packages/metrics/src/types.ts`, and
> `packages/metrics/src/components/{VideoPlayer,TagDeck,TagTimeline,TagTable,RaceSetupForm}.tsx`.
> Do **not** touch `MetricsDashboard.tsx`, `VelocityProfile.tsx`, `TempoProfile.tsx`,
> `SessionComparePanel.tsx`, or anything under `packages/metrics/src/lib/` — other agents own
> those. Do not touch `packages/core`, `packages/db`, or `apps/shell`. Install no dependency.
> Run no git command.

---

### B2 — Persistence

> **Goal.** Persist race analyses in the omniswim-suite monorepo alongside existing workspace
> data.
>
> **[Paste A1's reported API surface verbatim here before delegating.]**
>
> **Read this before writing anything — the pattern is not what it looks like.** This repo does
> **not** use bespoke typed tables with hand-written CRUD per entity. Workspace children are
> generic tables shaped `(workspace_id TEXT, position INTEGER, data TEXT)` — sometimes with an
> `id TEXT PRIMARY KEY` — where `data` is a JSON blob. They are listed in `CHILD_TABLES` in
> `packages/db/src/workspacePersistence.ts` and reassembled by `assembleWorkspace` in the same
> file. Follow `athlete_history` exactly as the model.
>
> **Also: no new REST routes are needed.** `PUT /api/workspaces/:id` in `apps/shell/server.ts`
> already round-trips the entire workspace, so a new `Workspace` field persists with zero
> server changes and zero new files in `packages/core/src/api/`. Do not add any. Do not touch
> `apps/shell`.
>
> **Build, in this order:**
> 1. Add an optional `raceAnalyses` field to the `Workspace` interface in `packages/core/src/types.ts`. **One optional field, nothing else in that file** — it has heavy uncommitted changes from other work and any wider edit will conflict.
> 2. Add `'race_analyses'` to `CHILD_TABLES` in `packages/db/src/workspacePersistence.ts`, and read it in `assembleWorkspace` exactly as `athlete_history` is read.
> 3. Add the `race_analyses` table DDL to **both** `packages/db/src/schema.ts` (SQLite) and `packages/db/src/pgSchema.ts` (Postgres), matching the `athlete_history` shape and its `idx_<table>_ws` index convention in each dialect.
> 4. Wire read **and** write in `packages/db/src/WorkspaceService.ts` **and** `packages/db/src/PgWorkspaceService.ts`. **Careful:** `writeWorkspaceUnsafe` contains a hardcoded literal array of table names for its `DELETE` sweep that duplicates `CHILD_TABLES` rather than importing it, and each table has its own hand-written `INSERT`. Both services do this. **Update both.** Missing one leaves stale rows on every save, which presents as "my edit didn't stick" rather than as an error.
>
> **What gets stored.** The tag array, the operator-entered configuration (course, distance,
> per-length stroke, cycle definition, breakout distances, flag distance, relay flag, 15 m
> confirmation), and video identification (file name, duration, width, height, fps). Plus
> `createdAt` / `updatedAt`.
>
> **What must NOT get stored: any computed metric.** Metrics are derived on read by the core
> engine, so a later fix to a formula retroactively corrects every stored analysis. Storing a
> computed number freezes a bug into the database. **Video files are not stored either** —
> they are large and local-only; only the file name is kept.
>
> **Migrations must be additive and non-destructive.** An existing database opens without
> error, no existing table is altered, and a workspace saved before this change loads with
> `raceAnalyses` simply absent.
>
> **Done means.** `npx tsc --noEmit -p packages/db/tsconfig.json` and
> `npx tsc --noEmit -p packages/core/tsconfig.json` both clean, and `npm run test:roundtrip`
> passes. Confirm in your report that you updated the hardcoded delete-sweep array in **both**
> services, and name the line you changed in each.
>
> **Scope boundary.** Touch only `packages/db/src/**` and the single `Workspace` field in
> `packages/core/src/types.ts`. Do **not** touch `packages/core/src/lib/**`,
> `packages/core/src/api/**`, `packages/metrics`, `packages/manager`, `packages/matrix`, or
> `apps/shell`. Install no dependency. Run no git command.

---

### B3 — Adversarial audit (read-only, no patch)

> **Goal.** Try to **refute** the correctness of a newly written swimming race-analysis engine
> at `packages/core/src/lib/raceAnalysis/` in the omniswim-suite monorepo, plus its tests at
> `tests/raceAnalysis.test.ts` and `tests/raceAnalysisPurity.test.ts`. **Findings only. Write
> no code. Produce no patch. Run no git command.**
>
> **Why this matters.** This repo's governing rule is that a wrong competition number does not
> throw — it silently produces a plausible, wrong conclusion a coach acts on. The version being
> replaced shipped a hardcoded `fatigueIndex: 8.4`, invented breakout distances of 8.5/12/10 m
> by stroke, a velocity chart generated with `Math.sin`, and a yards-derived velocity labelled
> `m/s`. Assume the same failure mode is present until you have proven otherwise.
>
> **Hunt specifically for:**
> 1. Any fabricated, defaulted, interpolated, extrapolated, or estimated competition value — any `?? 0`, `|| 0`, magic constant, or fallback that makes an unmeasured quantity look measured.
> 2. **Unit errors.** `SCY` is **yards** (25 yd); `SCM` is 25 m; `LCM` is 50 m; 1 yd = 0.9144 m exactly. A yards-derived velocity labelled `m/s` is a bug. Stroke rate is **cycles per minute**, not `s/m` and not `spm`-as-seconds.
> 3. **Absent-vs-zero conflation** — an unmeasured value rendering as `0`, `0.00`, or `''` instead of an explicit absent state with a reason.
> 4. **Stroke-rate averaging that spans a wall.** The interval between the last stroke of one length and the first of the next is not a cycle. If it is included in any mean, that is a finding.
> 5. **Turn-tag pairing assumptions.** If a missing `Turn End` causes later tags to shift onto the wrong length or the wrong split, that is high severity — one missed keystroke would then silently corrupt the whole back half of a race.
> 6. **Off-by-one in cycle counting.** `n` stroke tags give `n − 1` intervals; a mean over `n` is wrong. Check the kick-tempo formula for the same error.
> 7. **Provenance leaks** — an `approximate: true` input producing an output not marked approximate. Breakout distance and distance-per-cycle are documented approximations at source; everything downstream inherits that.
> 8. **Reference-band leakage into logic.** The values `0.75`, `1.00`, `6`, `7`, `1.0`, `1.2`, `15`, `5` are published *coaching bands*, display metadata only. If any of them appears as a bare literal that a computation or a conditional depends on, that is a finding.
> 9. **Tests that cannot fail** — assertions that would pass against a stub, `toBeCloseTo` with a precision so loose it hides a real error, or a fixture whose expected value was derived from the implementation rather than from arithmetic. **Recompute at least Fixture A's expected values yourself from the raw tag timestamps and say whether you agree with every one.**
>
> **For each finding report:** file and line, a concrete failing input (an actual tag sequence
> and the wrong number it produces), the correct expected value, and a severity. Default to
> reporting when uncertain — a false positive costs a review; a false negative ships a wrong
> number to a coach.
>
> **Scope boundary.** Read-only. Edit no file. Run no git command.

---

### C1 — Visualisation

> **Goal.** Rewrite the analytics display in `packages/metrics` of the omniswim-suite monorepo
> against an existing metric engine. **Presentation only — no arithmetic beyond formatting.**
>
> **[Paste A1's reported API surface verbatim here before delegating.]**
>
> **Non-negotiable charting rules.**
> 1. **The velocity profile is a step function, not a curve.** The tag set yields one mean velocity per segment with no data between landmarks. The code you are replacing uses `<Area type="monotone">` under a comment reading "Generate a simulated velocity point for the chart for visual intrigue" — that is exactly the bug. Draw steps or discrete points. A smooth interpolated line asserts data that does not exist.
> 2. **Every value arrives as a `Measured<T>` union and may be absent.** Render absent as an explicit "not measured" state with the engine's one-line reason in a tooltip. Never `0`, never a bare `—`, never a blank cell.
> 3. **Approximate values carry a visible badge** and repeat the source caveat — breakout distance and distance-per-cycle are documented approximations.
> 4. **Units come from the value, not the component.** A yards race renders `yd/s`. Never hardcode `m/s`. Stroke rate is `cycles/min` — the existing `s/m` label is wrong. Display the analysis's cycle definition (`same-hand` / `single-pull`) next to every stroke-rate and distance-per-cycle figure, since the two conventions differ by 2×.
> 5. **No fatigue index.** It has no published formula. Show per-length stroke rate, per-length velocity, and a first-vs-last delta labelled as a delta.
> 6. **Length 1 is not comparable to the rest** — it starts from a dive rather than a push-off. Mark it distinctly in every per-length chart and exclude it from any evenness or consistency summary, saying so.
>
> **Components**, in `packages/metrics/src/components/`:
> - `MetricsDashboard.tsx` (rewrite) — start / underwater / 15 m / stroke / turn / finish sections, each with its reference band shown as a **cited annotation** carrying the verbatim quote and source URL from the engine's `reference.ts`. Do **not** colour-code pass/fail against a band, and do **not** hardcode any band number in this file.
> - `VelocityProfile.tsx` — step chart of segment mean velocity across the race, with turn windows shaded.
> - `TempoProfile.tsx` — per-cycle instantaneous stroke rate as points, with the per-length mean as a step overlay. The coaching questions this answers are whether tempo **drops off** across the race and whether it **rises into the walls** — make both readable at a glance.
>
> **Stack.** Recharts (already a dependency — add nothing). Use the existing `ChartShell` /
> `ChartFrame` wrappers from `@omniswim/ui` and `useThemeColors` from
> `@omniswim/core/lib/useThemeColors`, exactly as the current `MetricsDashboard.tsx` does.
> Tailwind v4 with the existing `--ui-*` / `--surface-*` / `--text-*` custom properties; never
> add an unprefixed global token. Dark, light, and custom accent themes must all work.
>
> **Done means.** `npx tsc --noEmit -p packages/metrics/tsconfig.json` clean, and a grep of
> your three files for `Math.sin`, `Math.cos`, `Math.random`, `type="monotone"`, `s/m`, and
> `fatigue` returns nothing.
>
> **Scope boundary.** Touch only
> `packages/metrics/src/components/{MetricsDashboard,VelocityProfile,TempoProfile}.tsx`. Do
> **not** touch `MetricsApp.tsx`, `VideoPlayer.tsx`, `TagDeck.tsx`, `TagTimeline.tsx`,
> `TagTable.tsx`, `RaceSetupForm.tsx`, `SessionComparePanel.tsx`, anything under
> `packages/metrics/src/lib/`, `packages/core`, or `packages/db`. Install no dependency. Run no
> git command.

---

### C2 — Export, session store, comparison

> **Goal.** Rebuild the storage-adjacent and export surfaces in `packages/metrics` of the
> omniswim-suite monorepo.
>
> **[Paste A1's reported API surface verbatim here before delegating.]**
>
> **Build:**
> 1. `lib/sessionStore.ts` — the existing IndexedDB store persists a computed `BiomechanicsData` blob. Change it to persist **tags and operator configuration only**; metrics are recomputed on load by the core engine. Bump `DB_VERSION` from 1 to 2 and provide an `onupgradeneeded` path that keeps existing saved sessions openable — mark their legacy computed metrics as untrusted rather than deleting them, and surface that state to the caller.
> 2. `lib/reportExport.ts` — rewrite. Every CSV row carries its provenance and approximate flag as columns. An absent value exports as an **empty cell plus its reason** in a `reason` column, and never as `0`. The current version exports a fixed list including `Fatigue Index` and `Velocity 15m-Wall` — both were fabricated; drop them. Header the file with the swimmer, event, course, cycle definition, and the source citation for any reference band shown.
> 3. `components/SessionComparePanel.tsx` — currently a **0-byte file**. Build it: two analyses side by side with a per-metric delta.
>
> **Comparison rules.** A delta is suppressed and marked incomparable when **any** of these
> holds: either side is absent; the two analyses use different courses; the two units differ;
> or the two use different `cycleDefinition` values (the two stroke-counting conventions differ
> by 2×, so a stroke-rate delta across them is meaningless). **Never compare a yards race to a
> metres race numerically.**
>
> No arithmetic beyond subtracting two already-computed `Measured<>` values, and that
> subtraction must itself return absent when either operand is absent or the units differ.
>
> **Done means.** `npx tsc --noEmit -p packages/metrics/tsconfig.json` clean; opening a session
> saved under the old schema does not throw; `SessionComparePanel.tsx` is no longer empty.
>
> **Scope boundary.** Touch only `packages/metrics/src/lib/**` and
> `packages/metrics/src/components/SessionComparePanel.tsx`. Do **not** touch any other
> component, `packages/core`, `packages/db`, or `apps/shell`. Install no dependency. Run no git
> command.

---

### D1 — Finisher

> **Goal.** Verification pass over the omniswim-suite monorepo after a multi-agent feature
> landing. **Mechanical fixes only — make no design decisions.** Anything needing a judgment
> call gets reported, not decided.
>
> **Run and get green:**
> ```
> npm run lint
> npx vitest run
> npm test
> npx tsc --noEmit -p packages/core/tsconfig.json
> npx tsc --noEmit -p packages/metrics/tsconfig.json
> npx tsc --noEmit -p packages/db/tsconfig.json
> ```
> Note that `npm test` and `npx vitest run` are **two different suites** in this repo — `npm
> test` runs `scripts/run-tests.mjs`, vitest runs `tests/**/*.test.ts`. Both must pass.
>
> **Then grep across `packages/core/src/lib/raceAnalysis`, `packages/metrics/src`, and `tests/`
> and report every hit with file and line:**
> `Math.sin`, `Math.cos`, `Math.random`, `?? 0`, `|| 0`, `fatigue`, `s/m`, `type="monotone"`,
> `calculateMetricsLocal`, `interpolated`, `simulated`.
> Each is a known-fabrication marker from the prototype being replaced. **A hit is a failure to
> report, not a thing to quietly delete** — deleting one could remove a real behaviour.
>
> **Also verify and report:**
> - No file exports a bare `number` for a race metric whose domain value can be unmeasured.
> - No yards-derived value is labelled `m/s` anywhere.
> - `packages/metrics/src/components/SessionComparePanel.tsx` is no longer 0 bytes.
> - Every numeric assertion in `tests/raceAnalysis.test.ts` uses `toBeCloseTo`, not `toBe`, on floats.
> - `race_analyses` appears in **both** `packages/db/src/schema.ts` and `packages/db/src/pgSchema.ts`, and in the delete-sweep array of **both** `WorkspaceService.ts` and `PgWorkspaceService.ts`.
>
> **Scope boundary.** Fix only lint, type, and test failures. Do not restructure, do not
> rename, do not change a formula, do not change a test's expected value. Install no
> dependency. Run no git command.

---

## 11. Acceptance criteria for the suite

1. Every displayed number traces to an operator tag, an operator entry, or the workspace — and says which.
2. `grep -rn "Math.sin\|Math.cos\|Math.random\|fatigueIndex\|calculateMetricsLocal" packages/metrics/src packages/core/src/lib/raceAnalysis` returns nothing.
3. A yards race never displays `m/s`; stroke rate never displays `s/m`.
4. Fixture C passes: deleting one `Turn End` makes exactly that turn and its dependent breakout metrics absent, and shifts no split.
5. The velocity chart contains no interpolated points between landmarks.
6. Saving and reloading a workspace round-trips the tags, and metrics are recomputed rather than read from storage.

---

## 12. Working-tree caveat

`feat/roster-management-overhaul` has ~45 uncommitted modified files. Because worktrees are
**seeded with the uncommitted diff** (§9.1), agents see the real tree and their patches apply
back onto it — this is not a hazard by itself. Two things to watch:

1. `packages/core/src/types.ts` is already dirty **and** B2 edits it. B2's change is one optional field on `Workspace`; the brief forbids any wider edit for exactly this reason. Review that hunk before applying.
2. Nothing else in this plan touches roster or lineup code. `packages/core/src/index.ts` gets one export block from A1 and is otherwise untouched.

Never apply a returned patch unprompted — surface the path and the `fleet_apply_patch` call.
