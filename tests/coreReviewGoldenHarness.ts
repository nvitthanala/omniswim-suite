/**
 * Current-tree real-data snapshot for architect review F1.
 *
 * Run with: npx tsx tests/coreReviewGoldenHarness.ts
 * Writes: docs/reference/golden-after-F1.json
 * The pre-fix baseline was not captured; do not treat this file as one.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Gender, type PlannedSwimEntry, type Workspace } from '../packages/core/src/types';
import { optimizeEventLineupForTeam, optimizeRosterForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaces = JSON.parse(readFileSync(join(root, 'data/meets.json'), 'utf8')) as Workspace[];
const targetWorkspaces = [
  { name: 'HSU 2026-27 Roster Plan', team: 'Henderson State University' },
  { name: 'OBU 2026-27 Roster', team: 'Ouachita Baptist University' },
  { name: 'Blank Workspace 1', team: 'both' },
];

function planShape(plan: PlannedSwimEntry) {
  return {
    name: plan.name,
    team: plan.team,
    gender: plan.gender,
    event: plan.event,
    time: plan.time,
    source: plan.source,
    active: plan.active,
    replacesResultId: Boolean(plan.replacesResultId),
  };
}

function sorted<T>(items: T[]): T[] {
  return items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const rows: Record<string, unknown>[] = [];
for (const target of targetWorkspaces) {
  const workspace = workspaces.find(item => item.name === target.name);
  if (!workspace) throw new Error(`data/meets.json is missing workspace: ${target.name}`);
  const teams = target.team === 'both'
    ? ['Henderson State University', 'Ouachita Baptist University']
    : [target.team];

  for (const gender of [Gender.MEN, Gender.WOMEN]) {
    for (const team of teams) {
      const settings = workspace.scoringSettings!;
      const eventResult = optimizeEventLineupForTeam(workspace, gender, team, settings);
      const rosterResult = optimizeRosterForTeam(workspace, gender, team, false, settings, 'events');
      const relayResult = rankRelayLegSwaps(workspace, { team, gender, settings });
      const history = (workspace.athleteHistory ?? []).filter(row => row.team === team && row.gender === gender);
      const importResult = importHistoryToRoster(workspace, history, { team, gender, sourceType: 'paste' });

      const eventOutput = {
        planCount: eventResult.plans.filter(p => p.team === team && p.gender === gender).length,
        targetPlans: sorted(eventResult.plans.filter(p => p.team === team && p.gender === gender).map(planShape)),
        activeIdCount: eventResult.activeEntryIds.length,
      };
      const rosterOutput = {
        outcome: rosterResult.outcome,
        appliedStages: rosterResult.appliedStages,
        previousTotal: rosterResult.previousTotal,
        projectedTotal: rosterResult.projectedTotal,
        allPlanCount: rosterResult.meetEntryPlans.length,
        targetPlans: sorted(rosterResult.meetEntryPlans.filter(p => p.team === team && p.gender === gender).map(planShape)),
        activeIdCount: rosterResult.activeEntryIds.length,
        overridesCount: rosterResult.overrides.length,
      };
      const relayOutput = {
        pointsMeaningful: relayResult.pointsMeaningful,
        reason: relayResult.reason,
        candidatesEvaluated: relayResult.candidatesEvaluated,
        swaps: sorted(relayResult.swaps.map(s => ({
          relayEvent: s.relayEvent,
          relayRank: s.relayRank,
          legIndex: s.legIndex,
          outAthlete: s.outAthlete,
          inAthlete: s.inAthlete,
          inTime: s.inTime,
          deltaPoints: s.deltaPoints,
        }))),
      };
      const importOutput = {
        summary: importResult.summary,
        targetPlans: sorted((importResult.patch.meetEntryPlans ?? [])
          .filter(p => p.team === team && p.gender === gender).map(planShape)),
        targetRecruits: sorted((importResult.patch.recruits ?? [])
          .filter(r => r.team === team && r.gender === gender)
          .map(r => ({ name: r.name, event: r.event, time: r.time, source: r.source }))),
        activeIdCount: importResult.patch.activeEntryIds?.length ?? 0,
      };

      rows.push({
        workspace: target.name,
        team,
        gender,
        optimizeEventLineupForTeam: { sha256: digest(eventOutput), output: eventOutput },
        optimizeRosterForTeam: { sha256: digest(rosterOutput), output: rosterOutput },
        rankRelayLegSwaps: { sha256: digest(relayOutput), output: relayOutput },
        importHistoryToRoster: { sha256: digest(importOutput), output: importOutput },
      });
    }
  }
}

const output = {
  source: 'local data/meets.json',
  baseline: 'not captured before F1; this file records only the after-state',
  cases: rows,
};
const destination = join(root, 'docs/reference/golden-after-F1.json');
writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${rows.length} after-state cases to ${destination}`);
