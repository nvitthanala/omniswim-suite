# UI redesign plan — reducing friction, not just fixing bugs

**Status: plan only, per the user's own stated minimum bar this round
("at the very least build a thorough, detailed, solid plan") against a
7-day quota down to roughly 12% remaining. Nothing in this document has
been built.** Everything in it is grounded in a real file read at the time
of writing (line counts, actual JSX structure, actual API duplication) —
not a generic UX write-up.

## 0. What actually prompted this

Two things landed in the same message from the user:

> "why not just clump all of them together and then have one large
> cohesive output" — about the crawler's per-page downloads (fixed
> separately, see [`WORKLOG-13`](WORKLOG-13-friction-fix-download-batching.md))

> "the ui looks very complex/cluttered ... i dont mind a full refresh ...
> keep the customization and accessibility features"

These are related but distinct problems. The first is an *output* problem
(234 files instead of one) — fixed. The second is a *surface area* problem:
too many screens, too many buttons, too many ways to do a similar-looking
thing, spread across two packages that don't share the code they've grown.
This document is about the second problem.

## 1. Diagnosis — grounded in real numbers, not a vibe

This session alone added or grew five components tied to the SwimCloud
capture feature. Actual line counts, read at time of writing:

| File | Lines | What it does |
|---|---|---|
| `packages/matrix/src/components/OpsModule.tsx` | 704 | Meet-loading, scoring settings, psych upload, the SwimCloud clipboard import handler, AND the new "browse captures" entry point |
| `packages/matrix/src/components/MeetOperationsView.tsx` | 771 | The view `OpsModule` renders into — now including the two-item SwimCloud dropdown |
| `packages/matrix/src/components/SwimCloudCapturePicker.tsx` | 748 | Matrix's own capture browser: pairing-token fetch, capture list, parse call, team/gender checkboxes, AND (added this session) read-only roster/swimmer-times browsing |
| `packages/manager/src/components/RosterImportWizard.tsx` | 851 | CSV import, clipboard-paste import, the roster-queue checklist, alias suggestions, AND (added this session) a second "browse captures" entry point |
| `packages/manager/src/components/SwimCloudCaptureRosterImportPanel.tsx` | 476 | Manager's OWN capture browser: pairing-token fetch, capture list, parse call, roster/gender picking, coverage display |

**3,550 lines across five files**, two of which (`SwimCloudCapturePicker.tsx`
and `SwimCloudCaptureRosterImportPanel.tsx`) do almost the same thing —
fetch a pairing token, list captures, parse one, show what's in it — for
two different downstream consumers, independently, because
`packages/matrix` and `packages/manager` cannot import each other's UI
components and the two features were built in genuinely disjoint sessions
without a shared "capture browsing" primitive to build on.

This is not a hypothetical concern. `WORKLOG-09` from this same session
already caught and had to un-do one real instance of exactly this: two
parallel agents independently built byte-identical crawl-plan URL logic in
two files before one agent noticed and collapsed onto the other's. The
picker duplication is the same failure mode at the UI layer instead of the
logic layer, and nobody has collapsed it yet.

**The user-facing symptom of all this**: a coach opening "+ from SwimCloud"
in Matrix sees a two-item dropdown (Browse captures / From clipboard) that
opens a modal with a capture list, a completeness sentence, two collapsible
read-only sections, a parse-and-filter step, and an import button. A coach
in Manager's roster importer sees FOUR entry points in the same toolbar row
(paste, CSV upload, "From clipboard," "Browse captures") plus, once a
roster capture has been chosen or pasted, a roster-queue checklist that
persists alongside a preview grid that persists alongside alias-suggestion
banners. None of this is *wrong* — every piece was added for a real reason,
argued carefully, and tested — but nobody has ever stepped back and asked
whether a coach needs to see all of it at once.

## 2. Design principles for this pass

Not inventing a house style from nothing — this repo already has one
(dark/light/custom CSS-token theming, `lucide-react` icons, a consistent
`c-card`/`btn-*`/`u-*` utility-class vocabulary carried over from
SwimCloud's own captured markup naming, ironically enough, and the
`emilkowalski/skills` set installed project-wide per `CLAUDE.md`). The
redesign should *apply* that system more consistently, not replace it.

1. **Progressive disclosure over feature-toggle proliferation.** A screen's
   default state should show the ONE thing a coach came to do. Everything
   else — read-only browsing, coverage stats, warnings — collapses until
   asked for. `SwimCloudCapturePicker.tsx` already does this correctly for
   its roster/swimmer-times sections (collapsed by default, per its own
   worklog); the rest of the surface should follow that same discipline,
   not just the newest part of it.
2. **One mental model for "browse a capture," reused everywhere it's
   needed.** Not "Matrix's picker" and "Manager's picker" as two things a
   coach has to learn separately — one capture-browsing experience,
   parameterized by what the caller wants to DO with what's inside (import
   meet results vs. import a roster's history), per §3 below.
3. **Task-oriented entry points, not tool-toggle rows.** "Add data from
   SwimCloud" should be one clearly-labeled action per screen, not a choice
   between 2-4 differently-worded buttons (Browse captures / From clipboard
   / paste / CSV) presented as equally-weighted peers when in practice one
   is the common case and the others are fallbacks.
4. **Consistent, honest status language.** This repo already has real
   discipline here — `describeCompleteness`'s refusal to ever say the bare
   word "Complete" is exactly right and should be the model for every
   status string in the redesigned surface, not just the capture picker's.
5. **Motion with restraint, per the installed skill set.** `emil-design-eng`
   (the base philosophy) and `review-animations` (the audit checklist)
   should gate any transition the redesign adds — a panel that expands
   should use the vocabulary in `animation-vocabulary` to name what it's
   doing, not invent an ad hoc easing curve. `pick-ui-library` should be
   checked before reaching for any new dependency (virtualized lists for a
   large capture's roster table, say) rather than hand-rolling one.
6. **Never remove a capability to simplify a screen.** Every existing path
   (clipboard single-page, CSV, full-crawl capture browsing) stays reachable
   — the redesign's job is arranging them so the common case is one click
   and the rest are one click further, not deleting the rest.

## 3. The core proposal: a shared "SwimCloud Capture Browser," used by both consumers

### 3a. What it replaces

`SwimCloudCapturePicker.tsx` (matrix) and `SwimCloudCaptureRosterImportPanel.tsx`
(manager) both currently:

- Fetch the pairing token (`GET /api/swimcloud/pairing-token`).
- List captures (`GET /api/swimcloud/captures`).
- Let the coach pick one and parse it (`POST .../parse`).
- Render honest completeness/coverage.
- Offer a "forget this capture" action.

They then diverge on what they DO with the parsed result — Matrix converts
`parses` (meet results) into `SwimmerResult[]` via `applySwimCloudRows`;
Manager converts `rosters`/`swimmerTimes` into `HistoricalSwim[]` via
`buildRosterImportFromCapture`. **That divergence is real and should stay
real** — the two packages have genuinely different target data models, and
`packages/core`'s architecture rule ("the domain layer never learns which
access track... produced an Entry/Result") is exactly why this repo keeps
them as separate converter modules already. The proposal is not to merge
the conversion logic. It's to merge the browsing UI in front of it.

### 3b. Where it lives

This is the plan's first real open question, not a decision — see §6.
Three candidates, argued rather than picked:

**Option A — a new package, `packages/swimcloud-ui`.** A thin UI package
that only `packages/matrix` and `packages/manager` depend on, holding the
shared browser component plus the pairing-token/capture-list/parse
plumbing. Cleanest separation, matches this repo's existing "one place
allowed to know both sides" convention (the same reasoning
`swimCloudImportBridge.ts`'s own file header gives for why IT lives in
`packages/manager` and not `packages/core` or `packages/swimcloud`). Cost:
a new package means new `tsconfig`/`package.json`/build wiring, and this
repo's own `docs/INVARIANTS.md` #7 Node-leak concern (a type-only import
pulling in `node:fs` because a browser package touched the wrong subpath)
would need the same discipline applied to a fourth package instead of two.

**Option B — the existing `@omniswim/ui` package.** Already the home of
genuinely cross-applet primitives (`FloatingWindow`, `WizardShell`,
`useToast`) — including, notably, an EXISTING SwimCloud-specific piece:
`SwimCloudContext.tsx`/`useSwimCloudWindow`, which backs
`apps/shell/src/components/SwimCloudWindow.tsx`, a draggable floating
window that already embeds `swimcloud.com` directly in an iframe for quick
reference. This is a real, already-built, already-themed floating-window
pattern this redesign could extend rather than inventing a new modal
paradigm from scratch — worth reusing the interaction pattern (drag,
resize, persisted position via `localStorage`) even if the *content* is
completely different (a capture browser, not an iframe). Cost: `@omniswim/ui`
would gain a dependency on `@omniswim/swimcloud`'s browser-safe subpaths,
which it does not have today and would need the same "never the package
root, only `./entities`/`./urlClassifier`/`./parser`" discipline every
other consumer already follows.

**Option C — keep two components, but extract a shared hook.** A
`useSwimCloudCaptureBrowser()` hook (pairing token + capture list + parse,
returned as data and actions) that both existing components call, while
each keeps its own render tree. Smallest diff, lowest risk, but does not
address the actual user complaint — a coach still sees two differently-laid-out
screens that happen to share a data layer, which fixes the code-duplication
risk `WORKLOG-09` flagged without fixing the "the UI feels cluttered and
inconsistent" complaint that prompted this whole plan.

**This plan's recommendation, not a decision**: Option B. It reuses a
pattern the app's own users are presumably already comfortable with (the
SwimCloud reference window already exists and is themed), avoids a new
package's build-wiring overhead, and treats "browse a SwimCloud capture" as
what it actually is — a suite-wide capability, not a Matrix feature or a
Manager feature that happens to exist twice.

### 3c. What the shared browser actually shows (progressive disclosure applied)

```
┌─ SwimCloud Captures ─────────────────────────────────── [×] ─┐
│  [ Meet 379295 — MPSF Championships ▾ ]      [↻] [Forget]    │  ← pick a capture; refresh; destroy
│  every-planned-page-fetched · 234 of 234 planned pages        │  ← one honest status line, always visible
│  ────────────────────────────────────────────────────────    │
│  ▸ Rosters (13 teams)                                         │  ← collapsed
│  ▸ Swimmer times (287 swimmers, 31 not captured)               │  ← collapsed
│  ▾ Meet results — Henderson State, Men          [Import ↓]    │  ← expanded IF that's why this
│      ✓ 27 swims ready · 3 relay legs excluded                 │     instance of the browser was opened
└────────────────────────────────────────────────────────────────┘
```

The component takes a `mode` prop (`'meet-results' | 'roster-history'`)
telling it which section starts expanded and which action button appears
where a result is ready — everything else stays a collapsed, honest,
read-only summary a coach can open if curious but is never forced to look
at. This is `SwimCloudCapturePicker.tsx`'s already-correct
collapsed-by-default discipline, generalized to the *whole* browser instead
of only its newest two sections.

## 4. Entry points — one per screen, not a row of peers

**Matrix (`OpsModule`/`MeetOperationsView`)**: replace the current two-item
"+ from SwimCloud" dropdown with one button, "Add from SwimCloud," that
opens the shared browser in `meet-results` mode. The existing clipboard
path does not disappear — it becomes a small, secondary "paste a single
page instead" link inside the browser's own empty-state (`"No captures
yet — auto-fetch with the extension, or paste a single page below"`),
so a coach who only has one page to add is not made to feel like they're
using an inferior/hidden path, but the DEFAULT affordance is the capability
that scales.

**Manager (`RosterImportWizard`)**: same treatment. Today's toolbar row
(Paste / Upload CSV / From clipboard / Browse captures — four peers) becomes
two: "Add from SwimCloud" (opens the shared browser in `roster-history`
mode) and "Paste or upload" (today's existing paste/CSV toggle, already a
reasonable single control). The roster-queue checklist stays exactly as it
is today — it is genuinely useful, honest, incremental UI, and the "single
swimmer captured, still needs the rest" case it handles is real and not
going away just because the bulk path exists now.

## 5. Accessibility and customization — non-negotiable, explicitly enumerated

Per the user's explicit instruction to preserve these. What exists today,
which must survive:

- **Theming**: every color in the code touched this session uses CSS custom
  properties (`var(--text-primary)`, `text-theme-secondary`,
  `border-theme-soft`, etc.), never a hardcoded hex value — confirmed
  directly in `SwimCloudCapturePicker.tsx`'s own worklog report ("no
  hardcoded colors were introduced"). The shared browser component must
  hold to the same rule from its first line of code, not retrofit it later.
- **Dark / light / system theme**: per `CLAUDE.md`'s artifact-design rules
  (which apply to this app's own UI, not just published artifacts) —
  `:root` tokens, redefined under `prefers-color-scheme` and
  `[data-theme]`, never a single hardcoded palette.
- **ARIA labeling**: every interactive element touched this session already
  carries a real `aria-label` (`"Browse SwimCloud captures"`,
  `"Refresh capture list"`, `"Forget capture {name}"`) — the redesign's
  button/panel inventory should be audited against this same standard, not
  assumed to already meet it just because the old buttons did.
- **Keyboard navigation**: the existing modals are real DOM elements with
  `role="dialog"`, not `div onClick` soup — confirm this holds for whatever
  new floating-window pattern replaces the current modal (a `FloatingWindow`
  reused from `@omniswim/ui`, if Option B is chosen, needs the same
  dialog-role/focus-trap audit as the modals it replaces, not an assumption
  that reusing an existing component means accessibility comes free).
- **No motion that can't be turned off or reduced** — apply
  `review-animations`'s checklist, which per the installed skill set
  already accounts for `prefers-reduced-motion`.

## 6. Open questions for the user — genuinely open, not decided here

1. **Option A vs. B vs. C from §3b** — which tradeoff matters more: a
   clean new package boundary (A), reusing the existing floating-window
   pattern (B), or the smallest possible diff (C)? This plan recommends B
   but the call is the user's.
2. **Does "Add from SwimCloud" replace the existing clipboard button
   entirely as the primary action, or should the two stay visually equal
   weight?** Some coaches may have a strong single-page-at-a-time habit
   from the original feature; demoting that path to a secondary link could
   feel like a regression to them specifically, even though it scales
   worse for a whole-meet import.
3. **Should the roster-queue checklist (Manager) get folded into the shared
   browser's UI, or stay a separate, persistent element in
   `RosterImportWizard` as it is today?** It currently survives across
   multiple browser-open/close cycles (a coach can browse a capture, import
   what's covered, close the browser, and still see the checklist for
   what's left) — folding it into the browser itself would need that same
   persistence-across-close behavior rebuilt, not assumed.
4. **How much of this should be one big cutover vs. an incremental
   migration?** Given the review-and-fix pattern this whole session has
   used (build small, verify, iterate), this plan leans toward Phase 1
   (§7) being shippable and useful on its own, with Phases 2-3 genuinely
   optional follow-ups — but if the user wants a single "before/after"
   moment instead of an incremental rollout, that changes the phasing.

## 7. Phased build plan, mapped to this repo's own delegation model

Per `CLAUDE.md`'s agent table: schema/data-shape decisions to `executor`,
UI wiring against an already-reported API to `worker`, mechanical
verification to `finisher`. Every phase below states which.

**Phase 1 — the shared browser component itself** (`executor`, because it
involves a real API-shape decision: the `mode` prop, what the two callers
need from it, and the Option A/B/C package-boundary call in §3b). Build it
functionally correct and tested against the real `/api/swimcloud/*`
contract already in place — no visual redesign required yet, just the
consolidation. Both `SwimCloudCapturePicker.tsx` and
`SwimCloudCaptureRosterImportPanel.tsx` get deleted once their callers are
re-pointed at the shared component; nothing about the underlying
`/api/swimcloud/*` HTTP contract changes.

**Phase 2 — entry-point consolidation** (`worker`, UI wiring against
Phase 1's reported API). `OpsModule.tsx`'s two-item dropdown and
`RosterImportWizard.tsx`'s four-button row both collapse to one primary
"Add from SwimCloud" action plus a demoted secondary path, per §4.

**Phase 3 — visual pass** (`worker`, restyle-shaped, explicitly the
`review-animations`/`emil-design-eng` skill's territory). Once the
structural consolidation is real and tested, THIS is where motion,
spacing, and visual hierarchy get actual design attention — not before,
because redesigning the visuals of two components that are about to be
deleted (the old pickers) would be wasted work.

**Phase 4 — finishing pass** (`finisher`). Lint, full suite, production
build, and a genuine accessibility audit against §5's checklist —
mechanical verification only, no new design decisions.

Each phase should land fully tested and reported before the next starts,
per this session's own standing "no half-broken handoff" discipline —
`docs/reference/SWIMCLOUD_CAPTURE_STATE.json`'s phase-tracking convention
should be extended with these four as new phase entries once any of them
actually starts.

## 8. What this plan deliberately does not do

- It does not touch `packages/metrics` or anything outside the SwimCloud
  capture surface — "the UI looks cluttered" was said in the context of
  this exact feature, and generalizing to a whole-app redesign without
  being asked would be scope invention this project's own rules warn
  against.
- It does not propose changing the underlying `/api/swimcloud/*` HTTP
  contract, the parsers, or the crawler — all of that is real, tested,
  working infrastructure from this session; the problem being solved here
  is entirely at the presentation layer.
- It does not pick Option A/B/C for §3b, or resolve any of §6's four
  questions. Those are the user's calls, surfaced honestly rather than
  guessed at, per this project's own standing rule against inventing
  product shape without asking.
