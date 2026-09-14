# Metrics applet diagnosis — screens, `@omniswim/ui` adoption, Panel+Parts adherence, duplication

**Status: diagnosis only, per Phase 0 of
[`02-UI-REDESIGN-WHOLE-APP.md`](02-UI-REDESIGN-WHOLE-APP.md) §6. Nothing in
this document has been built, and it does not propose any new component API,
prop shape, or visual mockup — that is explicitly deferred to a later
phase.** Every count below was produced by a command re-runnable against this
repo at the commit in place on 2026-09-10; none is an estimate.

Scope: `packages/metrics/src/components/` — 14 `.tsx` files, 2,672 lines
(`find packages/metrics/src/components -name "*.tsx" | xargs wc -l | sort
-rn`, confirmed; the 14 file sizes sum exactly to 2,672, matching the
whole-app doc's own figure). `packages/metrics/src/MetricsApp.tsx` (507
lines, the applet's actual root, outside `components/`) and
`packages/metrics/src/components/raceSetupShared.ts` (7 lines, a shared
constants file, `.ts` not `.tsx`) are read for context but not counted in
the 2,672.

**Coverage note**: like the Matrix pass, all 14 component files were read in
full this session, not sampled — Metrics' smaller size made that possible
within budget, plus the root `MetricsApp.tsx` and the tiny
`raceSetupShared.ts` sibling. No file's structure below is inferred from its
name or a partial read.

## 1. Screen inventory — one 3-step wizard, no session-list "screen," a
   session picker embedded in the last step

`MetricsApp.tsx` (the applet root, not itself in `components/`) is a single
component with no workspace gate (unlike Matrix's `MatrixApp.tsx`) — it
renders unconditionally. It wraps `@omniswim/ui`'s `WizardShell` with a
fixed 3-step model (`METRICS_STEPS`, a real `WizardStep<MetricsStepId>[]`
array with `id`/`label`/`title`/`hint`/`icon`, the same shape as Manager's
`RosterWizardShell` and Matrix's `OpsModule`'s `MATRIX_STEPS`): **Setup →
Tag → Review**. `resolveActiveStep()` (line 67) locks the step to `'setup'`
until `raceSetupComplete` (a video is open **and** the setup form has been
confirmed), and `metricsSteps` (lines 213–218) marks the other two steps
`disabled` until then — a real gate, not just a visual default.

Step content is picked by `MetricsStepContent()` in `MetricsStepPanels.tsx`
(212 lines) — a single `if (activeStep === X)` chain very much like
Matrix's `MeetOperationsView.tsx`, just far smaller and with each step's
content factored into its own exported function in the same file
(`SetupStepPanel`, `TagStepPanel`, `ReviewStepPanel`) rather than one long
inline block. Confirmed directly: `MetricsStepPanels.tsx` exports four
functions — `SetupStepPanel`, `TagStepPanel`, `MetricsStepContent`,
`ReviewStepPanel`.

- **Setup step** (`SetupStepPanel`): if no video is open, renders
  `@omniswim/ui`'s `EmptyState` ("Upload a race video to begin"); once a
  video is open, renders `RaceSetupForm.tsx` (see §3).
- **Tag step** (`TagStepPanel`): a small race-header block (course,
  distance, swimmer name, workspace-best comparison time if any, video
  meta) plus `TagTable.tsx` (151 lines), the editable tag list.
- **Review step** (`ReviewStepPanel`): renders `MetricsDashboard.tsx` (322
  lines, the full metrics readout), then — **only if at least one
  non-legacy saved session exists** — a single `<select>` ("Compare against
  saved session," `MetricsStepPanels.tsx` line 192) that, once a session is
  picked, renders `SessionComparePanel.tsx` (206 lines) below it.

**`SessionsPanel.tsx` (70 lines) confirms the name is literal but the
component is not a screen — it's a collapsible list**, toggled by the
header's "Sessions" button (`MetricsHeader.tsx`), rendered inline between
the header and the main video/wizard area (`MetricsApp.tsx` lines 443–450),
not a step, tab, or modal. It lists saved sessions with Load/Delete actions
per row; loading one jumps straight to a confirmed setup (`setSetupConfirmed(true)`,
`MetricsApp.tsx` line 370) rather than re-entering the Setup step.

**`SessionComparePanel.tsx` confirms the name too — it is a two-column
metric-delta table, not a second dashboard.** It takes `left`/`right`
`ComparisonSide` objects and renders one `MetricTable` per race-level
metric group plus one per matched length index, suppressing (not
computing) any delta where either side is absent, the course differs, the
cycle definition differs, or the units differ (`diffMeasured()`, lines
26–34) — the same "don't fabricate a number" discipline the rest of the
package's `Measured<T>` type enforces.

**Video and tagging is a separate left-hand column, not part of the wizard
steps at all.** `MetricsApp.tsx` renders `VideoStage.tsx` (92 lines)
alongside the wizard, not inside it: `VideoStage` composes `VideoPlayer.tsx`
(317 lines, the actual `<video>` element, transport controls, and keyboard
tagging shortcuts) with `TagDeck.tsx` (94 lines, a floating "next tag"
overlay shown once setup is confirmed) and the drag-and-drop "drop a video
here" overlay. `TagTimeline.tsx` (199 lines) is a further child of
`VideoPlayer`, rendering the draggable tag markers directly on the scrubber.

**A coach's actual path** from "opened Metrics" to "comparing two swims":
`MetricsApp` → drag/drop or "Open Video" → Setup step (`RaceSetupForm`) →
confirm → Tag step (keyboard-driven tagging against `VideoPlayer` +
`TagDeck`, edits also visible/editable in `TagTable`) → Review step
(`MetricsDashboard`) → pick a saved session from the one `<select>` →
`SessionComparePanel` renders below. One wizard, one step-content router,
one collapsible session list — no modal, no drawer, no second independent
entry point to any of it (unlike Matrix's `ScoringSettingsModal`/`Panel`
pair or Manager's four navigation idioms).

## 2. `@omniswim/ui` adoption, by kind — 28.6%, and it needs no downward
   correction

`grep -l "@omniswim/ui" packages/metrics/src/components/*.tsx | wc -l` →
**4 of 14 (28.6%)**. Breaking down what each imports
(`grep -n "^import.*@omniswim/ui"`):

| File | Lines | Imports from `@omniswim/ui` | Kind |
| --- | ---: | --- | --- |
| `RaceSetupFormFields.tsx` | 378 | — | None |
| `MetricsDashboard.tsx` | 322 | `Badge` | Visual primitive |
| `VideoPlayer.tsx` | 317 | — | None |
| `RaceSetupForm.tsx` | 217 | — | None |
| `MetricsStepPanels.tsx` | 212 | `EmptyState` | Visual primitive |
| `SessionComparePanel.tsx` | 206 | — | None |
| `TagTimeline.tsx` | 199 | — | None |
| `TempoProfile.tsx` | 185 | `ChartFrame`, `ChartShell` | Visual primitives |
| `TagTable.tsx` | 151 | — | None |
| `VelocityProfile.tsx` | 135 | `ChartFrame`, `ChartShell` | Visual primitives |
| `TagDeck.tsx` | 94 | — | None |
| `MetricsHeader.tsx` | 94 | — | None |
| `VideoStage.tsx` | 92 | — | None |
| `SessionsPanel.tsx` | 70 | — | None |

**Zero of the 4 are hook-only.** This is the one place Metrics' numbers
genuinely differ in shape from both siblings: Manager's raw 51% collapsed to
a real 23.5% once `useToast`-only files were excluded, and Matrix's 33%
collapsed to 26.7% for the same reason. Metrics' `useToast` call
(`MetricsApp.tsx` line 175, `import { useToast, WizardShell, type
WizardStep } from '@omniswim/ui'`) lives in the 507-line **root** file,
outside the 14-file/2,672-line `components/` directory entirely — confirmed
by `grep -rln "useToast" packages/metrics/src/components/*.tsx`, which
returns **no matches**. So the honest visual-adoption number for
`components/` is the same as the raw one: **4/14 (28.6%)**, no correction
needed — the smallest of the three applets is also the only one whose
adoption figure was not inflated by hook-only imports in the first place.

`Button` is imported by **0 of 14 files**, matching both Manager and
Matrix. `grep -c "<button"` sums to **20** hand-rolled `<button>` elements
across 6 of 14 files (`MetricsHeader.tsx`:4, `RaceSetupFormFields.tsx`:4,
`SessionsPanel.tsx`:3, `TagTable.tsx`:3, `TagTimeline.tsx`:1,
`VideoPlayer.tsx`:5) — far fewer in absolute terms than Manager's 130 or
Matrix's 45, proportionate to the package's much smaller size.
`grep -c "<select"` sums to **9** across 4 files (`MetricsStepPanels.tsx`:1,
`RaceSetupFormFields.tsx`:5, `TagTable.tsx`:1, `VideoPlayer.tsx`:2) — none
of them literal copies of each other (unlike Manager's 6 identical team
selects); `RaceSetupFormFields.tsx`'s 5 are five different fields (course,
distance, single stroke, per-length stroke, cycle definition), and the
package has no team-select concept at all, since Metrics operates on one
swimmer/race at a time, not a roster.

**`VideoPlayer.tsx` and `VideoStage.tsx` (the video-review functionality
flagged for checking) hand-roll their entire control surface** — confirmed
directly: `VideoPlayer.tsx` has zero `@omniswim/ui` imports and builds its
own play/pause/skip buttons, its own drag-to-seek progress bar (`<input
type="range">` overlaid on a styled div, lines 216–239), its own FPS and
playback-speed `<select>` elements (styled with raw Tailwind + inline
`bg-slate-900 text-white` option classes, not theme tokens — lines 262–288),
and its own volume slider. None of this reuses a shared primitive, but it
also has no direct duplicate elsewhere in Metrics or (per the prior two
docs) in Manager or Matrix — this is genuinely new surface area rather than
a repeated pattern, so it reads as a monolith to split (§3) rather than a
duplication to converge (§4).

## 3. Panel+Parts-or-equivalent convention adherence — one real split pair,
   one large router-with-inline-decomposition, one true monolith

**`RaceSetupForm.tsx` (217 lines) + `RaceSetupFormFields.tsx` (378 lines)
is confirmed as a real container+fields split**, not two independent
files that happen to share a topic: `RaceSetupForm.tsx` imports 8 named
exports directly from `RaceSetupFormFields.tsx` (confirmed: line 16 closes
a multi-line `import { ... } from './RaceSetupFormFields';`) —
`SwimmerNameField`, `CourseDistanceFields`, `EventTypeSection`,
`PerLengthStrokeGrid`, `CycleDefinitionField`, `BreakoutDistanceSection`,
`FlagDistanceSection`, `RelayAndReferenceCheckboxes` — and renders them in
sequence inside its own JSX return (`RaceSetupForm.tsx` lines 167–211),
while `RaceSetupForm.tsx` itself owns all the state and handlers
(`eventType`, `imProposal`, `flagDistanceConfirmed`, and the dozen `handle*`
callbacks). A third, smaller sibling exists too: `raceSetupShared.ts` (7
lines, not `.tsx` so not counted in the 2,672) holds `INPUT_CLASS`,
`SELECT_CLASS`, `STROKE_LABEL`, `STROKES` — shared constants both files
import. This is a genuine three-way split (container / fields / shared
constants), just under different names (`Form`/`FormFields`/no suffix)
than Manager's `X`/`XParts` or Matrix's `matrixPresentation.tsx`.

**`MetricsStepPanels.tsx` (212 lines) is a router file with its step
content inlined as sibling exported functions in the same file**, similar
in spirit to Matrix's one-file, `if`-chain `MeetOperationsView.tsx` but at
roughly a quarter the size and with cleaner boundaries — `SetupStepPanel`,
`TagStepPanel`, and `ReviewStepPanel` are three separate top-level exported
functions, not `if` blocks inside one function body. This sits between
"true monolith" and "formal Parts split": it is decomposed, just not into
separate files.

**`TagTimeline.tsx` doubles as a shared constants module**, the same
pattern Matrix's dedicated `matrixPresentation.tsx` file performs
explicitly: `ALL_TAG_KINDS`, `TAG_KIND_COLOR`, and `TAG_KIND_LABEL` are
defined once in `TagTimeline.tsx` (lines 5–45) and imported by both
`TagTable.tsx` (`import { ALL_TAG_KINDS, TAG_KIND_COLOR, TAG_KIND_LABEL }
from './TagTimeline'`) and `TagDeck.tsx` (identical import) — confirmed
directly. Unlike Matrix, this shared data lives inside one of the consuming
components' own files rather than a neutral shared file, but it is real,
working reuse, not three independent copies of the same color/label maps.

**Applying Manager's own revealed-practice threshold** (files 260+ lines
with no UI-decomposition sibling of any kind): **only 3 of Metrics' 14
files clear 260 lines**, versus 8/15 for Matrix and 8/51 (of the largest 15)
for Manager:

| File | Lines | Existing split? |
| --- | ---: | --- |
| `RaceSetupFormFields.tsx` | 378 | **This is the split output itself** — the `Parts`-equivalent sibling of `RaceSetupForm.tsx` (§ above); its size is the natural consequence of holding 8 extracted field components, not an unmanaged monolith |
| `MetricsDashboard.tsx` | 322 | None as a sibling file, but internally decomposed into 9 private helper components in-file (`MeasuredValue`, `StatCard`, `BandNote`, `Section`, `LengthMetricsTable`, `severityTone`, `ProblemsPanel`, plus the column definitions) — the same "TeamCard-style" in-file split Matrix's doc catalogued, just at a fifth of the scale (9 helpers in 322 lines vs. 16 in 1,351) |
| `VideoPlayer.tsx` | 317 | **None at all** — no sibling split, no in-file helper decomposition either; one ~260-line function body (lines 52–317) with all playback-control JSX inline. This is the one file in Metrics that most resembles Manager's/Matrix's flagged monoliths, at a much smaller absolute size |

So Metrics' answer to "a component got too big" is real but partial: it has
one clean formal split (`RaceSetupForm`/`Fields`/shared-constants), one
file that self-decomposes in-place (`MetricsDashboard.tsx`, the same
strategy Matrix's `TeamCard.tsx` uses just far more modestly), and exactly
one genuine monolith (`VideoPlayer.tsx`) — proportionally a much smaller
problem surface than either sibling applet, consistent with Metrics being
a fifth of Matrix's line count and a twentieth of Manager's.

## 4. Duplicated or near-duplicated UI patterns

### 4a. One hand-rolled two-state toggle, not six

`RaceSetupFormFields.tsx`'s `EventTypeSection` (lines 117–131) renders a
"Single Stroke"/"IM" choice as two `<button>` elements in a `grid
grid-cols-2 gap-2` row, each conditionally styled
(`border-[var(--text-accent)] text-[var(--text-accent)]` when active,
`border-theme-soft text-theme-muted` when not) — the exact shape
`@omniswim/ui`'s `SegmentedControl` already standardizes (per Manager's
doc, correctly adopted in `RosterLineupStep.tsx`) and the exact shape
Matrix's doc found hand-rolled 6 times across 4 files. Metrics has
**exactly one** such instance, in one file — the smallest occurrence of
this specific pattern found across all three diagnosis passes.

Two other `grid grid-cols-2 gap-2` blocks in the same file
(`PerLengthStrokeGrid`, line 216; `BreakoutDistanceSection`, line 266) are
**not** instances of this pattern — they are two-column grids of per-length
form fields (a `<select>` per length, an `<input>` per length), not a
binary choice toggle, confirmed by reading each in full.

### 4b. Badge: correctly adopted once, one soft near-duplicate elsewhere

`MetricsDashboard.tsx` imports and uses `Badge` from `@omniswim/ui`
correctly in two places: the "≈" approximate-value marker
(`<Badge tone="neutral" title={APPROX_CAVEAT}>{'≈'}</Badge>`, line 39) and
the per-problem severity chip (`<Badge tone={severityTone(severity)}>
{problem.code}</Badge>`, line 215, with `severityTone()` mapping
`error`/`warning`/`info` to `danger`/`warning`/`info`). `grep -n
"badge-warning\|badge-info" packages/metrics/src/components/*.tsx` returns
**zero matches** — Metrics is the only one of the three applets with no
hand-rolled instance of the literal classes `Badge`'s `tone` prop already
covers (Manager: 9 files; Matrix: 1 file).

**One soft near-duplicate exists, not using those literal classes.**
`SessionsPanel.tsx` line 54 renders a "Legacy" pill —
`<span className="ml-2 px-1.5 py-0.5 rounded text-ui-micro uppercase
tracking-widest bg-[var(--surface-muted)] text-theme-muted">Legacy</span>`
— which is structurally the same small-uppercase-label-pill idea as
`Badge`'s `neutral` tone (`border-theme-soft bg-[var(--surface-muted)]
text-theme-secondary`, confirmed by reading
`packages/ui/src/components/Badge.tsx` directly), just missing the border
and using `rounded` instead of `rounded-full`. A single instance, not a
repeated pattern within Metrics, but a one-line opportunity to use the
primitive the same file's sibling (`MetricsDashboard.tsx`) already imports
correctly.

### 4c. No modal/full-screen-overlay pattern exists at all

`grep -n "fixed inset-0" packages/metrics/src/components/*.tsx` returns
**zero matches** — unlike Manager (7 hand-rolled instances, 3 backdrop
conventions) and Matrix (4 hand-rolled instances, 1 consistent convention),
Metrics has no full-screen overlay, confirm dialog, or modal of any kind in
its `components/` directory. `SessionsPanel.tsx`'s "Saved Sessions" list
is an inline collapsible block (`mx-4 mt-4 border ... rounded-lg`,
`SessionsPanel.tsx` line 20), not an overlay. There is nothing to converge
onto `FloatingWindow` here because there is no competing hand-rolled modal
to begin with — `FloatingWindow` is imported by 0/14 files, but that zero
means something different in Metrics than in its two siblings.

### 4d. Metrics' own internal reuse: `TagTimeline.tsx`'s exported constants

Already covered in §3 as a convention finding, but worth restating as
duplication-avoidance credit: `ALL_TAG_KINDS`/`TAG_KIND_COLOR`/
`TAG_KIND_LABEL` are defined exactly once (`TagTimeline.tsx` lines 5–45)
and reused verbatim by `TagTable.tsx` and `TagDeck.tsx`, rather than each
maintaining its own copy of the 11-entry tag-kind-to-color/label map. No
duplicate maps were found across the package.

### 4e. "Too many peer buttons in one row" — present in a milder, more
   disciplined form than both siblings

`MetricsHeader.tsx` renders, in one row: "Sessions" (always visible),
"Save" (visible once `canManageSession` — `videoUrl && setupConfirmed`),
"Report" (visible once `setupConfirmed`), "Re-configure" (visible once
`canManageSession`), and "Open Video" (always visible). Because
`canManageSession` and `setupConfirmed` become true together, **all five
are reachable simultaneously** once a race setup is confirmed — the same
five-buttons-in-one-row count Manager's doc flagged twice
(`ManagerApp.tsx`'s toolbar, `RosterImportWizard.tsx`'s import-mode row).
**Unlike those two rows, Metrics' version uses only two visual
treatments**, not three: Sessions/Save/Report/Re-configure all share one
`HEADER_BUTTON_CLASS` constant (`MetricsHeader.tsx` line 4), and only "Open
Video" gets the primary `btn-primary` treatment — the same "1 primary + N
consistently-styled secondary" discipline Matrix's doc credited to
`RosterOptimizeStepParts.tsx`'s optimizer row, applied here to the
highest-traffic row in the whole applet (the header, visible on every
step).

`VideoPlayer.tsx`'s transport-control row (SkipBack, Play/Pause,
SkipForward, Mute, Maximize — 5 buttons, lines 243–308) is **not** counted
as an instance of this antipattern: it is a conventional media-player
control bar with a clear visual hierarchy (Play is centered and
accent-tinted with a background pill; the others are plain icon buttons),
the same shape every video player on the web uses, not five
undifferentiated peers competing for a coach's attention.

## 5. Prioritized shortlist

1. **✅ DONE 2026-09-13 (see `docs/reference/UI_REDESIGN_STATE.json` turn
   t16).** `VideoPlayer.tsx` (317 lines, §3). Pure JSX extraction, no
   behavior or visual change: 4 named presentational pieces —
   `VideoPlayerEmptyState`, `VideoTelemetryOverlay`, `VideoScrubber`,
   `VideoTransportControls` — moved to a new sibling `VideoPlayerParts.tsx`
   (255 lines), each taking plain values/callbacks with no state of its own.
   All state, refs, effects and event handlers (`isPlaying`, `currentTime`,
   `stepFrame`, the keyboard-shortcut listener, etc.) stay in `VideoPlayer`
   itself, which drops to 229 lines. `VideoPlayer`'s own props/exports are
   unchanged, so its one consumer (`VideoStage.tsx`) needed no edit. No
   render-time test exists for this file (confirmed: zero references in
   `tests/`) and none was added — a `<video>` element's real playback,
   seeking and codec behavior cannot be meaningfully exercised outside a
   real browser, so this file's verification is `tsc --noEmit` clean plus a
   direct line-by-line comparison against the original JSX, the same
   standard already applied to `TeamCard.tsx`'s split.
2. **⚠️ INVESTIGATED, NOT CONVERTED 2026-09-13 (see
   `docs/reference/UI_REDESIGN_STATE.json` turn t16).** `SegmentedControl`
   convergence, 1 site (§4a). `RaceSetupFormFields.tsx`'s `EventTypeSection`
   turns out to be a third distinct visual pattern, not a size-only variant
   of `SegmentedControl`: two **separately bordered boxes** in a
   `grid grid-cols-2` (each button carries its own `border`, active state
   `border-[var(--text-accent)] text-[var(--text-accent)]`), not one shared
   bordered container with a sliding indicator. Converting it would mean
   merging two independent boxes into one pill with an animated indicator —
   a real layout redesign, not a mechanical swap. Same conclusion, and same
   reasoning, as Matrix's own 6 sites (`04-MATRIX-DIAGNOSIS.md` §5 item 3):
   left as hand-rolled, blocked on a design decision.
3. **✅ DONE 2026-09-13 (see `docs/reference/UI_REDESIGN_STATE.json` turn
   t16).** `SessionsPanel.tsx`'s "Legacy" pill → `Badge` (§4b). Converted
   with an explicit `className` override (`rounded border-0 px-1.5 py-0.5
   font-normal text-theme-muted`) reproducing the original's smaller,
   sharp-cornered, borderless size exactly — `Badge`'s own default is an
   uppercase pill with a border and 2x the padding.
4. **`MetricsHeader.tsx`'s 5-button row (§4e).** Lower priority than the
   equivalent rows in Manager/Matrix specifically because this one is
   already well-behaved (one primary, one consistent secondary style) —
   worth a look only for completeness of the whole-app "too many peers"
   audit, not because it currently confuses a coach.
5. **No action needed on modals/`FloatingWindow` (§4c).** Recorded so a
   later phase doesn't spend time hunting for a Metrics-side modal
   convergence opportunity that doesn't exist — the applet simply has no
   overlay UI to converge.

## What this document does not claim

- It does not claim to have found every duplicated pattern in Metrics —
  only the ones in §4, each grep- or line-verified, on a package small
  enough that all 14 files were read in full.
- It does not propose a `SegmentedControl` migration's exact prop wiring,
  a `Badge` swap's exact `tone` value, or any visual redesign for the items
  in §5 — deferred to a later phase per the whole-app doc's own phasing.
- It does not cover `packages/manager` (`03-MANAGER-DIAGNOSIS.md`) or
  `packages/matrix` (`04-MATRIX-DIAGNOSIS.md`) — both already done,
  referenced here for comparison only.
- It does not re-examine `MetricsApp.tsx` (507 lines, the applet root)
  beyond what's needed to describe the screen inventory in §1 and confirm
  the `useToast` location in §2 — it is outside the declared
  `components/` scope, the same convention the Matrix pass applied to
  `MatrixApp.tsx` and the Manager pass applied to `ManagerApp.tsx`.
