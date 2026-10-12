---
paths:
  - "packages/{ui,manager,matrix,metrics}/**/*.{tsx,css}"
  - "apps/shell/**/*.{tsx,css}"
---

<!-- Moved from CLAUDE.md on 2026-10-11 so that core and backend sessions do not load it. -->

# UI craft and design system

Twelve skills from [emilkowalski/skills](https://github.com/emilkowalski/skills)
are installed project-wide (`npx skills@latest add emilkowalski/skills`,
symlinked into `.claude/skills/`, canonical copies in `.agents/skills/`).
Route UI/animation work to them the same way `cyclomatic-complexity` is
routed for complexity work — they should trigger on their own; invoke
explicitly if they don't.

Applicable to this repo (a React/Vite web monorepo — `packages/ui`,
`manager`, `matrix`, `metrics`, `apps/shell`):

| Skill | Use for |
| --- | --- |
| `emil-design-eng` | The base philosophy — animation framework, component principles, performance, accessibility. Read this first. |
| `animate` | Building a specific animation from a request — gates *whether* it should animate before *how*. |
| `review-animations` | Auditing a diff's motion against the rules before it ships. |
| `improve-animations` | Read-only codebase-wide audit, prioritized findings, no edits. |
| `find-animation-opportunities` | Sweeping an interface for places motion is missing, with the same restraint gate. |
| `animation-vocabulary` | Turning a vague motion description into the precise term. |
| `pick-ui-library` | Curated picks for toasts, dropdowns, virtualization, drag-and-drop, charts, state, styling — check before hand-rolling or adding a new dependency. |
| `apple-design` | Interruptible, velocity-aware motion for anything gesture-driven (drag, swipe-to-dismiss); the eight design principles for feature-level decisions. |
| `prototype` | Building 3-5 genuinely divergent variants of one component behind a picker, in isolation from production code. |
| `ask-sonner` | This repo doesn't use Sonner today; `pick-ui-library` will surface it if a toast need comes up. |

Installed but not applicable here — kept for completeness, not for use:
`animate-expo` (React Native/Expo) and `write-swift` (native Swift).

**How to apply to work already done:** route `worker` (sonnet) for
restyle-shaped application against `packages/ui` and other shared
primitives, with the acceptance bar from `review-animations` — never apply
motion changes to `packages/core`, `backend/`, or anything on the scoring
data-path. Same rule as everywhere else in this file: additive, Dark/Light/
custom tokens preserved, lint + tests green, no git operations by the
subagent.
