# UI redesign, whole app — scope pivot from the SwimCloud-only plan

**Status: plan only. Nothing in this document has been built.**

This document extends
[`plans/2026-09-09/01-UI-REDESIGN-PLAN.md`](../2026-09-09/01-UI-REDESIGN-PLAN.md)
rather than replacing it. That plan's diagnosis, numbers, and the shared
capture-browser proposal all stand — treat it as the fully-detailed **Phase
1 case study** of the pattern this document now addresses app-wide. Do not
re-derive its content; read it first if you haven't.

## 0. What changed and why

The 2026-09-09 plan was deliberately scoped to the SwimCloud capture
surface only, because that was the concrete complaint at the time (§8 of
that doc says so explicitly). On 2026-09-10, asked to revisit it, the user's
own framing — "work on the ui" — read broader than that scope, so it was
asked directly rather than assumed. Answer: **broaden to the whole app
now.**

Two more decisions landed in the same round, both **confirmed, not
recommendations**:

- The shared capture-browser component (2026-09-09 plan §3b, "Option
  B") reuses **`@omniswim/ui`**, the existing shared package — not a new
  package, not a hook-only split. Decided.
- "Paste a single page" (the original clipboard import) becomes a
  **secondary link** in the capture browser's empty state, not an
  equal-weight button. Decided.
- The Manager roster-queue checklist **stays a separate, persistent
  panel** — it is not folded into the capture browser. Decided.

The user also pasted a list of personal design-inspiration bookmarks
(Mobbin, component.gallery, ui.shadcn.com, beautifului.dev, 60fps.design,
transitions.dev, and others) with the instruction to make the result "look
more organized, neat, with some clear flow and generally acceptable
logic." Read as direction on **quality bar and restraint**, not a request
to copy any one site's specific look: the common thread across that list is
systematic, componentized, low-ornament interface design — exactly what
`packages/ui` already is (see §2) and exactly what this repo's own
artifact-design discipline independently calls for (its "avoid AI-generated
design" list flags the generic templated look this repo should not produce
either). §4 below is the concrete design-language response.

## 1. Whole-app diagnosis — grounded, not a vibe

Same discipline as the 2026-09-09 plan: real numbers, read at time of
writing, not an impression.

### 1a. The suite's actual shape

Three applets behind one shell (`apps/shell`), switched by a segmented nav
(`AppletNav.tsx`):

| Applet (package) | Component files | Total lines |
| --- | --- | --- |
| `packages/matrix` | 15 | 5,618 |
| `packages/manager` | 51 | 13,043 |
| `packages/metrics` | 14 | 2,672 |
| `packages/ui` (shared kit) | 17 | 1,129 |

Manager is nearly 2.5x Matrix's surface and almost 5x Metrics's — it is
where the real weight of any whole-app pass lives, both in screen count and
in the density of each screen (see §1c).

### 1b. The shared design-system kit exists and is under-adopted

`packages/ui` is a real, working component kit, not a plan for one:
`Button`, `Badge`, `Toast`, `EmptyState`, `SegmentedControl`, `ChartShell`,
`WizardShell`, `ThemeToggle`, `CutlineTag`, `AppletSkeleton`,
`FloatingWindow` (a genuine draggable/resizable `role="dialog"` primitive,
already used for the SwimCloud reference window), `SwimCloudContext`. This
is not a green-field design-system project — **it is a finish-adopting-it
project**, which is the concrete form the user's "reuse the old package...
make it look organized" instruction takes:

| Package | Component files importing `@omniswim/ui` |
| --- | --- |
| `packages/matrix` | 5 of 15 (33%) |
| `packages/manager` | 26 of 51 (51%) |

Neither package is fully on the shared kit. Matrix specifically is the
lower-adoption, higher-risk side: its two largest files
(`TeamCard.tsx`, 1,351 lines — the single largest component in the entire
suite — and `MeetOperationsView.tsx`, 771 lines) build their own tooltips,
cell renderers, and inline-edit forms as private sub-functions in the same
file rather than importing shared primitives or splitting into siblings.

### 1c. A real, pre-existing convention Matrix doesn't follow

Manager already has an internal answer to "a component got too big":
split it into `Thing.tsx` + `ThingParts.tsx` (sometimes + `ThingBody.tsx`
or `ThingSections.tsx` for a third layer). Real examples on disk today:
`RosterCatalogPanel` + `RosterCatalogPanelParts`, `RosterOptimizeStep` +
`RosterOptimizeStepParts`, `ScenarioSnapshotsPanel` + `...Parts`,
`BaselineDiffPanel` + `...Parts`, `RosterScoringSetup` + `...Parts`,
`LineupComplianceChecklist` + `...Parts`, and a three-layer version for
cross-course arbitrage (`Panel` + `Sections` + `Body` + `Parts`). This is a
real, working, already-battle-tested pattern for exactly the "one file
does five things" problem the 2026-09-09 plan found in the SwimCloud
pickers — Matrix just never adopted it. **Normalizing Matrix onto Manager's
own existing convention is lower-risk than inventing a new one**, and is
this document's concrete recommendation for the "clear flow and generally
acceptable logic" instruction — see §4.

### 1d. The global header is the app-wide version of the SwimCloud
### pickers' "too many peers" problem

`apps/shell/src/components/SuiteHeader.tsx` renders, in one 64px row, on
every screen in the suite: the applet switcher (3 tabs), a gender toggle
(workspace screens only), a command-palette button, a season-analytics
link, the auth control, the theme toggle, a settings link, the SwimCloud
reference-window toggle, a scoring-settings button (workspace screens
only), a workspace-name badge, and a pulsing "system ready" dot — **eleven
distinct interactive/status elements**, unconditionally on the highest-
traffic, most space-constrained surface in the app. This is the same
"task-oriented entry points, not a row of peers" principle the 2026-09-09
plan already argued for the SwimCloud dropdown (§2.3 there), just not yet
applied to the piece of UI every single screen inherits. See §3 for the
mockup and §5 Q1 for the open call on how far to collapse it.

## 2. What this document does NOT claim

Being honest about what one grounding pass can and cannot cover:

- **This is not a per-screen redesign of all 51 Manager components or all
  15 Matrix components.** That would take a dedicated diagnosis pass per
  applet (file-by-file, the way the 2026-09-09 plan did for exactly five
  SwimCloud-related files) before it could be "solid" rather than guessed.
  §6 proposes an order to do that in, not a finished result for each one.
- **It does not claim to have found every duplicated UI pattern in the
  suite** — only the one already proven (the two capture pickers) and the
  one made visible by a line-count/import-adoption pass (Matrix's missing
  Panel+Parts convention). A real per-applet pass may find more; it should
  be looked for, not assumed absent because this pass didn't hit it.
- **It does not pick a final shape for the header** (§5 Q1) or commit to
  redesigning Metrics, which is smaller and was not called out in either
  the original complaint or this session's numbers as a pain point.

## 3. What this physically looks like — see the artifact

The published mockup from this session now has a third section covering
this: <https://claude.ai/code/artifact/119ac765-faed-4acf-ab5c-0504503e63be>
(same link as before — republished in place, not a new artifact). It shows,
click-through and real (not static screenshots):

- The current 11-element header row, reproduced faithfully.
- A decluttered proposal: applet nav, workspace name, and theme toggle stay
  always visible; auth, command palette, and the SwimCloud reference window
  move into a single overflow menu; scoring settings and the gender toggle
  stay conditional on workspace screens exactly as today (they are already
  correctly conditional, not part of the clutter).
- The SwimCloud capture-browser tabs from the 2026-09-09 plan, unchanged,
  now updated to show the three confirmed decisions from §0 as the
  shipped behavior rather than an open variant.

## 4. Design language — responding to the pasted references without copying one

Read as a quality-bar instruction (§0), not a mood board to reproduce
literally. Concrete, checkable commitments instead of an adjective list:

1. **Every new or touched surface imports from `@omniswim/ui` before
   writing a one-off `<button>` or card.** If a needed primitive doesn't
   exist there yet (an overflow menu, for the header — see §5 Q1), it gets
   added to `packages/ui` once and reused, the same discipline
   `pick-ui-library` already asks for external dependencies, applied
   internally.
2. **One accent, spent deliberately.** The suite already has a working
   theme-token system (`var(--text-primary)`, `var(--surface-muted)`,
   `var(--border)`, per `SuiteHeader.tsx`'s own class list) — this pass
   audits for stray hardcoded colors the same way the SwimCloud picker
   worklog already did for its own files, rather than introducing a second
   palette.
3. **Density before decoration.** A coach's screens (Matrix's team matrix,
   Manager's roster tables) are working data surfaces, not marketing pages
   — `font-variant-numeric: tabular-nums` on every numeric column, real
   status chips (already used correctly in the SwimCloud picker's
   completeness line) instead of color-only signals, no motion that isn't
   load-bearing. This is the `emil-design-eng`/`review-animations` skill
   pair's own standard, restated for this specific app.
4. **No component gets flashier just because it's being touched.** The
   goal is fewer, more consistent surfaces — a redesigned panel that now
   has a gradient header or a new animation nobody asked for is scope
   creep, not polish.
5. **The logo does not change, full stop** — stated explicitly by the user
   when reviewing the header proposal. `SuiteHeader.tsx`'s existing
   `<img src="/OMNISWIMLOGO.png">` block is untouched by any phase of this
   work, including the header consolidation in §6 Phase 1.

## 5. Open questions — status as of 2026-09-10, second round

1. **The header overflow menu (§1d, §3): what goes in it vs. stays
   always-visible?** **Decided: the straw-man split shown in the artifact
   is accepted as-is** — applet nav, workspace name, and theme toggle stay
   always visible; auth, command palette, and the SwimCloud reference
   window move into "More." **Constraint, stated explicitly: the logo does
   not change.** The artifact's mockup used a placeholder emoji in place of
   the real `/OMNISWIMLOGO.png` image purely because a mockup can't embed
   the real asset — that was never a proposal to replace it, and the real
   build must keep the existing logo file untouched.
2. **Order of applets for a real per-screen diagnosis pass (§2, §6).**
   **Decided: Manager first** — largest surface (51 files, 13,043 lines),
   most screens, most likely to hold more instances of the duplication
   pattern already found once. Matrix and Metrics follow in an order to be
   set once Manager's own pass is done.
3. **Does "whole app" include `apps/shell`'s own chrome** (the header,
   `WorkspaceSidebar.tsx`, `CommandPalette.tsx`)? **Decided: yes**, first-
   class scope, not a fixed frame. §1d's header proposal is real scope, not
   illustrative-only.
4. **How literally should the Matrix→Manager Panel+Parts convention be
   applied?** **Decided 2026-09-13: only when a component is already being
   touched for another reason** — the leaning default above, confirmed by
   the user rather than assumed. `TeamCard.tsx`'s split (Phase 2.5 below)
   is exactly this: it was already the Matrix diagnosis's shortlist item
   #2, touched for its own sake, not swept in alongside unrelated work.

## 6. Proposed phasing (supersedes 2026-09-09 §7's phase list; extends it, not replaces it)

Per `CLAUDE.md`'s delegation table — schema/structural decisions to
`executor`, UI wiring against a reported API to `worker`, mechanical
verification to `finisher` — and per this repo's own "assess partial work,
never trust it" discipline: each phase ships fully tested before the next
starts, and `docs/reference/UI_REDESIGN_STATE.json` gets one entry per
phase once it actually starts, not before.

**Phase 0 — per-applet diagnosis passes — COMPLETE.** All three applets
diagnosed, each cross-checked against the others' named patterns rather
than three siloed audits: [`03-MANAGER-DIAGNOSIS.md`](03-MANAGER-DIAGNOSIS.md),
[`04-MATRIX-DIAGNOSIS.md`](04-MATRIX-DIAGNOSIS.md),
[`05-METRICS-DIAGNOSIS.md`](05-METRICS-DIAGNOSIS.md). Real
`@omniswim/ui` visual-adoption, corrected for hook-only imports: Manager
23.5%, Matrix 26.7%, Metrics 28.6% (needed no correction — its one
`useToast` call sits outside its `components/` scope entirely). Each doc
ends with its own ranked shortlist; Phase 4+ (below) draws from these
rather than guessing at problems a real read hadn't found yet.

**Phase 1 — shell/header consolidation — COMPLETE.** New `Menu`/`MenuItem`
overflow primitive landed in `@omniswim/ui`; `SuiteHeader.tsx` moved auth,
command palette and the SwimCloud reference window into a "More" menu,
logo unchanged per the hard constraint. Caught and fixed a real bug along
the way: `MenuItem` was spreading `onSelect` onto a native `<button>`
where it silently bound to the unrelated text-selection DOM event instead
of firing on click — 3 of 5 relocated controls were dead until fixed. See
`docs/reference/UI_REDESIGN_STATE.json` turns t11–t13 for the full record.
Still needs the user's own visual pass in a running app (Dark/Light/custom
theme) and a decision on the Suite Settings placement (a `worker` judgment
call, never explicitly confirmed).

**Phase 2 — SwimCloud capture browser — COMPLETE.** `SwimCloudCaptureBrowser`
landed in `@omniswim/ui`, replacing `SwimCloudCapturePicker.tsx` (Matrix) and
`SwimCloudCaptureRosterImportPanel.tsx` (Manager), both deleted. Wired into
`OpsModule.tsx`/`MeetOperationsView.tsx` (Matrix, `mode="meet-results"`) and
`RosterImportWizard.tsx` (Manager, `mode="roster-history"`), each toolbar
collapsed to one "Add from SwimCloud" button per §0's decided entry-point
consolidation; the clipboard-paste path is now the browser's own demoted
empty-state fallback link, never a peer button. An opus rate-limit
interruption left the component built but unexported and unwired; recovered
and completed in the same session. Three test files needed rewriting against
the new shared DOM shape (`tests/rosterImportWizardCaptureRoster.test.ts`,
`tests/swimCloudCapturePicker.test.ts`, `tests/rosterImportWizardClipboardRouting.test.ts`)
— all passing. See `docs/reference/UI_REDESIGN_STATE.json` turns t14–t15.
Still needs the user's own visual/behavioral pass in a running app.

**Phase 2.5 — ad-hoc design-system convergence, drawn from each diagnosis
doc's own shortlist rather than a numbered phase — COMPLETE for the items
listed.** `TeamCard.tsx` split into named sibling files (Matrix shortlist
#2 — the Panel+Parts convention, applied because the file was already
being touched, per §5 Q4's now-decided default). Badge converged at 7
real sites across Manager and Metrics (with 2 files deliberately left
alone — a different chip shape, not Badge's). New `ConfirmDeleteModal` in
`@omniswim/ui` replacing Matrix's two duplicated dialogs. `VideoPlayer.tsx`
(Metrics' one real monolith) split the same way `TeamCard.tsx` was. Added
`tailwind-merge`/`clsx` + a `cn()` helper to `@omniswim/ui` so a caller's
size-override `className` reliably beats a shared component's own
conflicting class — the plain string-join `Badge`/`Button` used before
could not guarantee that.
**SegmentedControl convergence investigated and declined** (Matrix's 6
sites, Metrics' 1): none of the 7 hand-rolled sites share the shared
component's own active-state look, and there are 3 real distinct designs
in play, not cosmetic variants of one. Blocked on a real design decision,
not mechanical — see `04-MATRIX-DIAGNOSIS.md` §5 item 3 and
`05-METRICS-DIAGNOSIS.md` §5 item 2 for the full finding. Full record in
`docs/reference/UI_REDESIGN_STATE.json` turn t16.

**Phase 3 — Matrix Panel+Parts normalization** (`worker`, mechanical
restructuring against an already-existing convention, not a new one to
invent — see §1c). Scope decided (§5 Q4): only when a component is
already being touched for another reason — not a standalone sweep.

**Phase 4+ — per-applet redesign passes**, one per Phase 0 diagnosis,
scoped and planned only once that applet's own numbers are in hand. Not
detailed here — doing so now would be guessing at problems a real read
hasn't found yet, which is exactly what §2 says this document does not do.

## 7. State tracking

`docs/reference/UI_REDESIGN_STATE.json` — one entry per turn/session,
covering exactly what was done, what's still open, and where to resume.
Read it before continuing this work in a new session; it is the source of
truth over this document's prose if the two ever drift, per this repo's
"Long-horizon task state" convention.
