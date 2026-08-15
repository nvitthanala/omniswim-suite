# 05 — UX and workflow

The stated problem from the roadmap's user answers is still the right frame:
*"the flow and viewing is confusing to the uninitiated"*, and **every panel is in
use** — so this is ordering, naming and disclosure, never deletion.

Workstream C delivered the wizard shells and they work well. What follows is what
is left.

---

## 1. The demo workspace is called "Blank Workspace 1"

**Severity: P1. Cheapest high-value fix in this folder.**

Current state of the two live workspaces:

| Name | Meet loaded | Roster work |
| ---- | ----------- | ----------- |
| `Blank Workspace 1` | ✅ 2026 NSISC Championships Final Results | 39 recruits, 18 plans, 40 relay leg overrides, 6 aliases |
| `HSU 2026-27 Roster Plan` | ❌ none | 214 recruits, 67 plans, 313 changes |

The workspace holding the actual championship meet is named `Blank Workspace 1`,
and it is not blank. The well-named one has no meet. Anyone opening this cold —
which is the whole "uninitiated" premise — gets it backwards.

**Proposed:**
- Rename to something like `NSISC 2026 Championships (scored)`. One edit.
- Auto-name a workspace from the meet PDF on load. `workspace.loadedMeet.pdfFilename`
  is right there, and `conference` is already detected from the PDF. A workspace
  that has been given a meet should stop calling itself blank.
- Show the loaded meet name in the sidebar row beneath the workspace name, where
  the date currently sits alone.

**Effort:** 10 minutes for the rename, ~2 hours for auto-naming.

---

## 2. Nothing explains *why* an event was chosen

**Severity: P1.** Partly addressed today, deliberately incomplete.

Today's ranking change (`350a42a7`) reorders every athlete's events. The roster
tooltip now says *"Strongest first, vs the published D2 standard"* with each
percentage. That is a start, but the **ordering is invisible** in the primary
view — the label just reads `1650 Freestyle · 500 Freestyle · 1000 Freestyle`
with no indication that the order is meaningful or what it means.

This matters more than usual because the order **changed today**. A coach who
knew the old output will see different events and needs to know why.

**Proposed:**
- Show the ratio inline for the top event, e.g. `1650 Free (99% of D2 std)`.
- On the athlete drawer, show the full ranked list with ratios — the data is
  already on the profile (`qualityByEvent`).
- Where `unrankedEvents` is non-empty, say so explicitly rather than letting
  those events sit silently at the end of the list.

**Effort:** ~half a day. **Value:** turns a silent algorithm change into a
legible one.

---

## 3. First-run guidance exists but the second run does not

**Severity: P2.**

Workstream C4 added empty states that name the next action, and they work — the
Matrix `Load` step shows *"Load a meet PDF to begin"*, and today's fix gave the
Manager steps a working team picker instead of a dead end.

What is missing is the state *after* the first action. A coach who has loaded a
meet and lands on `2. Score` gets a dense panel with no indication of what is
normal. The NSISC preset is auto-suggested from the detected conference — a good
behaviour that is nearly invisible.

**Proposed:** a one-line "what just happened / what is next" strip per step,
stating what the app inferred and how to override:

> *NSISC detected from the PDF — scoring preset applied (20-17-16, 7 events per
> swimmer). Change below if this meet ran differently.*

**Effort:** ~half a day across 8 steps (4 Matrix, 4 Manager).

---

## 4. Tap targets below the accessible minimum

**Severity: P2.** Measured across all screens.

| Control | Size | Where |
| ------- | ---- | ----- |
| Checkboxes (scorer toggles) | 13 × 13 px | Manager Lineup — 8 visible at once |
| `Load & save` | 57 × 15 px | Matrix Score |

WCAG 2.5.8 asks for 24 × 24 CSS px minimum. These are native `<input
type=checkbox>` at browser default. The scorer checkbox is a high-frequency
control — toggling scorers is core to the Lineup step — and 13 px is small for
repeated precise clicking even with a mouse.

**Proposed:** style the checkbox to 16 px with a 24 px hit area via padding, and
give `Load & save` normal button padding. **Effort:** ~1 hour. **Risk:** none.

---

## 5. Things verified as already good

Recorded so they are not re-litigated:

- **No horizontal overflow** at 1024 / 1280 / 1440 / 1920 on Manager and Matrix,
  verified after today's layout fixes.
- **No console errors, no failed API calls** on any screen.
- **ARIA tabs are correct** — `aria-selected`, `aria-controls`, matching
  `role="tabpanel"`, `aria-labelledby`, roving `tabindex`. Keyboard operable.
- **Every control has an accessible name** as of `ad616e69` (was 5 relying on
  `title` alone).
- **Both wizard shells** (Manager 1-4, Matrix Load→Score→Standings→Analyze) put
  inputs before outputs. The reading-order defect from the roadmap is fixed.
- **Dark/light/custom tokens** hold; light mode renders correctly.

---

## 6. Open question: who is the second user?

`SUITE_ROADMAP.md` §9 asked *"Who are the 'uninitiated' — assistant coaches,
athletes, other programmes?"* and it is still unanswered. It governs several
choices above:

- An **assistant coach** who uses it weekly needs #2 (explain the ranking) far
  more than #3 (per-step guidance).
- **Another programme** evaluating the tool needs #1 (sane workspace names) and
  #3, and needs the Matrix screen to be self-explanatory without you present.
- An **athlete** needs almost none of this and a very different read-only view.

Worth answering before spending the half-days.
