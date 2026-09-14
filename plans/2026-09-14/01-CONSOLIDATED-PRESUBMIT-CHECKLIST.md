# Consolidated pre-submit checklist

**Status 2026-09-14: the `program` half shipped. The `provenance`
(conversion-estimate) half stays scoped, not built** — see §5.

**Date:** 2026-09-14
**Trigger:** `docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md` item 10,
the brainstorm's own top pick: "a coach exporting a lineup gets scattered
warnings across several separate checks (entry limits, lineup audit,
conversion provenance, unknown program, duplicate identity) instead of one
actionable checklist before submitting."

## 1. Correction to the brainstorm's own premise — most of this already exists

The brainstorm was written without checking whether a consolidated checklist
already existed. It does: `LineupComplianceChecklist.tsx` +
`LineupComplianceChecklistParts.tsx` (303 lines together), backed by
`packages/core/src/lib/rosterLineupAudit.ts`'s `buildTeamLineupAudit`, is a
live, sticky checklist rendered in `RosterLineupStep.tsx` (Manager's actual
Lineup step). It already groups issues into `LineupChecklistItem['group']`:

- `entries` — entry-limit violations
- `lineups` — empty lineups
- `relays` — relay gaps (vacant legs)
- `roster` — duplicate-athlete pairs, with inline Link/Not-the-same actions

This is not a stub. `buildTeamLineupAudit` is itself a Phase-2
complexity-sweep target already cut from CC 40 to 7
(`docs/reference/PHASE_STATE.json`), verified against 213 real scenarios
across all 3 live workspaces. **This item is not "build a checklist" — it
is "extend an existing one," a materially smaller and lower-risk task than
the brainstorm implied.**

## 2. What is genuinely still scattered, not in this checklist

Two of the five categories the brainstorm named are real gaps, confirmed by
reading the actual code, not assumed:

1. **Conversion provenance.** A course-converted cut comparison already
   renders as `converted_estimate` — visibly "indicative," not a real cut —
   via `cutlineTags.ts`. But that signal lives inside the cutline badge a
   coach sees per-swim on a results table; it never surfaces as a checklist
   line item a coach can review in one place before submitting a whole
   lineup. A team that leans heavily on converted-cut swims for its entry
   decisions has no single "N entries rest on an indicative, not official,
   conversion" summary.
2. **Unknown program/division.** `divisionForTeamOrNull` and the
   `sponsoredGenders` provenance rule (`CLAUDE.md` §Data provenance, rules 5
   and 7) can each answer "unknown" for a team or a gender — by design,
   never silently defaulting to a real division. But an "unknown" answer
   for an athlete on the roster being submitted currently surfaces wherever
   that specific screen happens to render it, not as one checklist entry
   saying "N athletes are on an unmapped or unconfirmed-sponsorship team —
   cut tags and lineup rules for them may be wrong."

The brainstorm's other two named categories are **not** gaps:
- Entry limits — already a checklist group (`entries`).
- Duplicate identity — already a checklist group (`roster`), and the athlete-
  identity matching underneath it was itself hardened this session (folded
  diacritics/comma order — see `docs/reference/IMPROVEMENT_BRAINSTORM_2026-09-02.md`
  item 3's sibling finding).

## 3. Scope, and what shipped 2026-09-14

Two new `LineupChecklistItem['group']` values — `provenance` and `program`
— each populated by its own pure function alongside `buildTeamLineupAudit`'s
existing checks:

- **`auditProgramProvenance(...)` — ✅ SHIPPED.** Walks the roster for
  `resolveTeamDivision(team).division === null` (unmapped) or
  `!programSponsorsGender(resolution, gender)` (recorded as not sponsoring
  this gender), emitting one `program` checklist item per affected
  athlete/team pair. Both read straight off `data/teamDivisions.ts` — no new
  scoring logic. 4 new tests in
  `tests/rosterLineupAuditProgramProvenance.test.ts`.
- **`auditConversionProvenance(...)` — not built.** Walks a team's scored
  swims for every `converted_estimate` cutline state and emits a
  `provenance` checklist item per affected athlete. Deferred because it
  needs a real per-swim cutline-tag computation
  (`buildCutlineTagForTeam({ time, gender, event, team })`, one call per
  scored swim) threaded into the audit, which today only sees
  `SwimmerResult`/`ScorerRosterRow` — no swim-level cutline pass runs inside
  `buildTeamLineupAudit` at all; the existing call sites for this function
  are individual athlete-detail rows (`AthleteCreditedSwimsRow.tsx`,
  `AthleteEntriesSection.tsx`, `AthleteHistorySection.tsx`), not a team-wide
  audit. That's a real, if contained, design decision (batch it inline in
  the audit vs. thread a pre-computed tag map in) worth its own pass rather
  than folding in alongside the smaller `program` change.

Both groups slot into `TeamLineupAudit.checklistItems` exactly like the
four pre-existing groups — `LineupComplianceChecklist.tsx`'s own
group-rendering loop (`GROUP_LABEL`, `ChecklistGroupSection`) already
generalizes over `item.group`; adding `program` there was a label and a
render-order entry, not a rewrite. `provenance` is not yet in the type —
it will be added alongside its producer, not ahead of it.

**Severity decided for `program` (see open question 1 below): informational
-only**, matching how relay gaps currently read — not a distinct
must-fix/should-know type distinction. Revisit if `provenance` turns out to
need the stronger treatment.

## 4. Open questions for the user

1. **Severity.** Should a `provenance`/`program` item block submission (like
   a real entry-limit violation might read as blocking), or read as
   informational-only (closer to how relay gaps currently read)? The
   checklist doesn't currently distinguish "must fix" from "should know"
   at the type level — worth deciding before adding two more items that
   might need that distinction for the first time.
2. **Scope of "submission."** This checklist lives on the Lineup step.
   `entryExport.ts` (brainstorm item 9, a separate, smaller finding —
   HyTek export can currently emit a non-`WOMEN` gender as `M` and blank
   fields as usable-looking output with no review step) is a different
   choke point, downstream of the Lineup step. Does "pre-submit" mean this
   checklist, the export step, or both should gain a final gate?
3. **Effort estimate**, if approved: small-medium. The provenance/program
   detectors are each a straightforward read over data already computed
   elsewhere (no new scoring logic); the UI change is additive to an
   existing, already-generalized component. Realistic for one `executor`
   pass with golden-output verification against the 3 live workspaces,
   matching this repo's own established discipline for `packages/core`
   changes.

Not started. No code changed for this item.
