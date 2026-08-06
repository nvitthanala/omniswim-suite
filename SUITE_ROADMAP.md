# Omni Swim Suite — Roadmap

**Status:** plan authored 2026-08-03. **Workstreams A, B, C and D are complete** and
merged to `main` as `ca753548` (PR #4, CI green). Only workstream E remains. See
§0.1 for what shipped.
**Base:** `main` @ `9220316d` (video analysis suite + roster catalog + db fixes, all merged and green).

---

## 0.1 Delivered — A/B/C/D, merged 2026-08-06

28 commits, 47 files. CI: **44 passed, 0 failed, 2 skipped** (was 39 before).

| Workstream | State | What landed |
| ---------- | ----- | ----------- |
| **C** — de-clutter | done | `WizardShell` extracted to `@omniswim/ui`; Manager, Matrix and Metrics all consume it. Matrix restructured Load → Score → Standings → Analyze, so its analysis output can no longer precede the input that produces it. ARIA tabs implemented once in the shared shell. Controls on screen: Matrix 22 → 17; zero unnamed buttons on either screen. First-run guidance on every Manager step. |
| **B** — roster + semi-live scoring | done | 200 ms debounce on recomputes **without** debouncing `scoringSettled`, so the scenario Save gate still refuses a stale total. Add-athlete consolidated from five competing entry points to one chooser. |
| **A** — baseline/working | done | "Modified copy · N changes" badge; baseline-vs-working diff panel backed by a new `thenMode: 'baseline'` in `computeScenarioDiff` that mirrors the engine's baseline bundle exactly; per-change revert for recruits and soft removals. |
| **D** — drag and drop | done | Drop a video onto Metrics; drag a timeline tag to retime it, committing through the same `updateTagTime` path as a typed edit so `NON_MONOTONIC_TAGS` still fires. |

Also delivered, outside the original five workstreams:

- **Component splits**, both behind tests: `AthleteLineupEditorPanel` 1,314 → 635
  (into `AthleteEntriesSection` / `AthleteHistorySection` / `DrawerSection`) and
  `CrossCourseArbitragePanel` 1,064 → 908.
- **New test coverage**: an athlete-drawer characterization test written *before*
  the split and passing unchanged after it; a scoring-debounce regression guard;
  the working-copy counter; the arbitrage view helpers.
- **`VIDEO_TAGGING_FRAMEWORK.md`** — the tagging model, operator protocol,
  ground-truth format and acceptance thresholds for E1, set before any detector
  exists.
- **`data/rosters/NSISC_2026-27_ROSTER_FRAMEWORK.txt`** — fill-in template for
  Delta State and Ouachita Baptist.

**An independent two-provider review before merge caught three regressions
introduced by this work**, all fixed: timeline tags lost keyboard operation; the
new first-run guidance blocked recruit-driven planning (the primary HSU
workflow); and a new copy-meet-from-workspace feature could blank a loaded meet
and its frozen source copy with no confirmation and no undo.

**Known follow-up:** `BaselineDiffPanel` does not receive `rosterCatalog`, so with
catalog scoring enabled its absolute totals diverge from the scoreboard. The delta
stays correct. Threading it through core, the worker and three UI layers is a
separate change.

### 0.2 What §4.1 said, and where it now stands

§4.1 argued everything converged on one first move: make tagging pleasant enough
that races actually get tagged, because zero tagged races blocks E1 and E3. A–D
are the work that was supposed to enable that, and they are done. The tagging path
has since been driven end to end in the running app — see
`VIDEO_TAGGING_FRAMEWORK.md` §6.5 for exactly what was confirmed and what was not.

**Still true: no real race has been tagged.** That remains the gate on E1, and it
is now the next action rather than a dependency.

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
  C  de-clutter Matrix + Manager      ✅ done (merged ca753548)
  |
  B  roster + semi-live scoring       ✅ done
  |
  A  baseline/working polish          ✅ done
  |
  D  drag and drop                    ✅ done
  |
  ── tag one real race by hand ──     ← NEXT. Gates everything below.
  |
  E1 pose extraction (measure first)
  |
  E2 'detected' provenance
  |
  E3 stroke detection + fine-tune     ← gated on tagged races
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

## 7. Training data

First clip received 2026-08-03: Jordan Crooks, 17.93, 50 free (SCY).

**Video files are not committed.** `data/training/` is gitignored except for
`MANIFEST.md` and `checksums.txt`. This repository is public, and race footage is
generally third-party copyrighted material showing identifiable athletes;
committing it would republish it, permanently and beyond recall on a public host.
The manifest records identity, provenance and SHA-256 for every clip, so the
dataset stays reproducible and auditable without redistribution. Collaborators
obtain files separately and verify with `sha256sum -c`.

**The first clip is a good start and an insufficient dataset.** A 50 free is one
length: start, breakout, strokes, finish, and **no turn**. It cannot validate
turn detection, cross-wall segmentation, or the `UNPAIRED_TURN` path that Fixture
C guards. Gaps are tracked in the manifest; the largest are turns, non-freestyle
strokes, and — still — any clip at all with tagged landmark ground truth.

**Likely counter-intuitive finding for later:** broadcast footage pans, cuts and
zooms, which is much harder for a pose model than a fixed side-on camera.
Ordinary meet footage from a tripod is probably more useful for training than
clean broadcast video of elite swims, and easier to obtain rights to.

---

## 8. First brief — C1/C3, Matrix as a stepped wizard

**Decision (user, 2026-08-03): Matrix adopts the stepped wizard pattern**, rather
than staying a dense dashboard with corrected ordering.

This is the stronger choice and it fixes the reading-order defect *structurally*
rather than cosmetically: with `Load` as step 1, it becomes impossible to land on
analysis output before the input that produces it. It also makes the two main
screens learn-once — a coach who understands Manager already understands Matrix.

**Proposed Matrix steps** (mirroring Manager's `label` / `title` / `hint` shape):

| # | Label | Title | Holds |
| - | ----- | ----- | ----- |
| 1 | Load | Bring in the meet | `LOAD PDF`, `LINK PSYCH`, meet copy from another workspace, loaded-meet status |
| 2 | Score | Set the scoring rules | `CUSTOM SCORING LOGIC`, Configure Scoring Model, presets, official team scores |
| 3 | Standings | See where teams land | `PERFORMANCE MATRIX`, `TeamCard`, format toggles (Auto / Regular List / Divided 2-Col) |
| 4 | Analyze | Explain the result | Score timeline, momentum vs prelims, `DIFF`, `PRELIMS` tables |

Every panel currently on the screen lands in exactly one step. Nothing is removed.

### 8.1 Extract the shell first

`RosterWizardShell.tsx` (131 lines) is already ~90% generic — layout, tablist,
active/done states, toolbar slot and children are all reusable. Only four things
are roster-specific: the `STEPS` array, the `RosterWizardStepId` type, the
`"Roster workflow"` eyebrow, and `aria-label="Roster steps"`.

**Extract it to `@omniswim/ui` as `WizardShell`** and have both screens consume
it. Duplicating it into Matrix would guarantee the two drift apart, which defeats
the consistency this decision is meant to buy. Manager's file becomes a thin
wrapper passing its own steps — its behaviour must not change.

**Fix the ARIA while extracting.** The current implementation uses
`role="tablist"` and `role="tab"` but has no `aria-controls`, no
`role="tabpanel"` on the content region, and no arrow-key navigation. The ARIA
tabs pattern requires all three. Since this component is about to be used twice,
fixing it once here is much cheaper than twice later.

---

Self-contained brief, in the lift-and-paste style of `VIDEO_ANALYSIS_MASTERPLAN.md` §10.

> **Goal.** Make the Matrix screen legible to someone who has never used it,
> without removing any capability.
>
> **The problem, measured on the running app.** In DOM order a newcomer meets
> `MEET CHARTS / TABLES` → `CUSTOM SCORING LOGIC` → `CHRONOLOGICAL TEAM SCORE
> TIMELINE` → `MEET MOMENTUM VS PRELIMS` → `PERFORMANCE MATRIX` → and only then
> `LOAD PDF` / `LINK PSYCH` / `STANDINGS`. **The output of the workflow is
> presented above its input.** The screen also shows 22 buttons at once, 6 of
> them icon-only with hover-tooltips, and 2 with no accessible name at all.
>
> **Do, in this order:**
>
> 1. **Extract `WizardShell` into `@omniswim/ui`** from
>    `packages/manager/src/components/RosterWizardShell.tsx`. Parameterise the
>    four roster-specific things: `steps` (array of `{id,label,title,hint,icon}`),
>    `eyebrow` (currently `"Roster workflow"`), `ariaLabel`, plus the existing
>    `step` / `onStepChange` / `toolbar` / `children`. Keep the visual result
>    identical.
> 2. **Repoint Manager** at the shared component. Its rendering and behaviour must
>    not change — this is a pure refactor and is how you prove the extraction is
>    faithful.
> 3. **Fix the ARIA in the shared shell**: add `aria-controls` on each tab,
>    `role="tabpanel"` + `aria-labelledby` on the content region, and arrow-key
>    navigation between tabs (Left/Right, Home/End). Both screens then inherit it.
> 4. **Restructure Matrix into the four steps** in the table above — Load, Score,
>    Standings, Analyze. Every existing panel moves into exactly one step. None is
>    removed, none becomes unreachable.
> 5. **Give every control an accessible name.** `title` alone is not enough — add
>    `aria-label`. Two buttons on Matrix currently have neither.
> 6. **Add a first-run empty state** on step 1 naming the next action when no meet
>    is loaded, matching the pattern Metrics already uses ("Upload a race video to
>    begin").
>
> **Do not:**
> - Delete or hide any panel. Every one is in use; this is a structure and
>   disclosure problem, not a surface-area one.
> - Change Manager's appearance or behaviour. Step 2 is a refactor only.
> - Touch `packages/db/**`, `packages/core/src/lib/raceAnalysis/**`, or any test.
> - Add a dependency. `lucide-react` icons and `@omniswim/ui` primitives already
>   cover this work.
>
> **Repo facts — do not rediscover these.**
> - Entry points: `packages/matrix/src/components/OpsModule.tsx` (429 lines) wraps
>   `MeetOperationsView.tsx` (737 lines). `TeamCard.tsx` is 1,084 lines and is the
>   biggest single contributor to the screen.
> - **Charts must stay `ChartShell → ChartFrame → Recharts` with no
>   `ResponsiveContainer`.** The dev server prints this rule on boot. The existing
>   chart components already comply; keep it that way.
> - Tailwind v4: use existing `--ui-*` / `--surface-*` / `--text-*` custom
>   properties. Never introduce an unprefixed global token — this repo has a known
>   token-collision problem.
> - UI primitives that already exist: `ChartShell`, `ChartFrame`, `EmptyState`,
>   `useToast` from `@omniswim/ui`; `useThemeColors` from
>   `@omniswim/core/lib/useThemeColors`.
> - Manager's four-step wizard (`1. Source → 2. Lineup → 3. Relays → 4. Optimize`,
>   each with a plain-language subtitle) is the in-repo precedent for legible
>   flow. Borrow its vocabulary; do not import its components.
>
> **Verify before reporting done.**
> ```
> npm run lint     # clean, all 7 packages
> npm test         # 39 passed, 0 failed, 3 skipped
> npm run build    # exit 0
> ```
> Then run the app (`npm run dev`, port 3000) and confirm:
> - `/matrix` opens on step 1 (Load), not on a chart.
> - All four steps reachable; every panel that existed before is still reachable
>   from exactly one step.
> - `/manager` looks and behaves **exactly** as before the refactor.
> - No console errors on either screen.
> - Tabs are operable by keyboard alone: arrow keys move between them.

---

## 9. Open questions

1. Who are the "uninitiated" — assistant coaches, athletes, other programmes? Which of them need to self-serve without you present determines how much hand-holding the empty states need.
2. Do you want the footage bytes committed via Git LFS instead of kept local? `git-lfs` is installed but not configured here. It fixes repository bloat but **not** the public-redistribution question, so the manifest approach is the current default.
3. Should Metrics eventually adopt the same wizard shell (Setup → Tag → Review)? Not now — but if yes, that argues for getting `WizardShell`'s API right in this first pass rather than shaping it around two consumers and retrofitting a third.
