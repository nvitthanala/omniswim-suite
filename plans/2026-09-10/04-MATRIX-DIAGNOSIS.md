# Matrix applet diagnosis — content for `plans/2026-09-10/04-MATRIX-DIAGNOSIS.md`

**Status: diagnosis only.** Scope: `packages/matrix/src/components/` — 15 `.tsx` files, 5,618 lines (`find packages/matrix/src/components -name "*.tsx" | xargs wc -l | sort -rn`, confirmed; the 15 file sizes sum exactly to 5,618). `DeleteConfirmationModal.tsx` is counted in this total but is not really a Matrix screen — see §1. `packages/matrix/src/lib/swimCloudMeetImportBridge.ts` (pure logic) and `MatrixApp.tsx`/`index.ts` (outside `components/`) are read for context but not counted in the 5,618.

**Coverage note**: unlike the Manager pass, all 15 files were read in full this session, not sampled — Matrix's smaller size made that possible within budget. No file's structure below is inferred from its name or a partial read.

## 1. Screen inventory — one real wizard, one dead tab set, one orphaned global-vs-embedded split

`MatrixApp.tsx` gates on `activeWorkspace`: no workspace → `EmptyState` (`@omniswim/ui`); else → `ChartStaleBundleGuard` + `OpsModule`, cross-faded by `AnimatePresence` keyed on `${workspace.id}-${gender}`.

**`OpsModule.tsx` (717 lines) is the real navigation spine.** It wraps `@omniswim/ui`'s `WizardShell` with a fixed 4-step model (`MATRIX_STEPS`, a real `WizardStep<MatrixStepId>[]` array with `id`/`label`/`title`/`hint`/`icon`, same shape as Manager's `RosterWizardShell`): **Load → Score → Standings → Analyze**. This is the one place in Matrix that correctly adopts a shared `@omniswim/ui` navigation primitive. The wizard's toolbar (inside `WizardShell`, `OpsModule.tsx` lines 594-639) carries a conditional "Edit roster in Manager" cross-applet link (shown only when `rosterDirty`) plus a "Catalog:" roster-opt-in `<select>`. Two overlays mount from state flags at this level: `SwimmerDeleteConfirmModal` (delete-swimmer confirm, what-if mode only) and `SwimCloudCapturePicker` (browse-captures modal).

**`MeetOperationsView.tsx` (771 lines) is the step content — but the four "steps" are `if (activeStep === X)` blocks inside one function, not four separate step components** (unlike Manager's `RosterSourceStep`/`RosterLineupStep`/etc., each its own file):
- `'load'`: meet-file loading UI — "Load PDF" button, a "From SwimCloud" dropdown-trigger (`role="menu"`, Browse captures.../From clipboard — a real dropdown, not a row of undifferentiated peer buttons), "Link Psych" button, plus a "copy meet from another workspace" `<select>`.
- `'score'`: renders `ScoringSettingsPanel` (collapsible) + an official-team-scores grid.
- `'standings'`: the team matrix — one `TeamCard` per team (search/filter row above) + a "Top Individual Contributors" table.
- `'analyze'`: chronological score-timeline chart, a momentum chart (`vs Prelims`/`vs Psych` toggle), and a diff table (`MeetDiffTable`/`PrelimsDiffTable`, `Diff`/`Prelims` toggle).

**`TeamCard.tsx` (1,351 lines)** is per-team, not top-level nav: click a team's header to expand into a chart pane (`By Event`/`By Class` toggle) and a "Team Matrix" list (`By Event`/`By Swimmer` toggle), with click-to-edit times in what-if mode and a per-swimmer delete button.

**`ScoringSettingsModal.tsx` (398 lines) is a second, independent entry point to editing the same `ScoringSettings` object** — opened from the global `SuiteHeader`'s "scoring settings" button (`apps/shell/src/App.tsx` line 139: `onOpenScoringSettings={showWorkspaceControls ? () => setShowScoringModal(true) : undefined}`, rendered at line 192), reachable from *outside* the wizard entirely, on top of whatever step is currently showing. See §4a.

**`DeleteConfirmationModal.tsx` (53 lines) is not a Matrix screen at all.** It is imported and rendered only by `apps/shell/src/components/WorkspaceSidebar.tsx` (`import DeleteConfirmationModal from '@omniswim/matrix/components/DeleteConfirmationModal'`) to confirm deleting an entire workspace — a shell-owned lifecycle action homed in this package purely via its `package.json` subpath export (`"./components/DeleteConfirmationModal"`). It inflates the 15-file/5,618-line count with something a coach never reaches by navigating Matrix.

**`WorkspaceTabs.tsx` (41 lines) is fully dead code.** It defines a `WorkspaceTabId = 'meet-ops' | 'team-mgmt'` two-tab nav component. A repo-wide grep for `WorkspaceTabs`, `WorkspaceTabId`, `team-mgmt`, and `meet-ops` returns matches only inside the file's own definition — **zero import sites anywhere in the repo** (independently re-confirmed: `grep -rl "WorkspaceTabs\|WorkspaceTabId"` across the whole repo returns only this one file). Matrix apparently once planned tab-based top-level navigation and shipped the 4-step wizard instead, leaving this component orphaned.

**A coach's actual path** from "opened Matrix" to "editing a scoring setting": suite shell → Matrix applet tab → `MatrixApp` (workspace check) → `OpsModule`'s wizard, default step `'load'` → click "Score" tab → `MeetOperationsView` renders `ScoringSettingsPanel` inline. *Or*, without ever entering the wizard: click the global header's scoring-settings icon (workspace screens only) → `ScoringSettingsModal` opens as a full overlay, edited with completely separate local state, saved via a different button. To reach one team's score matrix: Load step → load a meet → click "Standings" tab → click a team's `TeamCard` header to expand it.

## 2. `@omniswim/ui` adoption, by kind — 33% raw, 26.7% real, but the shape of the gap differs from Manager's

`grep -l "@omniswim/ui" packages/matrix/src/components/*.tsx | wc -l` → **5 of 15 (33%)**, matching the whole-app doc's figure. Breaking down what each imports (`grep -n "^import.*@omniswim/ui"`):

| File | Lines | Imports from `@omniswim/ui` | Kind |
| --- | ---: | --- | --- |
| `TeamCard.tsx` | 1,351 | `ChartFrame`, `ChartShell`, `CutlineTag`, `CutlineNearMissChip` | Visual primitives |
| `MeetOperationsView.tsx` | 771 | `ChartFrame`, `ChartShell`, `EmptyState` | Visual primitives |
| `SwimCloudCapturePicker.tsx` | 769 | `useToast` | Hook only |
| `OpsModule.tsx` | 717 | `useToast`, `WizardShell` | Hook + visual primitive |
| `ScoringSettingsPanel.tsx` | 451 | — | None |
| `ScoringSettingsModal.tsx` | 398 | — | None |
| `MomentumChartCard.tsx` | 218 | `ChartFrame`, `ChartShell` | Visual primitives |
| `ProjectedActualScore.tsx` | 236 | — | None |
| `matrixPresentation.tsx` | 214 | — | None |
| `PrelimsDiffTable.tsx` | 129 | — | None |
| `MeetDiffTable.tsx` | 128 | — | None |
| `ChartStaleBundleGuard.tsx` | 82 | — | None |
| `SwimmerDeleteConfirmModal.tsx` | 60 | — | None |
| `DeleteConfirmationModal.tsx` | 53 | — | None |
| `WorkspaceTabs.tsx` | 41 | — | None (also dead) |

So: 1 file is hook-only (`SwimCloudCapturePicker.tsx`), 4 import at least one real visual primitive. **Real visual-adoption is 4/15 (26.7%)**, not the raw 33% — a smaller, gentler correction than Manager's 51%→23.5%, because Matrix's adopters are mostly genuine, not toast-hook padding.

**Important correction to the premise this pass was asked to check**: `TeamCard.tsx`, the single largest file in the entire suite, does **not** hand-roll everything — it imports and uses `ChartShell`, `ChartFrame`, `CutlineTag`, and `CutlineNearMissChip` for real (confirmed directly: `import { ChartFrame, ChartShell, CutlineTag, CutlineNearMissChip } from '@omniswim/ui';`). But its adoption is narrow: confined to chart-wrapping and cutline-badge primitives. Within the same file it hand-rolls all 8 of its `<button>` elements, its one `<select>`, all three of its two-state toggle rows (§4b), and an entire custom draggable/pinned tooltip system — none of which reuse `Button`, `SegmentedControl`, or `Badge` from `@omniswim/ui`.

`Button` is imported by **0 of 15 files**. `Badge` is imported by **0 of 15 files** (confirmed directly: no `@omniswim/ui` import line mentions `Badge` anywhere in the package) — the one textual match for "Badge" (`grep -rn "Badge"`) is `ProjectedActualScore.tsx`'s own locally-defined `DeltaBadge` function, an unrelated hand-rolled component, not the shared one. Meanwhile `grep -c "<button" packages/matrix/src/components/*.tsx` sums to **45** hand-rolled `<button>` elements across 9 of 15 files, and `grep -c "<select"` sums to **11** hand-rolled `<select>` elements across 5 files (`@omniswim/ui` has no `Select` primitive to converge onto, unlike `Button`/`Badge`). `SegmentedControl` is imported by **0 of 15 files** despite the exact shape it standardizes being hand-built 6 times (§4b). `FloatingWindow` is imported by **0 of 15 files**, matching Manager's zero.

## 3. Panel+Parts convention adherence — Matrix follows none of Manager's three variants

`find packages/matrix/src -type f` returns exactly: the 15 component files, `index.ts`, `MatrixApp.tsx`, and one logic file (`lib/swimCloudMeetImportBridge.ts`). **There is no `*Parts.tsx`, `*Sections.tsx`, `*Body.tsx`, or `*View.ts` file anywhere in the package** — Matrix follows zero of the three UI-decomposition variants Manager's doc catalogued (`XParts`, `XSections`, logic-only `xView.ts`), and it never adopted them.

**The one convention Matrix does have, that Manager's doc's taxonomy doesn't quite name**: `matrixPresentation.tsx` (214 lines) — a single shared file of small presentational components (`AthleteName`, `TeamName`, `CompactEventLabel`, `PointsValue`, `PrelimsOuValue`, `PlacementExpectedValue`, `SwimTimeCell`, `MatrixRow`) imported across `TeamCard.tsx`, `MeetOperationsView.tsx`, `MomentumChartCard.tsx`, `MeetDiffTable.tsx`, and `PrelimsDiffTable.tsx`. It's closest to Manager's "row extraction" idea, but done as one applet-wide shared file rather than one row-file per panel — a real, working reuse mechanism worth crediting, not just criticizing.

**`TeamCard.tsx`'s actual function-level breakdown** (confirming the whole-app doc's claim directly, by line span):

| Function/component (in file order) | Lines | What it renders/does |
| --- | --- | --- |
| `buildTeamRowCutlineTags` | 63–96 | Logic: resolves relay vs. single cutline verdict for one row |
| `relayMissingStrokeLabel` | 98–102 | Logic: stroke-name lookup |
| `PodiumMedal` | 111–119 | Renders a medal emoji for podium finish |
| `CutlineVerdict` | 122–129 | Renders `CutlineTag` + `CutlineNearMissChip` pair |
| `computeClassTopPerformers` | 132–141 | Logic: top-8 by class year |
| `sortSwimmersByPoints` | 144–150 | Logic: sort helper |
| `TooltipHeader` | 153–166 | Renders chart-tooltip header (title + points + O/U) |
| `ClassTopPerformersList` | 169–183 | Renders class-tooltip's swimmer list |
| `TooltipSwimmerList` | 186–222 | Renders event-tooltip's swimmer list |
| `classChartTooltipPosition` | 225–232 | Logic: mouse-event → tooltip x/y |
| `TooltipSwimmerRow` | 270–363 | Renders one swimmer row inside a chart tooltip (94 lines) |
| `InlineTimeEditForm` | 391–412 | Renders the click-to-edit time input |
| `TeamMatrixTimeCell` | 430–510 | Renders a matrix row's time column (81 lines) |
| `TeamMatrixPointsCell` | 523–563 | Renders a matrix row's points column |
| `TeamMatrixSwimmerRow` | 566–639 | Renders one full matrix row (74 lines) |
| `TeamCard` (default export) | 641–1349 | The component itself (~710 lines) |
| `renderTooltipContent` | 892–935 | **Defined as a closure inside `TeamCard` itself**, not even a top-level function — the tightest coupling of all |

16 top-level private helpers plus one inline closure, none split into sibling files — confirming the whole-app doc's claim exactly, with the function-level detail it didn't have room for.

Other large files show the same shape at smaller scale: `MeetOperationsView.tsx` (771 lines) has one module-scope render helper, `TimelineTooltipContent` (lines 34–105, ~72 lines). `SwimCloudCapturePicker.tsx` (769 lines) has ~12 pure logic/formatting helpers (`subjectLabel`, `describeCompleteness`, `groupParses`, etc.) that read like `xView.ts` candidates but were never extracted — its actual render tree is one ~280-line JSX return with three inline-mapped list sections. `OpsModule.tsx` (717 lines) has the same shape: `hasEntries`, `hasRosterEdits`, `resolveKeepRecruits`, `buildParsedMeetUpdatePatch`, `swimCloudImportStatus`, `parsePsychApiResponse` are all pure logic, un-extracted.

Applying Manager's own revealed-practice threshold (files 260+ lines with no UI-decomposition sibling of any kind): **8 of Matrix's 15 files clear 260 lines, and all 8 have zero sibling split of any kind** — `TeamCard.tsx` (1,351), `MeetOperationsView.tsx` (771), `SwimCloudCapturePicker.tsx` (769), `OpsModule.tsx` (717), `ScoringSettingsPanel.tsx` (451), `ScoringSettingsModal.tsx` (398), `ProjectedActualScore.tsx` (236 — has its own internal 4-function split: `ScoreRow`, `DeltaBadge`, `CompactScoreSummary`, `FullScoreSummary`, same in-file shape as `TeamCard` just far smaller), `MomentumChartCard.tsx` (218). Where Manager's package had *some* answer (a `View.ts` at minimum) for most of its large files, Matrix has **none**, anywhere, for any file.

## 4. Duplicated or near-duplicated UI patterns

### 4a. Two live, independently-maintained editors for the same `ScoringSettings` object

Unlike Manager's §4a (one branch dead), **both are reachable today**: `ScoringSettingsPanel.tsx` (451 lines, embedded in `MeetOperationsView`'s Score step) and `ScoringSettingsModal.tsx` (398 lines, opened from the global `SuiteHeader`'s scoring-settings button via `apps/shell/src/App.tsx` line 192). Both maintain independent local state for the same ~11 fields (`scoringPoints`, `relayMultiplier`, `halfRateRelaySwimmer`, `maxIndividualScorersPerTeam`, `maxRelaysScoringPerTeam`, `scorerCapScope`, `diverScorerWeight`, `relayEligibleFromScorerPool`, `maxIndividualEntriesPerSwimmer`, `maxRelayEntriesPerSwimmer`, `maxTotalEntriesPerSwimmer`), both call `scoringSettingsLock`/`mergeScoringSettings`/`fetchScoringPresetList`/`fetchScoringPresetSettings` from the same core module, and both render a "Merged / PDF only" scoring-view toggle with near-identical copy — e.g. `ScoringSettingsPanel.tsx` line 131 and `ScoringSettingsModal.tsx` line 133 both carry the title text `"Imported/planned/recruit entries remap onto the loaded meet's events and compete for points"` verbatim. A future field added to `ScoringSettings` has to be added to both files' local state lists by hand or one editor silently drops it.

### 4b. A hand-rolled two-state segmented toggle, 6 render sites, 4 files, 0 using `SegmentedControl`

Two visual variants of the same idea, none using `@omniswim/ui`'s `SegmentedControl` (confirmed correctly adopted at least once elsewhere in the suite, per Manager's own doc, in `RosterLineupStep.tsx`):

- **Bordered pill-pair** (`border border-theme-soft ... p-1`/`p-0.5`): `MeetOperationsView.tsx:611` (Diff/Prelims), `ScoringSettingsPanel.tsx:120` (Merged/PDF only), `ScoringSettingsModal.tsx:123` (Merged/PDF only — near-identical copy to the Panel's), `TeamCard.tsx:1007` (By Event/By Class), `TeamCard.tsx:1259` (By Event/By Swimmer).
- **Freestanding pill pair** (no shared border, `text-[9px] uppercase tracking-widest px-2 py-0.5 rounded` per button, `bg-[var(--text-accent)]/15 text-[var(--text-accent)]` active state): `MeetOperationsView.tsx:574,586` and `TeamCard.tsx:1186,1198` — both literally labeled "vs Prelims"/"vs Psych", same classes, built independently for the meet-level and team-level momentum charts respectively.

### 4c. Modal backdrop: consistent (unlike Manager's 3-way split) — but `FloatingWindow` is still unused

`grep -n "fixed inset-0" packages/matrix/src/components/*.tsx` finds exactly 4 matches, and **all 4 use the identical convention** (independently re-confirmed byte-for-byte): `fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm` — `DeleteConfirmationModal.tsx:14`, `ScoringSettingsModal.tsx:176`, `SwimCloudCapturePicker.tsx:494`, `SwimmerDeleteConfirmModal.tsx:19`. No hardcoded backdrop color, no z-index disagreement — genuinely better-behaved than Manager's 7-file, 3-convention split. Zero of the 4 use `FloatingWindow`, matching Manager.

### 4d. Two near-line-identical confirm-delete dialogs

`DeleteConfirmationModal.tsx` (53 lines, deletes a workspace, shell-owned) and `SwimmerDeleteConfirmModal.tsx` (60 lines, removes one swimmer, Matrix-owned) are structurally the same component built twice: identical icon-circle treatment (`w-10 h-10 rounded-full bg-[var(--text-accent)]/15 ... border border-[var(--text-accent)]/20`), identical header/close-button row, identical warning-paragraph classes (`text-xs text-theme-secondary bg-[var(--text-accent)]/10 border border-[var(--text-accent)]/15 p-3 rounded-lg mb-8`), and an identical Cancel/Confirm button pair with a `Trash2` icon and the same `shadow-[0_0_40px_rgba(220,38,38,0.1)]` card glow. No shared `ConfirmDeleteModal` exists for either to call.

### 4e. Badge markup — present but far less pervasive than Manager (1 file vs. 9), and neither instance actually converts

`ScoringSettingsPanel.tsx` hand-rolls `badge-info` (line 91) and `badge-warning` (line 175) directly, rather than importing `Badge` from `@omniswim/ui` (0/15 files import it, confirmed above). **Checked against `Badge` directly (2026-09-13) and neither is a real convergence candidate**: line 91 is a clickable `<button>` (`onClick`, `hover:opacity-90`) styled with `badge-info`'s colors, not a static label — `Badge` renders a `<span>`; and line 175 is a full-width notice banner (`mb-4 p-3 rounded`, containing a nested paragraph and a second button), not a small inline pill — `Badge` is sized for a short inline label. Both are false positives from the raw `grep -n "badge-warning\|badge-info"` this finding was based on. Left as hand-rolled; see the whole-app doc's own §4d for the same caution applied to Manager's Badge sites.

### 4f. "Too many peer controls in one row" recurs, but Matrix is more disciplined than Manager about weighting it

`MeetOperationsView.tsx`'s meet-file row (lines 374–424) puts "Load PDF" (accent-outline — primary), a "From SwimCloud" dropdown-trigger, and "Link Psych" (both secondary, `border-theme-soft`) in one bordered container: 3 controls, but only 2 visual treatments — closer to Manager's one better-behaved instance (`RosterOptimizeStepParts.tsx`) than its undifferentiated ones. The clearer instance is self-documented in the code: `TeamCard.tsx`'s own comment (lines 1234–1236) states plainly that "in the split layout this row could not fit the sort select plus both toggles, and the trailing 'By Swimmer' label was clipped at the column edge" — a `<select>` plus a 2-button toggle plus a label, three peer-weighted controls its own author already found didn't fit at 1024px, patched with `flex-wrap` rather than reducing control count.

## 5. Prioritized shortlist

1. **✅ DONE 2026-09-14 (see `docs/reference/UI_REDESIGN_STATE.json`).**
   Converge the two live `ScoringSettings` editors (§4a). New
   `ScoringSettingsFields.tsx` owns every field; both hosts are thin chrome
   around it now. Confirmed the risk was real, not hypothetical, while
   merging: `usePdfPlacePoints` existed in the Panel only — Suite Settings
   could never toggle it. One deliberate, visible change to the Panel's own
   users: points-editing adopts the Modal's array-based UI (places-count
   select + one input per place) instead of the Panel's free-typed
   comma-separated string. Found and fixed a real latent bug while merging
   (`aFinalBracketSize` not recomputing after the "Top 24 points only"
   quick button, which a naive port would have reproduced). 9 new DOM-render
   tests.
2. **✅ DONE 2026-09-10 (see `docs/reference/UI_REDESIGN_STATE.json` turns
   t14–t15).** Split `TeamCard.tsx` (§3). Was 1,351 lines, the single largest
   file in the entire suite, already informally decomposed into 16 private
   functions plus 1 inline closure — the boundaries already existed (row/cell
   renderers, tooltip renderers), so formalizing them into sibling files was
   extraction, not redesign. Landed as four new files —
   `TeamCardTooltips.tsx`, `TeamCardMatrixRow.tsx`, `TeamCardParts.tsx`,
   `teamCardView.ts` — with `TeamCard.tsx` itself down to 766 lines. An
   opus rate-limit interruption mid-refactor left the parent file briefly in a
   broken, non-compiling state (duplicate declarations plus missing imports);
   recovered by reading the four sibling files' real exports and
   reconciling `TeamCard.tsx` against them. `npx tsc --noEmit -p
   packages/matrix/tsconfig.json` clean; full suite green (748/748).
3. **✅ DONE 2026-09-13 (see `docs/reference/UI_REDESIGN_STATE.json` turns
   t16–t17).** `SegmentedControl` convergence (§4b). Investigated first,
   not assumed mechanical: the flagged sites turned out to be **two**
   visually distinct, internally-consistent variants (Variant A —
   `MeetOperationsView.tsx`'s Diff/Prelims and vs Prelims/vs Psych,
   `ScoringSettingsPanel.tsx`/`ScoringSettingsModal.tsx`'s Merged/PDF only:
   `bg-[var(--text-accent)]/15` active state; Variant B — `TeamCard.tsx`'s
   By Event/By Class, By Event/By Swimmer, and vs Prelims/vs Psych:
   `bg-[var(--surface-strong)]/60` active state), plus 2 more "freestanding"
   sites with no shared border at all — **7 real call sites across 4 files
   in total**, not 6. Neither variant matched `SegmentedControl`'s own
   built-in look (a solid theme-neutral background, confirmed by reading
   `packages/ui/src/index.css` directly) or its full-width layout.
   User's call on which look wins: asked directly, deferred to this
   session's judgment. Chose Variant A as the one true style — it already
   covered more of the 7 sites unchanged, so fewer sites actually change
   appearance. Added a new `layout="inline"` mode to `SegmentedControl`
   (sized-to-content, static accent-tint active state, no sliding
   indicator — matching a hand-rolled toggle next to a heading rather than
   a full-width tab strip) plus per-option `title`/`ariaLabel` overrides so
   each site's original tooltip and accessible name survive the
   conversion. All 7 sites now render through it; the 2 `TeamCard.tsx`
   Variant-B sites are the only ones with a real (small, deliberate) visual
   change — their active state moves from a surface tint to the accent
   tint the other 5 sites already used, and the 2 "freestanding" sites gain
   a subtle bordered container they previously lacked, for one consistent
   look instead of three.
4. **✅ DONE 2026-09-10 (see `docs/reference/UI_REDESIGN_STATE.json` turn
   t13).** Delete `WorkspaceTabs.tsx` (§1). 41 lines, zero import sites
   anywhere in the repo — the cheapest possible cleanup, worth doing
   alongside #2/#3 so a redesign pass doesn't waste time reasoning about a
   component nothing renders.
5. **✅ DONE 2026-09-13 (see `docs/reference/UI_REDESIGN_STATE.json` turn
   t16).** Confirm-delete modal convergence (§4d). New `ConfirmDeleteModal`
   in `@omniswim/ui`, reproducing the shared markup (icon circle,
   header/close row, warning paragraph, Cancel/Confirm footer) byte-for-byte
   from the two files this item named. `DeleteConfirmationModal.tsx` and
   Matrix's own `SwimmerDeleteConfirmModal.tsx` are now thin wrappers
   supplying only their title/description/warning/confirm-label text, so
   neither of their 2 call sites (`apps/shell/src/components/WorkspaceSidebar.tsx`,
   `packages/matrix/src/components/OpsModule.tsx`) needed to change.
   **Deliberately left alone:** `packages/manager/src/components/SwimmerDeleteConfirmModal.tsx`
   — despite the identical name, it is a genuinely different interaction (a
   two-choice "hide or remove permanently" picker, not a single
   confirm/cancel), sharing only the outer icon-circle/header shell with the
   other two, not the body this convergence targeted.
6. **`Button` convergence.** 45 hand-rolled `<button>` elements across 9 of 15 files, 0 using `@omniswim/ui`'s `Button` — lower priority than #3 since most are one-off icon buttons rather than a repeated shape, but the same root cause (design-system adoption confined to charts/tags, not controls) applies.

## What this document does not claim

- It does not claim to have found every duplicated pattern in Matrix — only the ones in §4, each grep- or line-verified.
- It does not propose a `ConfirmDeleteModal` API, a merged `ScoringSettings` editor's prop shape, or any visual redesign for the items in §5 — deferred to a later phase per the whole-app doc's own phasing.
- It does not re-adjudicate the SwimCloud capture-picker duplication (`SwimCloudCapturePicker.tsx` vs. the clipboard-paste path in `OpsModule.tsx`) — that pairing is `01-UI-REDESIGN-PLAN.md`'s finding, not redone here.
- It does not cover `packages/manager` (already done, `03-MANAGER-DIAGNOSIS.md`) or `packages/metrics` — out of scope per the task.
