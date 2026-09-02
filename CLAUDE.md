# Omniswim Suite — Claude Code Instructions

## Response & Writing Style

This rule covers three things: chat replies, commit messages, and docs. Use
plain words. Keep sentences short. Say one thing per sentence. Prefer active
voice ("the parser drops the row" not "the row is dropped by the parser").
Use the same term for the same thing every time — do not swap "swimmer" for
"athlete" for "competitor" in one passage. Spell out an acronym on first use.

Sources: [ASD-STE100 / Simplified Technical English](https://www.asd-ste100.org/)
and the [Google developer documentation style guide](https://developers.google.com/style).

**Commit messages** — apply both of these on every commit in this repo:
[tbaggery, "A Note About Git Commit Messages"](https://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html)
and [cbea.ms, "How to Write a Git Commit Message"](https://cbea.ms/git-commit/).

1. Subject line first, then a blank line, then the body.
2. Subject: 50 characters or fewer. No period at the end.
3. Subject: imperative mood — "Fix the race", not "Fixed the race" or "Fixes the race".
   Test it by finishing the sentence "If applied, this commit will ___."
4. Body: wrap at 72 characters.
5. Body: explain what the change does and why. Skip the how — the diff shows that.

**Docs and chat replies** — apply STE and the Google style guide:

- One idea per sentence. Split any sentence that has "and" joining two instructions.
- Write steps as commands to the reader: "Run the script," not "The script should be run."
- Cut filler words — "in order to", "please note that", "it should be noted".
- Say what the code does, not what you did to it, in commit/PR bodies and doc prose.
- Skip hedging ("might", "could potentially") when you know the answer.

## AI Orchestration & Sequencing

**Standing delegation model for this project:**

- **Fable (orchestrator):** Plan, brief, sequence, integrate, verify end-to-end. Split work into disjoint scopes.
- **Opus (core complexity):** High-level tasks requiring architectural thinking (core scoring logic, arbitrage, roster/lineup correctness, algorithm proofs).
- **Sonnet (UI/worker):** Frontend restyles, component wiring, boilerplate, documentation against a specified API.
- **Haiku (proof-reading/finishing):** Edge cases, lint/test verification before ship.

**How to apply:**

- Land Opus core work first (lint + tests green) before Sonnet UI against the reported API.
- Keep concurrent agents in disjoint package scopes (e.g., `packages/core` serial, `packages/manager` parallel).
- No git operations (commits, pushes, branches) — agents work on diffs only.
- All work: lint + tests green, additive APIs, Dark/Light/custom tokens preserved.
- Session limits: Order Opus prompts by priority so partial work is resumable; check working tree before re-spawning.

**Why:** Preserves quota and quality; Opus runs have historically hit session limits, so resumability matters.

### Delegation contract (enforced via `.claude/agents/`)

The model above is now configuration, not just prose. Four agent definitions exist:

| Agent | Model | Effort | Tools | Owns |
| --- | --- | --- | --- | --- |
| `orchestrator` | fable | high | read-only + `Agent(executor, worker, finisher)` — **no Edit/Write** | Sequencing, briefing, integration, end-to-end verification |
| `executor` | opus | xhigh | all | Schema/type design, scoring + lineup correctness, extraction pipelines, algorithms |
| `worker` | sonnet | medium | all | Component wiring, restyles, panel layout, docs against an existing API |
| `finisher` | haiku | low | Read, Grep, Glob, Bash, Edit | Lint/typecheck/tests, mechanical edge cases — **no design decisions** |

Invoke with the `Agent` tool, e.g. `subagent_type: "executor"`. Route by stakes:
schema design goes to `executor` even when it looks small; a class rename goes to
`worker` even when it touches many files.

`orchestrator` is deliberately denied Edit/Write so planning and execution cannot
blur. It briefs the others and verifies their output rather than trusting reports.

**Briefs must stand alone.** A subagent starts cold — include file paths, the exact
API it may rely on, the acceptance test, and the scope boundary. `executor` must
report its final API surface (exports, types, signatures) because `worker` builds
against that report without reading the diff.

### Cross-provider delegation (the fleet)

The table above is the **Claude-internal** layer: those agents share this session's
context and are the right call for anything that depends on the conversation so far.

The **fleet** is the cross-provider layer. It reaches Codex (GPT-5.6-Terra, Luna,
GPT-5.5, GPT-5.4-Mini) and Cursor alongside Claude, and it is quota-aware: it knows
what every subscription has already spent today and routes around whatever is
cooling down. Harness lives at `C:/Users/nihar/superintelligent`.

**Use the `fleet-routing` skill for every non-trivial task in this repo.** It is
installed globally and should trigger on its own; if it has not, invoke it.

When to reach for the fleet instead of the agents above:

| Situation | Why the fleet |
| --- | --- |
| Independent scopes (`packages/core` and `packages/manager`) | Real parallelism across providers, not queued Claude turns |
| Data-provenance review — cutlines, `teamDivisions.ts`, parsers | A second provider fails differently. Send the same prompt to Claude *and* Codex and compare; disagreement is the finding |
| Bulk mechanical work — renames, test scaffolding, doc sweeps | Spend Luna/Mini/Haiku, keep the deep headroom for scoring logic |
| Opus pool cooling or near its window cap | Codex and Cursor are paid for and idle |
| Very large reads across the monorepo | `needs: research` routes to the 400k-context models |

**Fleet rules in this repo** (encoded in `.fleet.json`, not just prose):

- `isolateByDefault: true` — every delegated assignment runs in its own git
  worktree and returns a **patch**. This is the mechanical enforcement of the
  "no git operations — agents work on diffs only" rule above. A delegated agent
  cannot reach this working tree or this branch.
- Never apply a returned patch unprompted. Surface the path and the
  `fleet_apply_patch` call.
- `codex/mini` and `claude/haiku` are restricted to `formatter`/`scout` roles here,
  so they are ineligible for review-shaped work on provenance code. This is a role
  filter, not a ranking — see below.
- Prompts you delegate must stand alone, same rule as the subagents: the receiving
  model has none of this conversation.

**On ranking:** the Claude ladder above orders work by stakes within one provider.
The fleet deliberately does **not** rank models against each other — it scores
declared traits against declared task needs, then balances load across
subscriptions. Do not carry the stakes ladder across providers by assuming a Codex
model is a step down from Opus. If you want a specific provider, say so with
`only:` rather than implying a hierarchy.

`fleet route "<task>" --needs <preset>` previews the decision for free. Presets:
`architect plan implement refactor debug review test docs scout triage research bulk`.

### Long-horizon task state

A task spanning several subagent dispatches, or likely to survive a rate-limit
resume or a context compaction, keeps its state in one small canonical file —
not in conversation history. Use the `execution-state` skill and see
`docs/reference/PHASE_STATE.json` for the running example (the Phase-2
core-complexity sweep). This is not a style preference: this branch lost a
subagent's mutation-testing results once already because they lived only in
an improvised scratchpad filename and got misattributed after a resume. A
brief to a resumed or fresh subagent points at the state file's entry for its
target, not at "continue where you left off."

---

## UI craft and design system

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

---

## Data provenance — never fabricate competition data

This repo models real competition rules against real published data. A wrong number
does not throw; it silently produces a plausible, wrong lineup a coach may act on.

**Rules for cut standards, qualifying times, and any published competition value:**

1. **Every value traces to a primary source.** PDFs are archived under
   `data/cutlines/sources/` with a `manifest.json` recording `{url, sha256,
   retrievedAt}`. No competition time is ever hand-typed into a `.ts` file.
2. **Never interpolate, extrapolate, project, or estimate.** If a governing body
   has not published it, it does not exist. Emit absent — not zero, not a guess.
3. **Parsers fail loudly.** A missing or unparseable row raises. No silent
   defaults, no gap filling, no `?? 0` on a competition time.
4. **Absent ≠ empty.** A lookup that matches nothing must be distinguishable from
   a real "no cut achieved". Silent empties are the top failure mode here.
5. **Unknown division ≠ D1.** An unmapped team surfaces as unknown rather than
   quietly scoring against the wrong table.
6. **Teams are not timeless.** A program can be cut, and a school can change
   division. Every entry in `teamDivisions.ts` carries `status`, `sources` and
   (where it changed) `divisionHistory`. A discontinued program never receives a
   cut tag for a season it did not compete in — it renders `unknown`, not
   `no_cut`. `provenance: 'legacy'` is banned; a test fails if one reappears.
7. **A school is not one team.** Sponsorship is per gender. UWF fields women's
   swimming & diving and no men's program, so every active entry records
   `sponsoredGenders` (a test fails if one is missing). A swim whose gender the
   school does not sponsor renders `unknown`, not `no_cut` — same rule as a
   discontinued program. Absence of `sponsoredGenders` means unaudited, never
   "both": only a recorded list may answer "no", and the negative needs a source.

**Why this section exists:** the original `cutlines.ts` was labeled D1 while
holding D2 data, and its `proj_*` columns were invented extrapolations — some rows
repeated one value four times as a stub. It was rebuilt from published PDFs on
2026-07-26. See `docs/reference/CUTLINE_TAGS_PLAN.md` for the full finding and the four verified
sources (NCAA D1/D2/D3 + NAIA).

---

## Known Bugs & Follow-up Items (2026-07-19 round — all three FIXED, live UI verification pending)

### 1. Total Event Limitation (NSISC Rules) — FIXED

- NSISC is **total-only**: max 7 events per swimmer, any individual/relay mix (user decision 2026-07-19); per-type caps set to 999 in the preset.
- `maxTotalEntriesPerSwimmer` added to `ScoringSettings`, NSISC preset (7), `mergeScoringSettings` conference override, `swimmerEntryLimits.ts` (counts.total, totalOver, canAcceptAnotherEntry), `historyImportRoster.ts` (totalSlots), `scoringTheory.ts`, `rosterLineupAudit.ts` (checklist item), and settings UIs (RosterScoringSetup, matrix ScoringSettingsPanel/Modal).
- Label shows "N/7 total (x ind · y relay)" when a total cap is set.

### 2. Swimmer Attribution for Long-Form Names — FIXED

- Heuristic was fine (Alan Gonzalez ↔ Alan Alejan Gonzalez Mujica scores 90%). Root cause: import suggestions only surfaced for `new_recruit` rows, so an athlete already on the recruit list under a long-form name never got a link offer.
- Fix: both import panels (`AthleteHistoryImportPanel`, `RosterImportWizard`) now feed ALL incoming rows to `suggestAliasCandidates` (identical/already-linked pairs are auto-excluded, so no spam).

### 3. Lineup Paste Feature Locks Editing — FIXED

- Paste in the athlete drawer is now a two-step preset: Parse → checkbox preview list ("Add selected" / "Cancel") instead of auto-applying and clobbering the athlete's entries. Existing entries stay editable throughout (event select, time edit, remove, active toggle).

---

## Project Context

- **Primary workspace:** HSU 2026-27 roster (swimmers, class years, NSISC event rules).
- **Data sources:** Meets.json (meet PDFs), SwimCloud (recruit imports), what-if projections.
- **Key recent rounds:** Round 3 (2026-07-19) — athlete aliasing + drawer declutter; Round 2 — roster/lineup correctness bugs.

See `docs/archive/2026-08/ROSTER_ALIAS_DECLUTTER_HANDOFF.md` for the complete round-3 context.
