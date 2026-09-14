# Manager applet diagnosis — screens, `@omniswim/ui` adoption, Panel+Parts adherence, duplication

**Status: diagnosis only, per Phase 0 of
[`02-UI-REDESIGN-WHOLE-APP.md`](02-UI-REDESIGN-WHOLE-APP.md) §6.
Nothing in this document has been built, and it does not propose any new
component API, prop shape, or visual mockup — that is explicitly deferred to
a later phase.** Every count below was produced by a command re-runnable
against this repo at the commit in place on 2026-09-10; none is an estimate.

Scope: `packages/manager/src/components/` — 51 `.tsx` files, 13,043 lines
(`find packages/manager/src/components -name "*.tsx" | xargs wc -l`,
matching the whole-app doc's own figure). This directory also holds 10
`*View.ts` pure-logic-extraction files (1,636 lines) that are **not** part
of the 13,043-line/51-file count and are discussed only where relevant to
§3's convention question.

**Coverage note, stated per the task's own instruction rather than silently
thinning rigor**: full or substantial direct reads were done on 19 files,
including 12 of the largest 15. Three of the largest 15 were **not**
directly opened this pass: `AthleteHistorySection.tsx` (324 lines),
`AthleteCreditedSwimsRow.tsx` (318 lines, badge usage confirmed by grep
only), and `SwimCloudCaptureRosterImportPanel.tsx` (476 lines) — the last of
these was deliberately *not* re-read because `01-UI-REDESIGN-PLAN.md`
(2026-09-09) already did a full read of it and reported its structure in
detail; this document defers to that read rather than re-deriving it. Below
the top 15, most of the remaining 36 files were covered by import-list and
targeted grep only, not a full read — flagged inline wherever a claim rests
on that lighter evidence.

## 1. Screen inventory — four different navigation idioms stacked, not one router

Manager has no router (no `react-router`, no URL-keyed views). A coach
reaches its surfaces through four different, independently-built navigation
mechanisms nested inside each other:

**Layer 1 — `ManagerApp.tsx`, boolean-flag modals.** The applet's root
component renders one persistent view (`TeamManagementView`) plus four
full-screen overlays it mounts/unmounts by `useState<boolean>` flag, not by
route:

| Overlay | Trigger | File | Lines |
| --- | --- | --- | --- |
| Roster import wizard | "Import roster" button | `RosterImportWizard.tsx` | 851 |
| Batch optimizer | "Batch optimizer" button | `BatchOptimizerPanel.tsx` | 266 |
| Team Roster Catalog | "Team Catalog" button | `RosterCatalogPanel.tsx` | 466 |
| Swimmer delete confirm | "Remove" on a roster row (What-if mode only) | `SwimmerDeleteConfirmModal.tsx` | 102 |

`ManagerApp.tsx`'s own top toolbar row (lines 248-289) that triggers three
of these has **five buttons** — Export CSV, Export HyTek, Batch optimizer,
Team Catalog, Import roster — see §4b for why this is itself an instance of
the "too many peers" pattern.

**Layer 2 — `TeamManagementView.tsx` → `RosterWizardShell.tsx`, a 4-step
wizard.** `RosterWizardShell.tsx` (29 lines) wraps `@omniswim/ui`'s
`WizardShell` with a fixed step list — `Source → Lineup → Relays →
Optimize` (`RosterWizardShell.tsx` lines 13-18) — and `TeamManagementView`
switches on `rosterStep` to render exactly one of four step components:
`RosterSourceStep.tsx` (126), `RosterLineupStep.tsx` (306),
`RosterRelayStep.tsx` (108, wraps `IndRelayManagementView.tsx`, 621), and
`RosterOptimizeStep.tsx` (290). This is a real step model — `WizardStep`
objects with `id`/`label`/`title`/`hint`/`icon` — not a tab set or a router,
confirmed directly in `RosterWizardShell.tsx`.

**Layer 3 — `RosterLineupStep.tsx`, a 3-tab `SegmentedControl` side panel.**
Inside the Lineup step alone, a second, independent tab mechanism exists:
`SegmentedControl` (from `@omniswim/ui`, correctly adopted here) switches a
side panel between Checklist (`LineupComplianceChecklist.tsx`), Arbitrage
(`CrossCourseArbitragePanel.tsx`, 338), and Scenarios
(`ScenarioSnapshotsPanel.tsx`, 267) — confirmed in `RosterLineupStep.tsx`
lines 216-301.

**Layer 4 — `AthleteLineupEditorPanel.tsx`, a slide-over drawer.** Selecting
an athlete in `TeamRosterPanel.tsx` opens a fixed-position drawer (its own
file header says so explicitly: "Rendered as a right-side slide-over drawer
... selecting an athlete used to push a ~950 line editor below the fold"),
itself internally split into collapsible `DrawerSection.tsx`-wrapped
sub-sections (`AthleteEntriesSection.tsx`, 453; `AthleteHistorySection.tsx`,
324).

So a coach's actual path to, say, editing one athlete's relay involvement is:
`ManagerApp` (always-visible) → Lineup step (1 of 4 wizard steps) →
`TeamRosterPanel`'s roster table → click athlete → drawer opens → an
already-scrolled-to collapsible section inside the drawer. Four distinct
"how do I navigate" idioms (boolean-flag modal, wizard step, segmented
tab, slide-over drawer) coexist in one applet, none reused by another.

**A fifth, currently-unreachable "screen state" exists in the code but not
in the product**: `TeamRosterPanel.tsx` accepts an `editorMode: 'unified' |
'legacy'` prop, **defaulting to `'legacy'`** (`TeamRosterPanel.tsx` line
107, confirmed directly: `editorMode = 'legacy',`), which renders
`AthleteCreditedSwimsPanel.tsx` (194 lines) inline plus
`AthleteMeetEntriesPanel.tsx` (314 lines) instead of the drawer. Its only
JSX call site in the entire package, `RosterLineupStep.tsx` (line 198,
confirmed directly: `editorMode="unified"`), passes `editorMode="unified"`
explicitly — confirmed by `grep -rn "<TeamRosterPanel" packages/manager/src`,
which returns exactly this one match. The `'legacy'` branch — and all of
`AthleteMeetEntriesPanel.tsx` — is dead in the live product today. See §4a.

## 2. `@omniswim/ui` adoption — the 51% aggregate hides a weaker real number

`grep -l "@omniswim/ui" packages/manager/src/components/*.tsx | wc -l` → 26
of 51 files (51%), matching the whole-app doc's own figure exactly.

**But adoption is not uniform in kind.** Inspecting what each of the 26
files actually imports from the package:

| What's imported | File count |
| --- | --- |
| `useToast` only (a hook, not a visual/design-system primitive) | 14 |
| At least one visual component (`Badge`, `Button`, `EmptyState`, `SegmentedControl`, `WizardShell`, `CutlineTag`, `CutlineNearMissChip`, `LoadingSpinner`) | 12 |

So the honest visual-adoption number is **12/51 (23.5%)**, not 51% — more
than half of the files counted as "adopters" only pull in the toast hook,
which every interactive panel needs regardless of design-system buy-in, and
contributes nothing to visual consistency. Concretely:

- `Button` is imported by exactly **1 of 51 files** —
  `ScenarioSnapshotsPanelParts.tsx` (`import { Button } from '@omniswim/ui'`,
  used at line 43: `<Button variant="outline" size="sm" onClick={onSave}
  disabled={disabled}>`). Meanwhile `grep -rc "<button"
  packages/manager/src/components/*.tsx` sums to **130** hand-rolled
  `<button>` elements across the package.
- `Badge` is imported by **0 of 51 files** despite 9 files hand-rolling
  `badge-warning`/`badge-info` `<span>` markup that duplicates exactly what
  `Badge`'s `tone` prop already covers (see §4d).
- `FloatingWindow` — the existing draggable `role="dialog"` primitive the
  2026-09-09 plan already recommends reusing for a capture browser — is
  imported by **0 of 51 files**, despite 6 files hand-rolling their own
  `fixed inset-0` modal overlay (see §4e).

**Breakdown for the 15 largest files** (by line count, the same list the
whole-app doc's own audit method would produce):

| File | Lines | Imports `@omniswim/ui`? | What kind |
| --- | ---: | --- | --- |
| `RosterImportWizard.tsx` | 851 | Yes | `useToast` only |
| `crossCourseArbitrageSections.tsx` | 848 | **No** | — |
| `TeamRosterPanel.tsx` | 818 | Yes | `useToast` only |
| `AthleteHistoryImportPanel.tsx` | 767 | Yes | `useToast` only |
| `IndRelayManagementView.tsx` | 621 | Yes | `useToast` only |
| `AthleteLineupEditorPanel.tsx` | 538 | Yes | `CutlineTag`, `CutlineNearMissChip`, `useToast` |
| `SwimCloudCaptureRosterImportPanel.tsx` | 476 | Yes | `useToast` only |
| `RosterCatalogPanel.tsx` | 466 | Yes | `useToast` only |
| `AthleteEntriesSection.tsx` | 453 | Yes | `CutlineTag`, `CutlineNearMissChip`, `useToast` |
| `RecruitForm.tsx` | 350 | **No** | — |
| `CrossCourseArbitragePanel.tsx` | 338 | Yes | `useToast` only |
| `TeamManagementView.tsx` | 325 | Yes | `useToast` only |
| `AthleteHistorySection.tsx` | 324 | Yes | `CutlineTag`, `CutlineNearMissChip` |
| `AthleteCreditedSwimsRow.tsx` | 318 | Yes | `CutlineTag`, `CutlineNearMissChip` |
| `AthleteMeetEntriesPanel.tsx` | 314 | Yes | `CutlineTag`, `CutlineNearMissChip`, `useToast` |

Two of the 15 largest files import nothing from `@omniswim/ui` at all:
**`crossCourseArbitrageSections.tsx` (848 lines — the 2nd-largest file in
the entire package)** and `RecruitForm.tsx` (350 lines). Of the 13 that do
"adopt" it, 8 do so via `useToast` alone — meaning on the largest, most
heavily-touched screens, real design-system reuse (a shared button, a shared
badge, a shared empty state) is close to absent; `CutlineTag`/
`CutlineNearMissChip` in the drawer-family files (`AthleteLineupEditorPanel`
and its `Section` siblings) is the one place genuine visual-primitive reuse
runs deep.

## 3. Panel+Parts convention adherence

The whole-app doc names the convention `Thing.tsx` + `ThingParts.tsx` (with
`Body`/`Sections` as further layers). Reading the actual files shows **three
naming variants of the same idea**, plus a fourth, unrelated convention that
is easy to mistake for it:

| Variant | Real examples on disk |
| --- | --- |
| `X` + `XParts` | `RosterCatalogPanel`(466)+`Parts`(304); `RosterOptimizeStep`(290)+`Parts`(163); `ScenarioSnapshotsPanel`(267)+`Parts`(144); `BaselineDiffPanel`(118)+`Parts`(78); `RosterScoringSetup`(107)+`Parts`(105); `LineupComplianceChecklist`(131)+`Parts`(172); `ScoringTheoryPanel`(123)+`Parts`(114); `RosterSourceStep`(126)+`Parts`(207) |
| `X` + `XSections`/`XSection` (UI decomposition, same intent, different suffix) | `CrossCourseArbitragePanel`(338)+`crossCourseArbitrageSections`(848)+`crossCourseArbitrageBody`(156)+`crossCourseArbitrageParts`(159); `AthleteLineupEditorPanel`(538)+`AthleteEntriesSection`(453)+`AthleteHistorySection`(324)+shared `DrawerSection`(50) |
| `X` + `xView.ts` — **pure-logic extraction, not a UI split** | `teamRosterView.ts`(83) for `TeamRosterPanel`; `indRelayGroupsView.ts`(81) for `IndRelayManagementView`; `athleteEntriesView.ts`(115); `athleteLineupEditorView.ts`(136); `crossCourseArbitrageView.ts`(177); `batchOptimizerView.ts`(71); `baselineDiffView.ts`(44); `scenarioSnapshotsView.ts`(44); `scoringTheoryPanelView.ts`(25); `workingCopyChangesView.ts`(42) — confirmed by reading `teamRosterView.ts`'s own header: "Pure view-model helpers ... none of this touches React." |
| Row extraction (a different, complementary convention) | `TeamRosterRow.tsx`(116), `AthleteRosterRow.tsx`(144), `WorkingCopyChangeRow.tsx`(61), `ScenarioSnapshotRow.tsx`(121), `AthleteCreditedSwimsRow.tsx`(318) — one list item's rendering, not the whole panel's structure |

**Threshold used, and why**: the median main-file size among the 9
already-split `X`+`XParts` pairs above is **131 lines**
(sorted: 107, 118, 123, 126, 131, 267, 290, 338, 466). That is this
package's own revealed practice — it already splits proactively, well below
where a "this file is unmanageable" judgment call would normally kick in.
Applying that bar honestly would flag nearly every file in the package, so
this document instead reports, separately and more conservatively, files
**at least 2x that median (260+ lines) with *no* UI-decomposition sibling of
any kind** — not even a `View.ts` logic split:

| File | Lines | Existing split? |
| --- | ---: | --- |
| `TeamRosterPanel.tsx` | 818 | Logic-only (`teamRosterView.ts`, 83 lines) — no UI decomposition beyond one row component |
| `AthleteHistoryImportPanel.tsx` | 767 | **None at all** — no `Parts`, no `Section`, no `View.ts`; confirmed by `find -iname` returning only the one file |
| `IndRelayManagementView.tsx` | 621 | Logic-only (`indRelayGroupsView.ts`, 81 lines) |
| `SwimCloudCaptureRosterImportPanel.tsx` | 476 | **None at all** (already flagged as monolithic in the 2026-09-09 plan) |
| `RecruitForm.tsx` | 350 | None |
| `AthleteMeetEntriesPanel.tsx` | 314 | None — and see §4a, this file is arguably obsolete rather than in need of a split |
| `DuplicateAthletesPanel.tsx` | 305 | None |
| `BatchOptimizerPanel.tsx` | 266 | Logic-only (`batchOptimizerView.ts`, 71 lines) |

`AthleteLineupEditorPanel.tsx` (538 lines) is **not** on this list — it
already has a real 4-way split (`AthleteEntriesSection` +
`AthleteHistorySection` + shared `DrawerSection` + `athleteLineupEditorView.ts`
logic), just under the `Section` name rather than `Parts`. The convention is
being followed there; only the filename vocabulary is inconsistent with the
rest of the package.

**One split re-ballooned past what it replaced.**
`crossCourseArbitrageSections.tsx`'s own file header states it was "split
out of the panel so each section's branching ... lives in its own named
function instead of one 527-line render tree — pure extraction, no behavior
change." That extraction happened — but the extracted `Sections` file has
since grown to **848 lines** (confirmed directly: `wc -l` returns 848),
larger than the entire original problem it was extracted to solve, and is
also the single largest file in the whole package with zero `@omniswim/ui`
import (§2). The split mechanism worked once; nothing re-checked the
result's size afterward.

## 4. Duplicated or near-duplicated UI patterns

### 4a. A fully-parallel, currently-unreachable UI implementation

`TeamRosterPanel.tsx`'s `editorMode` prop (§1) gates two independent
implementations of "edit one athlete's planned meet entries":
`AthleteMeetEntriesPanel.tsx` (314 lines, the `'legacy'` default) and
`AthleteEntriesSection.tsx` (453 lines, the `'unified'` path actually used).
Their import lists are near-identical — both pull `ALL_PLAN_EVENTS`,
`createPlannedEntry`/`addPlannedEntry`/`updatePlannedEntry`,
`countSwimmerEntries`/`formatEntryLimitLabel`/`swimmerExceedsEntryLimits`,
`parseSwimCloudPasteDetailed`, `buildAliasResolver`, `divisionForTeamOrNull`,
`buildCutlineTagForTeam`, `canonicalSwimmerName`/`compactEventTitleAttr`/
`formatCompactEventLabel`, and `CutlineTag`/`CutlineNearMissChip`/
`useToast` — for what reads as the same feature built twice. The only live
JSX call site of `TeamRosterPanel` (`RosterLineupStep.tsx`, confirmed the
sole match for `grep -rn "<TeamRosterPanel" packages/manager/src`) hardcodes
`editorMode="unified"`, so the `'legacy'` branch — 314 lines of
`AthleteMeetEntriesPanel.tsx` plus the ~40-line legacy render branch inside
`TeamRosterPanel.tsx` itself (lines 660-699) — has no reachable path from
any screen in the product today, yet ships and is presumably still
maintained.

### 4b. "Too many peer actions in one row" recurs beyond the SwimCloud picker

The 2026-09-09 plan already found this in `RosterImportWizard.tsx`. Reading
the file again today shows the row has **grown to five controls**, not
four: `Paste` / `CSV` (styled as tabs, with an active-state accent
underline) sitting beside `SwimCloud` (a reference-panel toggle), `From
clipboard`, and `Browse captures` (both styled as plain buttons, no
underline) — all in one `flex items-center gap-1 border-b` row
(`RosterImportWizard.tsx` lines 604-647). Two different interaction idioms
(tab vs. button) are visually merged into one row with no separation.

This same "too many peers" shape recurs twice more:

- **`ManagerApp.tsx`'s top toolbar** (lines 248-289): five buttons — `Export
  CSV`, `Export HyTek`, `Batch optimizer`, `Team Catalog`, `Import roster` —
  rendered in **three different visual treatments** in the same row (`Export
  CSV`/`Export HyTek` share one style; `Batch optimizer` a near-identical
  second style; `Team Catalog` a third, smaller uppercase-micro pill style;
  only `Import roster` gets `btn-primary`). This is the very first row a
  coach sees on opening Manager.
- **`RosterOptimizeStepParts.tsx`'s `OptimizerControls`** (lines 69-96):
  three buttons — `Optimize team`, `Classic`, `All teams` — all calling
  different optimization strategies on the same data. This instance at
  least distinguishes primary (`btn-primary`) from the two secondary
  (bare-border) buttons, unlike the other two rows above, which give every
  button roughly equal visual weight.

### 4c. A hand-rolled team `<select>` duplicated six times

The exact literal `<option value="">Select a team…</option>` (same
placeholder text, same empty-value convention), each followed by its own
`teams.map(t => <option key={t} value={t}>{t}</option>)` and its own
`glass-input` class list, appears independently in six files: grep for
`"<option value=\"\">Select a team…</option>"` returns
`IndRelayManagementView.tsx:340`, `RosterImportWizard.tsx:680`,
`RosterOptimizeStepParts.tsx:49`, `RosterRelayStep.tsx:81`,
`TeamRosterPanel.tsx:506`, and (a related "Select a team…" `<option>`)
`AthleteHistoryImportPanel.tsx:549`. No shared `TeamSelect`/`TeamPicker`
control exists for this, even though `TeamPickerEmptyState.tsx` already
exists for the adjacent "no team chosen yet, show a whole-panel empty
state" case — the app has already extracted the empty-state flavor of
"pick a team" but not the inline-dropdown flavor.

### 4d. Status-pill/badge markup hand-rolled nine times

`@omniswim/ui` exports `Badge` (`packages/ui/src/components/Badge.tsx`) with
a `tone` prop (`accent`/`success`/`warning`/`info`/`neutral`/`danger`) whose
`warning`/`info` tones literally resolve to the `badge-warning`/`badge-info`
CSS classes. Nine Manager files instead render `<span
className="badge-warning ...">`/`<span className="badge-info ...">`
directly, with zero of them importing `Badge` (confirmed: `grep -rl
"badge-warning\|badge-info" packages/manager/src/components/*.tsx | wc -l`
→ 9): `AthleteCreditedSwimsRow.tsx:289`, `AthleteRoleTag.tsx:32`,
`AthleteRosterRow.tsx:56`, `DuplicateAthletesPanel.tsx:55`,
`RosterCatalogPanelParts.tsx:213,215`, `ScoringTheoryPanelParts.tsx:20`, and
`AthleteHistoryImportPanel.tsx`'s `actionBadge()` (below). A screenshot in
words: `AthleteRosterRow.tsx` renders `<span className="badge-info px-2
py-0.5 rounded text-[10px]">{athlete.classYear}</span>` immediately next to
`RosterCatalogPanelParts.tsx` rendering `<span className="badge-info px-2
py-0.5 rounded text-[10px]">{roster.team.gender}</span>` — same classes,
same shape, defined twice, neither going through `Badge`.

### 4e. The same "centered panel over a full-screen backdrop" modal, built seven times, three ways

`grep -n "fixed inset-0" packages/manager/src/components/*.tsx` finds seven
independent implementations of a full-screen overlay (confirmed: 7 files
match):

| File | Backdrop class | z-index |
| --- | --- | --- |
| `BatchOptimizerPanel.tsx` | `bg-black/50` (hardcoded, not a theme token) | `z-50` |
| `AthleteLineupEditorPanel.tsx` (mobile drawer scrim, `lg:hidden`) | `bg-black/50` (hardcoded) | `z-40` |
| `LoadMeetHereCard.tsx` | `modal-backdrop` utility class | `z-50` |
| `SwimmerDeleteConfirmModal.tsx` | `modal-backdrop` utility class | `z-50` |
| `RosterCatalogPanel.tsx` | `bg-[var(--backdrop)]` theme token | `z-50` |
| `RosterImportWizard.tsx` | `bg-[var(--backdrop)]` theme token | `z-50` |
| `SwimCloudCaptureRosterImportPanel.tsx` | `bg-[var(--backdrop)]` theme token | `z-[60]` |

Three different backdrop conventions for the same visual pattern, two of
them (`bg-black/50`) hardcoded rather than the `var(--backdrop)` token the
other three use — a direct, Manager-specific instance of the whole-app
doc's §4.2 "stray hardcoded colors" concern. `@omniswim/ui` has no `Modal`
component to converge these onto; it has only `FloatingWindow`, a
draggable/resizable dialog with a different interaction model, imported by
zero files in Manager.

### 4f. A duplicate label-mapping switch statement

`RosterImportWizard.tsx` defines `actionLabel()` (line 79) and
`AthleteHistoryImportPanel.tsx` defines `actionBadge()` (line 53) — both a
4-case `switch` over the same `ImportSwimmerAction` type (imported by both
files from `@omniswim/core/lib/historyImportRoster`), with the identical
label text in every case (`'New recruit'`, `'Add to lineup'`, `'Already
recruit'`, `'History only (matched)'`); one returns the label alone, the
other a `{ label, className }` pair. Independently written in two files
that already share four other imports from the same module
(`formatHistoryImportSummary`, `importHistoryToRoster`,
`previewHistoryImportActions`, `rosterNamesForTeam`) plus
`AliasSuggestionsPanel` — these two files are, in miniature, the same kind
of "two parallel importers built independently" the 2026-09-09 plan already
found once for the SwimCloud capture pickers, just for the paste/CSV import
path instead of the capture-browsing path.

## 5. Prioritized shortlist

1. **✅ DONE 2026-09-10 (see `docs/reference/UI_REDESIGN_STATE.json` turn
   t13).** Resolve the dead `editorMode: 'legacy'` path in
   `TeamRosterPanel.tsx` / `AthleteMeetEntriesPanel.tsx` (§4a). Highest
   leverage of anything found: this is not duplicated UI a coach ever sees
   twice, it's ~350+ lines of UI code with a default value nobody's live
   call site uses, maintained in parallel with the real thing for no
   visible benefit — pure removable surface area, no design decision
   required to see it. `AthleteMeetEntriesPanel.tsx` deleted entirely.
   Deliberately left as a follow-up, not done: `onDeleteSwim`/`onEditSwim`
   still thread from `TeamManagementView.tsx` through `RosterLineupStep.tsx`
   into `TeamRosterPanel.tsx` unused — confirmed already-inert (not newly
   broken by this fix), left alone as a scope boundary, see t13's own note.
2. **`crossCourseArbitrageSections.tsx` (§2, §3).** The single largest file
   in the package with zero `@omniswim/ui` import, and the clearest
   evidence that "split it into Parts" is necessary but not sufficient —
   this file was split out specifically to shrink a 527-line render tree
   and is now 848 lines, bigger than what it replaced.
3. **✅ DONE 2026-09-14, 2 of 3 — §4b.** `ManagerApp.tsx`'s top toolbar
   (5 buttons, 3 different treatments) and `RosterOptimizeStepParts.tsx`'s
   optimizer row (already the best-behaved of the three) both converged
   onto `@omniswim/ui`'s `Button` — one `variant="primary"` per row
   (Import roster; Optimize team), the rest `variant="outline"`, no more
   ad-hoc `nav-tab-inactive`/bare-border/uppercase-pill mixing.
   **`RosterImportWizard.tsx`'s row — checked, already resolved by an
   earlier round not reflected here.** Reading it fresh: it's down to 2 real
   tabs (Paste/CSV, correctly a different idiom, not a peer-button row) plus
   2 auxiliary buttons (`SwimCloud` reference toggle, `Add from SwimCloud`)
   that already share one consistent uppercase-micro-label style
   (`nav-tab-inactive`, the same convention used throughout this app's other
   micro-buttons, e.g. the roster-queue row). Converting these 2 to generic
   `Button` would have DROPPED that convention (`Button` has no
   uppercase-tracking-widest micro variant) rather than fixed an
   inconsistency — left alone, correctly, matching this session's own
   standing rule of not forcing a genuinely-fine pattern into a shared
   primitive it doesn't fit.
4. **✅ DONE 2026-09-13 (see `docs/reference/UI_REDESIGN_STATE.json` turn
   t16).** Badge convergence (§4d). Converted at 5 of the 9 files (7 call
   sites): `AthleteCreditedSwimsRow.tsx`, `AthleteRoleTag.tsx`,
   `AthleteRosterRow.tsx`, `RosterCatalogPanelParts.tsx` (2 sites),
   `RosterImportWizard.tsx` (2 sites), plus `DuplicateAthletesPanel.tsx`'s
   `TIER_CLASS` map (a hand-rolled second copy of `Badge`'s own
   success/accent/warning tones under different names). First added
   `tailwind-merge`/`clsx` to `@omniswim/ui` and a `cn()` helper (same
   convention `packages/metrics/src/lib/utils.ts` already used) so a
   caller's size-override `className` reliably wins the cascade — the plain
   `.filter(Boolean).join(' ')` `Badge`/`Button` used before this could not
   guarantee that. Every converted site got an explicit `className` override
   reproducing its original padding/case/weight/radius exactly, verified by
   reading each site's markup before and after, not assumed.
   **Deliberately NOT converted, 2 files:** `AthleteHistoryImportPanel.tsx`
   (`actionBadge()`, plus its swim-tag row) and `ScoringTheoryPanelParts.tsx`
   (`SwimmerMatchChip`) — both render a wider, truncatable, non-uppercase
   label chip (`rounded-lg`, `text-ui-caption`, `max-w-full truncate`, one
   variant with no background fill at all), not `Badge`'s small uppercase
   pill. Converging them would mean overriding away nearly every one of
   `Badge`'s own default classes, which is not what "convergence" means —
   left as hand-rolled, correctly.
5. **✅ DONE 2026-09-14.** Modal backdrop convergence (§4e). New `Modal`
   primitive in `@omniswim/ui` (backdrop, dialog semantics, Escape-to-close;
   deliberately no prescribed header/footer shape). Converged 5 of the 6
   remaining hand-rolled overlays (one of the original 7 was already gone,
   replaced earlier this session): `BatchOptimizerPanel.tsx`,
   `LoadMeetHereCard.tsx`, `RosterCatalogPanel.tsx`, `RosterImportWizard.tsx`,
   `SwimmerDeleteConfirmModal.tsx`. Both hardcoded `bg-black/50` instances
   fixed — one converged into `Modal`, the other
   (`AthleteLineupEditorPanel.tsx`'s drawer scrim) left as its own
   responsive-drawer pattern with just the color-token swap, since it is not
   a centered dialog and forcing it into one would be the wrong shape.
6. **`AthleteHistoryImportPanel.tsx` (§3).** The largest fully-monolithic
   file in the package — 767 lines with no `Parts`, `Section`, or even a
   logic-only `View.ts` split, unlike every other file of comparable size.

## What this document does not claim

- It does not claim to have found every duplicated pattern in Manager —
  only the six in §4, each grep-verified. A deeper pass on the ~36 files
  given lighter coverage (§ intro) may find more.
- It does not propose a `Modal` component API, a `TeamSelect` prop shape,
  or any visual redesign for the items in §5 — that is next-phase work per
  the whole-app doc's own phasing (§6 there), once this diagnosis is
  reviewed.
- It does not re-adjudicate the SwimCloud capture-picker duplication —
  that is `01-UI-REDESIGN-PLAN.md`'s finding, referenced here, not redone.
- It does not cover `packages/matrix` or `packages/metrics` — out of scope
  per the task.
