---
name: cyclomatic-complexity
description: Refactor code to reduce cyclomatic complexity (branching) while preserving behavior — guard clauses, function extraction, lookup tables, named predicates. Use when asked to refactor, simplify, "reduce complexity", or clean up branchy/nested code, or when reviewing a diff for complexity.
---

# Cyclomatic Complexity Skill

Source: https://github.com/saurabhkumar8112/cyclomatic-complexity-skill
(Installed manually — `/plugin` is unavailable in this environment, so this file
reproduces the skill's methodology as a project-level skill instead of a plugin.)

Targets code that "works, but branches like a jungle." The goal is lower branching
complexity with **zero behavior change** — never a rewrite for its own sake.

## Measurement

CC = decision points + 1. Decision points: `if`, `else if`, `case`, loops, `catch`,
ternary, `&&`, `||` in a condition.

Thresholds:
- 1–5: acceptable, leave alone
- 6–10: monitor; refactor only if you're already modifying the function
- 11–15: refactor immediately
- 15+: mandatory refactor

Tools by language: Python `radon cc -s -a`; JS/TS eslint's `complexity` rule; Go
`gocyclo`; `lizard` works across languages when nothing project-specific exists.
Honor whatever threshold the project's own linter config already sets rather than
importing a stranger's number.

## Refactoring strategies, in priority order

1. Guard clauses with early returns to cut nesting.
2. Extract functions with descriptive names — the name should make a comment
   unnecessary.
3. Replace conditional chains with lookup tables / maps.
4. Name complex boolean expressions as predicates (`const isEligible = …`) instead
   of inlining them in an `if`.
5. Polymorphism in place of repeated type-switching, where the codebase already has
   the structure for it — don't invent a class hierarchy just to dodge a switch.
6. Flatten nested loops.

## Critical constraints

- **Preserve all existing behavior.** Every refactor needs a test (existing or
  newly written) that passes before and after, and actually exercises the changed
  branches — not just "the file still imports."
- **Never game the metric.** Complexity moves into well-named functions, not into
  clever one-liners, ternary chains, or `&&`/`||` short-circuit tricks that hide
  branches from the counter instead of removing them.
- **Maintain API contracts.** Exported signatures, return shapes, and error
  behavior stay the same unless the task explicitly asks to change them.
- **Single purpose per function.** An extracted function should do one
  describable thing.
- Real, load-bearing complexity is not automatically a defect. A scoring or
  eligibility function with many branches because the *domain* has that many
  real cases is a candidate for extraction and better names, not for being
  argued away — don't delete a branch that encodes a real rule just to lower a
  number.

## Required output per function refactored

- A before/after complexity table (function name, before CC, after CC).
- A list of any new functions extracted, with a one-line description of each.
- How behavior was verified (which tests, and confirmation they passed both
  before and after — run them, don't assume).
