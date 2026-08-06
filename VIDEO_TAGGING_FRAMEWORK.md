# Video & Landmark Tagging — Working Framework

**Status:** framework only, authored 2026-08-04. No detection work started.
**Purpose:** make manual video tagging work properly, and produce the ground
truth that automatic detection (roadmap workstream E1) cannot be validated
without.

**Read this before the E1 session.** E1 is deliberately scoped to its own
session; this document is what that session should start from.

---

## 0. Why this document exists

`SUITE_ROADMAP.md` §4 records four answers that together block E1:

| Fact | Consequence |
| ---- | ----------- |
| Zero races tagged | E3 has no training data |
| No footage with known landmark times | E1 accuracy **cannot be measured**, only eyeballed |
| One clip in the dataset (50 free) | No turn, so `UNPAIRED_TURN` and cross-wall segmentation are unexercised |
| The video suite is green but unproven | Tests pass against synthetic fixtures; no real race has gone through it |

The engine is built. What is missing is **evidence that it works on real
footage**, and a **measuring stick** for anything automatic that comes later.
Both are produced by the same activity: tagging real races by hand, carefully,
and recording the result in a form that can be diffed.

This document does not design the detector. It defines the tagging model as
actually implemented, the operator protocol, and the ground-truth format and
acceptance thresholds that must exist **before** a detector is written — because
a threshold agreed after seeing the model's output is not a threshold.

---

## 1. The tagging model as implemented

Everything in this section is read from the code, not proposed.
Source: `packages/core/src/lib/raceAnalysis/types.ts` and `tagStateMachine.ts`.

### 1.1 Landmark kinds

`RaceTagKind` — 12 kinds. Four are ours and have no SwimCloud equivalent:

| Kind | Meaning | Ours? |
| ---- | ------- | ----- |
| `Signal` | Starting horn or strobe | **ours** |
| `Start` | Start of the swim | |
| `Entry` | Hands/body entry after the dive | |
| `Breakout` | First surfacing stroke | |
| `Stroke` | One cycle (see 1.4) | |
| `TurnStart` | Turn initiation | |
| `TurnEnd` | Push-off complete | |
| `Finish` | Touch | |
| `FifteenMetre` | 15 m reference mark | |
| `Flags` | Head crossing the backstroke flags, final length | **ours** |
| `Kick` | Underwater dolphin kick | **ours** |

A `RaceTag` is `{ kind, time, lengthIndex? }`. `time` is seconds; `lengthIndex`
is 1-based where present.

### 1.2 Operator keys

Three **sequential** keys, whose meaning depends on race state — this is the
core of the design and why tagging is fast:

| Key | Yields, in order |
| --- | ---------------- |
| `S` | `Start` (length 1) → `Entry` → `Breakout` → `Stroke` (repeating) |
| `D` | `TurnStart` → `TurnEnd`, or `Finish` on the last length |
| `A` | `FifteenMetre` |

Three **one-shot** keys, each always producing the same kind:

| Key | Yields |
| --- | ------ |
| `R` | `Signal` |
| `G` | `Flags` |
| `K` | `Kick` |

`Ctrl`/`Cmd` + `Z` undoes the last tag.

Bindings are on `window` and switch on `event.code`, not `event.key`
(`VideoPlayer.tsx:136-158`) — so they are physical-key bindings and do not
follow a remapped keyboard layout. Every tag takes the video's
`currentTime` at the moment of the press.

The state machine refuses illegal presses rather than recording them, with a
reason string — e.g. `'D is not legal before breakout'`,
`'S is not legal after this length boundary'`, `'turn already completed for
this length'`. **A rejected press is not an error to route around; it is the
model telling you the race state disagrees with what you just claimed.**

### 1.3 Validation

`validateRaceTags(config, tags)` returns `Problem[]` with 18 codes. The ones an
operator will actually hit:

`MISSING_START` · `MISSING_FINISH` · `MISSING_BREAKOUT` · `UNPAIRED_TURN` ·
`TURN_ON_LAST_LENGTH` · `FINISH_BEFORE_LAST_LENGTH` · `STROKE_BEFORE_BREAKOUT` ·
`INSUFFICIENT_STROKE_TAGS` · `NON_MONOTONIC_TAGS` · `BREAKOUT_EXCEEDS_15M` ·
`LENGTH_COUNT_MISMATCH` · `FIFTEEN_METRE_UNAVAILABLE` · `IM_LENGTHS_NOT_DIVISIBLE` ·
`SPLIT_DIVERGENCE` · `LENGTHS_UNRESOLVED` · `FLAGS_NOT_ON_FINAL_LENGTH` ·
`FLAGS_AFTER_FINISH` · `KICK_OUTSIDE_UNDERWATER`

Every tag edit — typed, ±1-frame nudged, or dragged on the timeline — commits
through `updateTagTime` (`packages/metrics/src/components/TagTable.tsx`), so all
three paths raise the same problems. Keep it that way; a second commit path is
how `NON_MONOTONIC_TAGS` gets silently bypassed.

### 1.4 One `Stroke` tag = one cycle, always

`RaceConfig.cycleDefinition` is `'same-hand' | 'single-pull'` and is
**display/provenance metadata only — the maths deliberately never reads it.**
Under both conventions one `Stroke` tag equals one cycle: free/back tag a
same-hand entry, fly/breast tag one simultaneous-arm pull. **No divisor belongs
in any calculation.** If a future rate metric introduces one, that is a bug.

### 1.5 Provenance

Today: `type Provenance = 'tagged' | 'entered' | 'derived' | 'official'`.

E2 adds `'detected'`. The rules in `SUITE_ROADMAP.md` §E2 are binding and are
repeated here because this is the document the E1/E2 session will read:

1. `'detected'` renders visually distinct **everywhere**, including exports.
2. Detections are **proposals**; promotion to `'tagged'` is explicit and recorded.
3. Detection **never** overwrites a human tag.
4. A low-confidence detection is **absent**, not a guess.
5. Detected landmarks carry model version and confidence.

---

## 2. Operator protocol

This is the part that has never been exercised. Follow it literally the first
time, and record where it fights you — that friction is the finding.

### 2.1 Before tagging

1. **Check the frame rate, and know what it actually is.** This was written as
   "measure the true fps" — that overstated the code. What
   `packages/metrics/src/lib/videoMeta.ts` really does, verified by running it:

   - It samples **10 frame callbacks** via `requestVideoFrameCallback` on a
     hidden element driven by muted autoplay, then computes
     `Math.round((frames - 1) / span)`.
   - **The result is rounded to an integer.** A 59.94 fps clip reports `60`,
     29.97 reports `30`. `formatMeta` prefixes it `~` for this reason.
   - It runs **once, when the video is opened**, behind a 2-second timeout.
     If autoplay is blocked or decoding is slow, it resolves with **no fps**.
   - Playing the visible video afterwards does **not** retry the measurement.

   **When fps is absent the frame-step buttons are disabled**, and the only
   fallback is a dropdown of assumed rates (24 / 25 / 30 / 50) reading
   "Not measured — select". Choosing from it is exactly the assumption this
   document warns against, so if you must, record in the ground-truth file
   that `measuredFps` was operator-selected rather than measured.

   **Why the rounding matters for §4.1.** At a true 59.94 recorded as 60, tag
   times drift ~0.001 s per second — about **1.2 frames over a 20-second
   swim**, against a ±2 frame tolerance. For any clip longer than a 50, record
   the container's true rate (`ffprobe -show_streams` gives the exact
   fraction) alongside the app's estimate, and diff them before trusting a
   timing comparison.
2. **Configure the race first** — course, distance, `strokePerLength`. The
   Metrics wizard now gates Tag and Review behind a confirmed setup for exactly
   this reason: tagging against the wrong length count produces
   `LENGTH_COUNT_MISMATCH` at the end, after all the work.
3. **Decide `fifteenMetreReferenceConfirmed` honestly.** If you cannot see the
   15 m mark in frame, it is `false`, and 15 m metrics come back absent. An
   unconfirmed reference that is asserted as confirmed is fabricated data.

### 2.2 Tagging order

Work forward through the video, never backward. Per length:

```
length 1:  Signal → S(Start) → S(Entry) → [A(15m)] → S(Breakout) → S(Stroke)×n → D(TurnStart) → D(TurnEnd)
length k:  S(Breakout) → S(Stroke)×n → D(TurnStart) → D(TurnEnd)
last:      S(Breakout) → S(Stroke)×n → [Flags] → D(Finish)
```

`Kick` tags go in during the underwater phase, before `Breakout`
(`KICK_OUTSIDE_UNDERWATER` guards this).

### 2.3 Correcting a tag

Three equivalent paths, all through the same validation:

- Retype the time in `TagTable`.
- ±1 frame nudge in `TagTable`.
- Drag the tag on the timeline (snaps to frame; `Escape` cancels).

**Never fix a mis-tag by deleting and re-adding at the end of the list.** That
reorders tags and is exactly what `NON_MONOTONIC_TAGS` exists to catch.

### 2.4 Finishing

A race is **done** when `validateRaceTags` returns zero `error`-severity
problems. Warnings may legitimately remain (e.g.
`FIFTEEN_METRE_UNAVAILABLE` on footage without the mark in frame) — record
which, and why, in the ground-truth file's `notes`.

---

## 3. Ground truth — the missing asset

There is currently **no footage with known landmark times**
(`SUITE_ROADMAP.md` §4). Until that exists, no detector can be evaluated, only
admired. This is the highest-value artefact this framework produces.

### 3.1 What counts as ground truth

A ground-truth record is a **human-tagged race that two independent operators
agree on**, not simply a tagged race. One operator's tags are a sample; two
agreeing operators are evidence. Where a single operator is the only option,
tag the same clip **twice, at least a day apart**, and treat the two passes as
the two operators — this measures your own repeatability, which is the floor on
any accuracy claim you can make.

### 3.2 Format

Store alongside the manifest, committed (it contains no footage):

```
data/training/ground-truth/<clip-id>.json
```

```jsonc
{
  "clipId": "jordan-crooks-17.93-50-free",
  "sha256": "<must match data/training/checksums.txt>",
  "measuredFps": 59.94,          // as measured, never assumed
  "config": {
    "course": "SCY",
    "raceDistance": 50,
    "strokePerLength": ["free"],
    "cycleDefinition": "same-hand",
    "fifteenMetreReferenceConfirmed": false,
    "isRelayLeg": false
  },
  "passes": [
    { "operator": "nv", "taggedAt": "2026-08-05", "tags": [ { "kind": "Start", "time": 0.000 } ] }
  ],
  "consensus": [ { "kind": "Start", "time": 0.000 } ],
  "openProblems": ["FIFTEEN_METRE_UNAVAILABLE"],
  "notes": "15 m mark not visible in frame; reference deliberately unconfirmed."
}
```

Rules:

- `sha256` ties the truth to an exact file. A re-encode is a different clip.
- **`measuredFps` records where the number came from**, because the app may
  not have measured it at all (§2.1 step 1). Write it as an object, never a
  bare number:
  ```jsonc
  "measuredFps": {
    "value": 60,
    "source": "app-measured",   // "app-measured" | "operator-selected" | "container"
    "containerRate": "60000/1001" // the true fraction from ffprobe, when known
  }
  ```
  `app-measured` values are rounded integers; a clip whose container says
  `60000/1001` is really 59.94, and the difference is ~1.2 frames over 20 s
  against a ±2 frame tolerance.
- `passes` keeps every operator pass. **Never overwrite a pass** — disagreement
  between passes is data, not noise.
- `consensus` is only written where passes agree within tolerance (§4.1). Where
  they do not, the landmark is **absent from consensus** — it is not averaged.
  Averaging two disagreeing humans manufactures a number neither of them saw.
- `openProblems` records validator warnings deliberately accepted.

### 3.3 Dataset targets

The current dataset is one 50 free. It cannot exercise turns at all. Before E1
is worth measuring:

| Need | Why | Minimum |
| ---- | --- | ------- |
| A race with turns | `UNPAIRED_TURN`, cross-wall segmentation, per-length breakout | 1 × 100, 1 × 200 |
| Each stroke | Breakout and cycle definition differ per stroke | 1 clip per stroke |
| An IM | `IM_LENGTHS_NOT_DIVISIBLE`, stroke-order proposal | 1 × 200 IM |
| A relay leg | `isRelayLeg`, rolling start | 1 |
| Fixed-camera footage | See §5 | majority |

That is ~7 clips to a first honest evaluation — not hundreds. Hundreds are for
E3 fine-tuning; **evaluation needs far fewer clips than training.**

---

## 4. Acceptance thresholds — agree these before building

Set now, while there is no model whose output could influence them.

### 4.1 Tolerance

A detected landmark **matches** ground truth when it is within **±2 frames** of
the consensus time, at the clip's measured fps. Two frames at 60 fps is ~33 ms.

Rationale: this is roughly the width of human tagging disagreement on a clear
side-on view, so a tighter threshold would measure operator noise rather than
model error. **Once real inter-operator spread is measured (§3.1), replace this
number with the measured value and record the change here.** Until then it is a
stated assumption, not a finding.

### 4.2 Per-landmark metrics

Report per landmark kind, never as a single blended score — `Finish` and
`Stroke` are not equally hard, and a blended number hides which one failed:

- **Detection rate** — fraction of ground-truth landmarks matched.
- **False-positive rate** — detections matching no ground-truth landmark.
- **Timing error** — signed median and IQR in frames. Signed, because a
  systematic bias (always 2 frames late) is fixable and random scatter is not.

### 4.3 The bar for `'detected'` reaching a coach

A landmark kind is only eligible to surface as a proposal when, on held-out
clips: detection rate ≥ 0.9, false-positive rate ≤ 0.05, and median absolute
timing error ≤ 2 frames.

Kinds below the bar emit **absent**, not a low-confidence guess
(`SUITE_ROADMAP.md` §E2 rule 4).

### 4.4 Held-out means held-out

Clips used to tune anything are never used to report accuracy. With ~7 clips
this is uncomfortable; report on a leave-one-clip-out basis and **say so**
rather than quietly evaluating on tuning data.

---

## 5. Footage guidance

From `SUITE_ROADMAP.md` §7, and worth restating because it is counter-intuitive:

> Broadcast footage pans, cuts and zooms, which is much harder for a pose model
> than a fixed side-on camera. Ordinary meet footage from a tripod is probably
> more useful for training than clean broadcast video of elite swims, and easier
> to obtain rights to.

Prefer: fixed camera, side-on, whole length in frame, consistent lighting.
Record camera position and whether the view is fixed in the manifest entry —
it will be the first thing that explains an accuracy difference between clips.

**Footage is never committed.** `data/training/` is gitignored except
`MANIFEST.md` and `checksums.txt`. Ground-truth JSON *is* committed: it contains
times, not frames. See `MANIFEST.md` for why.

---

## 6. What the E1 session should do, in order

1. **Tag one real race end to end by hand** — the 50 free already in the
   dataset. Do not build anything first. Record every point of friction.
2. **Fix what that surfaces.** The video suite has never been exercised on real
   footage; assume it will surface something.
3. **Acquire and tag a 100 and a 200** so turns are covered at all.
4. **Second-pass the clips** (§3.1) and write the ground-truth files.
5. **Measure real inter-operator spread** and replace the ±2 frame assumption in
   §4.1 with the measured value.
6. **Only now** stand up `scripts/analyze_video.py` behind the existing Python
   sidecar (`apps/shell/server.ts` already spawns one — see `SUITE_ROADMAP.md`
   §0), and measure it against §4.2 before designing anything on top.

Steps 1–5 need no ML at all, and steps 1–2 are worth doing even if detection is
never built: they are the first real validation the video suite has ever had.

---

## 6.5 Readiness — what was exercised live, 2026-08-06

The tagging path was driven end to end in the running app before this
document was called ready. A synthetic 2.4 s clip was generated in-page and
dropped on the Metrics screen (the real training clip was not used: the dev
server does not serve `data/training/`, and copying copyrighted footage into
a served directory to test a UI is not a trade worth making).

**Confirmed working:**

| Step | Result |
| ---- | ------ |
| Drop a video on the Metrics pane | Loads, `readyState 4`, duration read correctly |
| Wizard gating | Tag and Review stay `aria-disabled` until setup is confirmed |
| `Start Tagging` | Advances to Tag, both later steps unlock |
| Sequential + one-shot keys | All of `S` `D` `A` `R` `G` `K` recorded — 9 presses produced 9 timeline markers |
| Live validation | Moved from "start tag is required" to "turn start and turn end tags are not paired · L1" and "flags tag must occur before finish · L2" as tags landed |
| Keyboard seek | Focusing a marker and activating it seeks the video (0 → 2.200 s) |
| Frame stepping | Enabled as soon as an fps is available |
| Console | No errors at any point |

**Confirmed as gaps, not blockers:**

- **fps was not measured on this clip** and had to be selected manually. See
  §2.1 step 1. This is the single most likely thing to bite a real session.
- `data/training/checksums.txt` had CRLF endings, so the `sha256sum -c`
  command in `MANIFEST.md` failed to find the file it had just listed. Fixed,
  and pinned to LF in `.gitattributes`. The archived clip verifies clean.
- Tag rows render as a grid rather than a table; validation is visible only
  on the **Tag** step, so a retime performed from Review commits without the
  operator seeing the resulting problem list.

**Not yet exercised, and worth doing first thing in the E1 session:** a real
clip end to end. Everything above used a 2.4 s synthetic single-length video,
which cannot exercise turns, `UNPAIRED_TURN` across a real wall, or fps
measurement on true broadcast/tripod footage.

---

## 7. Open questions for the E1 session

1. Who is the second operator for consensus tagging? If nobody, the two-pass
   self-consistency route (§3.1) is the fallback and its weaker claim should be
   stated wherever accuracy is reported.
2. Is there a rights-clear source for fixed-camera footage of your own meets?
   That would beat broadcast clips on both usefulness and licensing.
3. Should ground-truth files carry the operator's confidence per landmark? It
   would let §4.1 weight disagreement, but adds work to every tag. Recommend
   **no** for the first pass — get seven clips done first.
