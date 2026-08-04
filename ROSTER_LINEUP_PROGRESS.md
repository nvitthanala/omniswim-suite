# Roster Lineup Progress

> Living handoff for the Manager roster workflow Lineup / Relays overhaul.
> Plan: `.cursor/plans/lineup_builder_overhaul_2281d634.plan.md` (do not edit the plan file).

Last updated: 2026-07-12.

## Workflow

Manager Team management is a **4-step wizard**:

1. **Source** — meet copy, scoring setup, SwimCloud import, recruits  
2. **Lineup** — team dropdown, scorer + event editor, per-athlete tags, sticky compliance checklist  
3. **Relays** — full relay leg builder (former Ind/Relay tab)  
4. **Optimize** — arbitrage / classic optimizer  

The separate **Ind / Relay** sub-tab was removed; Relays is step 3 in the wizard.

## Scorer ↔ relay rule

In what-if mode: **non-scorers cannot swim relays**.

When a swimmer is toggled **off** as a scorer:

1. `scorerRosterOverrides` is updated  
2. Any `relayLegOverrides` naming them are pruned (`applyScorerOffRelayPatch`)  
3. `buildWhatIfResults` → `computeVacateRelayLegNames` → `simulateRoster(..., vacateRelayLegNames)` marks their relay legs **vacant**  
4. UI shows athlete tags + checklist items (“leg needs filling”)  
5. Toast warns the user  

Drop seniors / soft-remove continue to vacate legs the same way as before.

## Compliance audit (`rosterLineupAudit.ts`)

| Issue type | Meaning |
|---|---|
| `over_entry_limit` | Individual or relay entry cap exceeded |
| `empty_lineup` | Marked scorer with zero individual entries |
| `relay_leg_vacant` | Vacant leg (senior drop / soft-remove) |
| `relay_scorer_off` | Vacated because athlete is not a scorer |
| `relay_needs_fill` | Team checklist item for a vacant leg |

Exports: `buildTeamLineupAudit`, `computeVacateRelayLegNames`, `applyScorerOffRelayPatch`, `pruneRelayOverridesForSwimmer`, `suggestQuickFillForVacantLeg`, `issueBadgeLabel`.

## UI pieces

| File | Role |
|---|---|
| `RosterLineupStep.tsx` | Layout: roster + sticky checklist |
| `TeamRosterPanel.tsx` | Dropdown team picker, issue badges, unified editor mode |
| `AthleteLineupEditorPanel.tsx` | Scorer + entries + relay involvement |
| `LineupComplianceChecklist.tsx` | Sticky (desktop) / collapsible (mobile) checklist |
| `RosterRelayStep.tsx` | Wizard Relays step wrapping `IndRelayManagementView` |
| `RosterWizardShell.tsx` | 4-step shell |

## Tests

```bash
npx tsx scripts/test_lineup_audit.mjs
npm test
```

`test_lineup_audit.mjs` covers: override prune, soft-remove prune, non-scorer vacate, over-limit, empty lineup, senior vacant, quick-fill.

## Constraints preserved

- `packages/core` does not import `@omniswim/ui`  
- `SuiteWorkspaceProvider` / `useWorkspaceScoring` public shapes unchanged  
- Soft-remove still preserves PDF/source rows  
