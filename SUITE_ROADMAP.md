# Omni Swim Suite — Roadmap

**Status:** plan authored 2026-08-03, after a verification pass against the tree at `9220316d`. No implementation started.
**Base:** `main` @ `9220316d` (video analysis suite + roster catalog + db fixes, all merged and green).

**Scope decisions already made (user, 2026-08-03):**

| # | Decision |
| - | -------- |
| 1 | Detection runs **locally**. No cloud video analysis. The "all analysis is performed entirely locally on your device" claim stays true and is a constraint, not a slogan. |
| 2 | YOLO is acceptable as a specialised local package we run and tune. |
| 3 | Auto-detected landmarks get a **new `'detected'` provenance** and render visually distinct from human-tagged data. |
| 4 | All five workstreams are in scope. This document sequences them. |

---

## 0. What the verification pass changed

Checked against the tree rather than assumed. Four assumptions were wrong or incomplete, each of which would have cost a round trip:

| # | Assumption | Verified reality | Consequence |
| - | ---------- | ---------------- | ----------- |
| 1 | Local model inference needs new infrastructure | `apps/shell/server.ts` **already spawns a Python sidecar** — `spawn(pythonCmd, [scriptPath, ...])`, preferring a project `venv/` and falling back to system `python`. `scripts/extract-cutlines.py` and `fetch-cutlines.py` already use it. | YOLO is a new script in an existing pattern, not a new architecture. |
| 2 | Video would have to be uploaded somewhere to analyse | `/api/analyze-video` already exists with `multer` **disk storage**. Video reaches the local server process and lands on local disk. | The full pipeline (browser → local disk → Python → back) is local. Workstream E needs no new transport. |
| 3 | Frame-accurate timing needs work | `packages/metrics/src/lib/videoMeta.ts` already measures true fps via `requestVideoFrameCallback`. | Detected frame indices convert to tag times with existing code. |
| 4 | "Clean up the UI" is a styling task | Manager is **10,405 lines** of components (largest single file 1,314), Matrix **4,068**. | This is an information-architecture problem, not a restyle. It needs a layout decision from the user before any code moves. |

Also worth stating plainly: there is **no ML dependency in the repo today**. Workstream E is greenfield.

---

## 1. Workstreams

### A. Meet as base data, then modifiable

**Mostly already built — the gap is UX, not the data model.**

`CHILD_TABLES` already carries both `source_meet_results` (the frozen parse) and `meet_results` (the working copy), and `PgWorkspaceService` writes `sourceMenResults ?? menResults`. Manager already renders *"Baseline scores stay frozen while you edit the working roster."*

What is actually missing:

1. The frozen-vs-working distinction is invisible until you go looking for it. There is no persistent indicator of *"you are editing a modified copy; N changes from the loaded meet."*
2. No per-change revert. It is all-or-nothing.
3. No diff view of working vs baseline. `ScenarioSnapshotsPanel` (502 lines) does something adjacent and should be examined for reuse before anything new is written.

**Do not rebuild the persistence layer for this.** It exists and is verified by `test_persistence_parity.mjs`.

### B. Roster management + semi-live scoring + easier add-athlete

**Semi-live scoring is mostly wiring.** `useWorkspaceScoring` already runs scoring in a Web Worker (`scoringWorker.ts`), already exposes `scoringSettled`, and already accepts an optional `rosterCatalog`. The pieces for live recalculation are present; what is missing is a UI that updates against them continuously and a debounce so a keystroke does not queue a full rescore.

**Easier add-athlete** is the concrete complaint. Today the paths are `RecruitForm` (343 lines), `RosterImportWizard` (462), `AthleteHistoryImportPanel` (733), `RosterCatalogPanel` (582) and `TeamRosterPanel` (889) — five different ways in, which is itself the problem. The work is consolidating to one obvious path with the others as advanced options, not adding a sixth.

### C. De-clutter Matrix and Manager

The highest user-visible payoff and the lowest technical risk. Also the workstream that most needs **your input before code**, because "less cluttered" is a judgement about what matters, and I should not be guessing which panels you actually use.

Proposed method:
1. Inventory every panel currently reachable on each screen, with its line count and what it answers.
2. Bring you that inventory and ask which are daily, which are occasional, which are dead.
3. Propose a layout — daily items primary, occasional behind disclosure, dead removed.
4. Only then move code.

`AthleteLineupEditorPanel` (1,314 lines) and `CrossCourseArbitragePanel` (1,064) are the two biggest single contributors and the obvious first candidates for splitting.

### D. Drag and drop in video analysis

Smallest, most self-contained, near-zero risk. Two distinct features:

1. **Drop a video file** onto the Metrics screen instead of using the file picker. Pure UI; the existing open-video path is reused verbatim.
2. **Drag a tag on the timeline** to nudge its time. This one touches correctness — it must go through the same validation as a typed edit, so an out-of-sequence drag raises `NON_MONOTONIC_TAGS` rather than silently reordering. `TagTable.tsx` already implements ±1 frame nudge and retype; dragging should call the same path, not a parallel one.

### E. Local automatic detection

The largest workstream and the only one with genuine unknowns. Split into three phases that ship independently.

#### E1 — Pose extraction (local)

- New `scripts/analyze_video.py` invoked through the **existing** sidecar pattern.
- `ultralytics` YOLO pose model + OpenCV for frame reads. Both pip-installable into the existing `venv/`.
- Input: video path already on local disk from `multer`. Output: per-frame keypoints as JSON.
- `/api/analyze-video` stops returning 501 and returns keypoints.

**Honest expectations.** Off-the-shelf YOLO pose models are trained on land-based humans. Swimming footage breaks their assumptions — partial submersion, splash occlusion, unusual body orientation, water refraction. Expect materially worse accuracy than the published benchmarks until it is fine-tuned. A 200-length race at 60 fps is roughly 7,000 frames; on CPU that is minutes, not seconds. GPU changes that substantially. This phase should be measured before anything is built on top of it.

#### E2 — Landmark proposal + `'detected'` provenance

Turn keypoints into *proposed tags* — breakout, stroke, turn — and feed them through the **existing state machine** so a detection is validated exactly like a human keystroke.

This is the phase that touches the correctness core, so it carries the strictest rules:

```ts
type Provenance = 'tagged' | 'entered' | 'derived' | 'official' | 'detected';
```

1. A `'detected'` value renders visually distinct everywhere it appears, including exports. A coach must never be unable to tell a model guess from a human tag.
2. Detections are **proposals**. The operator promotes one to `'tagged'` by confirming it. Promotion is explicit and recorded.
3. Detection **never** overwrites an existing human tag.
4. A low-confidence detection is `absent`, not a guess. The no-fabrication rule from the video masterplan §3 applies unchanged — this is the rule the whole engine exists to enforce, and an ML feature is exactly where it would erode.
5. Detected landmarks carry the model version and confidence, stored with the analysis, so a later model change is traceable.

#### E3 — Stroke detection and fine-tuning

- Per-length stroke classification from the pose sequence, proposing the `strokePerLength` array the engine already requires as config.
- Fine-tuning YOLO on swimming footage.

**This is a data project before it is a modelling project.** It needs labelled footage — hundreds of clips with frame-level landmarks — plus a training loop and a held-out accuracy bar agreed before anyone trusts the output.

**The strongest argument for doing A–D first:** every race you tag by hand in the improved UI is a labelled example. Workstreams A–D generate the training set E3 needs. Starting E3 now means hand-labelling from scratch; starting it after means the data already exists.

---

## 2. Sequencing

```
  C  de-clutter Matrix + Manager      ← needs a layout decision from you first
  |
  B  roster + semi-live scoring       ← lands inside C's new layout
  |
  A  baseline/working polish          ← small; data model already done
  |
  D  drag and drop                    ← independent, can slot in anywhere
  |
  E1 pose extraction (measure first)
  |
  E2 'detected' provenance
  |
  E3 stroke detection + fine-tune     ← gated on tagged races from A–D
```

C before B because B's UI lands inside the layout C establishes; doing B first means redoing it. D is independent and can be pulled forward as a quick win. E1 should be measured on real footage before E2 is designed around it.

---

## 3. Rules carried forward

From `VIDEO_ANALYSIS_MASTERPLAN.md`, still binding:

1. **Absent ≠ 0.** No `?? 0`, no `|| 0`, no default constant on any race value. This survived a full audit; ML output must not reintroduce it.
2. **No interpolation, extrapolation, projection, or estimation** presented as measurement. A detected landmark is a proposal with provenance, which is not the same thing.
3. **Units are typed.** SCY is yards.
4. **Reference bands live in one file** with URL, retrieval date and verbatim quote.
5. **The parity guard stays green.** `test_persistence_parity.mjs` catches child-table and column drift across SQLite and Postgres; it already caught a silent data-loss bug during the three-way merge.

---

## 4. Answers (user, 2026-08-03) and what they change

| Q | Answer | Consequence |
| - | ------ | ----------- |
| Which panels are used? | **All of them.** The problem is that "the flow and viewing is confusing to the uninitiated." | Workstream C is **not** a deletion exercise. Every panel stays; ordering, grouping and labelling change. This is a materially different job from the one first scoped. |
| GPU? | Build machine has one. **Other users will not.** | Detection cannot be assumed interactive. See §5. |
| Footage with known landmark times? | **No.** | There is no ground truth. E1 accuracy cannot currently be measured, only eyeballed. |
| Races tagged so far? | **None.** | E3 has no training data, and the video suite has never been exercised end-to-end on real footage. |

### 4.1 The sequencing consequence

Zero tagged races is the single most important fact here. It means:

1. **E3 is not startable.** No labels, no eval set, no accuracy bar.
2. **E1 cannot be validated.** Detected landmarks could only be compared against nothing.
3. The video suite is built, green and **unproven**. Tests pass against synthetic fixtures; no real race has gone through it.

Everything therefore converges on the same first move: **make tagging pleasant enough that races actually get tagged.** Every tagged race is simultaneously a product outcome, a validation case for E1, and a training example for E3. C and D are not merely "nice UI work before the interesting part" — they are what generates the dataset the interesting part requires.

**Recommended first milestone:** tag one real race end to end, by hand, before any further building. It will surface usability and correctness problems no synthetic fixture can.

---

## 5. Detection on machines without a GPU

The constraint is that the machine doing the building has a GPU and the machines doing the coaching do not. The resolution is already in the data model.

**Detections persist.** `race_analyses` is a workspace child table on both engines, and a workspace round-trips whole through `PUT /api/workspaces/:id`. So inference is a **produce-once, read-many** operation:

1. Detection runs on a capable machine, once, per race.
2. Detected landmarks are stored in the analysis with model version and confidence.
3. Every other user opens the workspace and sees the detections **without running inference at all**.

That reframes the GPU problem from "everyone needs a GPU" to "one person does, and only when creating an analysis." Consequences for E1:

- Detection is **opt-in and explicitly invoked**, never automatic on video open.
- It is a **batch job with a progress indicator and a cancel**, never a blocking call.
- The UI states an expected duration before starting, derived from frame count and a measured per-frame rate.
- A machine without a GPU is not blocked — it is slow, and told so honestly up front.
- Manual tagging remains fully functional and is never gated behind detection.

---

## 6. Measured UI findings

Taken from the running app at `9220316d`, not from reading source. These are facts, not opinions, and they give workstream C something objective to move against.

| Screen | Buttons on screen at once | Icon-only (hover-tooltip only) | No accessible name at all | `<select>` |
| ------ | ------------------------- | ------------------------------ | ------------------------- | ---------- |
| Manager | **27** | 6 | 2 | — |
| Matrix | **22** | 6 | 2 | 3 |

**The single clearest defect is reading order on Matrix.** In DOM order a new user meets:

```
… WORKSPACES · SNAPSHOTS
  MEET CHARTS / TABLES
  CUSTOM SCORING LOGIC
  CHRONOLOGICAL TEAM SCORE TIMELINE     ← analysis output
  MEET MOMENTUM VS PRELIMS              ← analysis output
  PERFORMANCE MATRIX: OVERALL STANDING  ← analysis output
  LOAD PDF · LINK PSYCH · STANDINGS     ← the thing you must do FIRST
```

The output of the workflow is presented before its input. Someone who already knows the tool reads past it; someone who does not has no idea where to begin. This is exactly "confusing to the uninitiated," and it is fixable by reordering rather than removing.

**What is already good and should be preserved:** Manager's four-step wizard (`1. Source → 2. Lineup → 3. Relays → 4. Optimize`, each with a plain-language subtitle like "Bring in swimmers") is well-formed. The scaffolding is sound; the density around it is the problem.

### 6.1 Workstream C, restated

Since every panel stays:

- **C1 — Task order.** Reorder each screen so inputs precede outputs. Load → configure → read results.
- **C2 — Progressive disclosure.** Reduce 22–27 simultaneous controls to a small primary set plus grouped menus. Nothing becomes unreachable; things stop competing.
- **C3 — Name every control.** 6 icon-only buttons per screen rely on hover tooltips, and 2 per screen have no accessible name at all. Cheap to fix, disproportionately helpful to a newcomer, and required for screen readers.
- **C4 — First-run guidance.** An empty state that names the next action, extending the pattern Metrics already uses ("Upload a race video to begin").

---

## 7. Open questions

1. Should the four-step wizard pattern from Manager be extended to Matrix, or should Matrix stay a single dense dashboard with better ordering? This is a real fork and I would rather you choose than guess.
2. Who are the "uninitiated" — assistant coaches, athletes, other programmes? Which of them need to self-serve without you present determines how much hand-holding C4 needs.
