/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Gender } from '../packages/core/src/types.ts';
import {
  buildPrelimsFieldResults,
  buildPrelimsProjectedBundle,
  buildPrelimsDeltaTimeline,
  hasPrelimsData,
  prelimsClock,
  projectPrelimsPlacements,
} from '../packages/core/src/lib/prelimsProjection.ts';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine.ts';
import { mergeScoringSettings } from '../packages/core/src/lib/utils.ts';

const settings = mergeScoringSettings({});

function sprintRow(id, name, team, time, prelimsTime, roundSwam = 'A Final') {
  return {
    id,
    rank: 1,
    name,
    classYear: 'SR',
    team,
    time,
    prelimsTime,
    finalsTime: time,
    roundSwam,
    points: 0,
    event: 'Event 1 Men 100 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  };
}

function distanceRow(id, name, team, time, roundSwam = 'Preliminaries') {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team,
    time,
    prelimsTime: time,
    roundSwam,
    points: 0,
    event: 'Event 20 Men 1650 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  };
}

// --- hasPrelimsData ---
const withPrelims = [sprintRow('a', 'Swimmer A', 'Team A', '48.00', '49.00')];
const withoutPrelims = [
  {
    ...sprintRow('b', 'Swimmer B', 'Team B', '48.00', undefined),
    prelimsTime: undefined,
    roundSwam: 'A Final',
  },
];

if (!hasPrelimsData(withPrelims)) {
  console.error('FAIL: expected hasPrelimsData true');
  process.exit(1);
}
if (hasPrelimsData(withoutPrelims)) {
  console.error('FAIL: expected hasPrelimsData false when no prelims clocks');
  process.exit(1);
}

// --- Sprint projection: top 8 → A Final ---
const sprintField = [
  sprintRow('1', 'S1', 'Team A', '47.0', '48.0'),
  sprintRow('2', 'S2', 'Team A', '47.5', '48.5'),
  sprintRow('3', 'S3', 'Team B', '48.0', '49.0'),
  sprintRow('4', 'S4', 'Team B', '48.5', '49.5'),
  sprintRow('5', 'S5', 'Team C', '49.0', '50.0'),
  sprintRow('6', 'S6', 'Team C', '49.5', '50.5'),
  sprintRow('7', 'S7', 'Team D', '50.0', '51.0'),
  sprintRow('8', 'S8', 'Team D', '50.5', '51.5'),
  sprintRow('9', 'S9', 'Team E', '51.0', '52.0'),
  sprintRow('10', 'S10', 'Team E', '51.5', '52.5'),
];

const field = buildPrelimsFieldResults(sprintField);
if (field.length !== 10) {
  console.error('FAIL: expected 10 deduped sprint rows, got', field.length);
  process.exit(1);
}

const projected = projectPrelimsPlacements(field, settings);
const topEight = projected.filter(r => r.roundSwam === 'A Final');
const bFinal = projected.filter(r => r.roundSwam === 'B Final');
if (topEight.length !== 8) {
  console.error('FAIL: expected 8 A Final projections, got', topEight.length);
  process.exit(1);
}
if (bFinal.length !== 2) {
  console.error('FAIL: expected 2 B Final projections, got', bFinal.length);
  process.exit(1);
}

// --- Distance: stays on Preliminaries tier ---
const distanceField = buildPrelimsFieldResults([
  distanceRow('d1', 'D1', 'Team A', '15:00.00'),
  distanceRow('d2', 'D2', 'Team B', '15:30.00'),
]);
const distanceProjected = projectPrelimsPlacements(distanceField, settings);
if (!distanceProjected.every(r => r.roundSwam === 'Preliminaries')) {
  console.error('FAIL: distance events should stay on Preliminaries tier');
  process.exit(1);
}

// --- Full bundle + delta math ---
const workspace = {
  id: 'test-prelims',
  name: 'Test',
  conference: 'NCAA',
  menResults: [
    ...sprintField,
    ...distanceField.map(r => ({
      ...r,
      id: `final-${r.id}`,
      event: 'Event 20 Men 1650 Yard Freestyle',
    })),
  ],
  womenResults: [],
  scoringSettings: settings,
};

const snapshot = buildScoringSnapshot(workspace, Gender.MEN, false);
const prelimsTeamA = snapshot.prelimsProjected.sortedTeams.find(t => t.teamName === 'Team A');
if (!prelimsTeamA || prelimsTeamA.totalPoints <= 0) {
  console.error('FAIL: Team A should have positive prelims projected score');
  process.exit(1);
}

const baselineTeamA = snapshot.baseline.sortedTeams.find(t => t.teamName === 'Team A');
const projectedTeamA = snapshot.projected.sortedTeams.find(t => t.teamName === 'Team A');
if (!baselineTeamA || !projectedTeamA) {
  console.error('FAIL: missing Team A in baseline/projected bundles');
  process.exit(1);
}

const baselineOu = baselineTeamA.totalPoints - prelimsTeamA.totalPoints;
const projectedOu = projectedTeamA.totalPoints - prelimsTeamA.totalPoints;
if (!Number.isFinite(baselineOu) || !Number.isFinite(projectedOu)) {
  console.error('FAIL: over/under deltas should be finite numbers');
  process.exit(1);
}

const deltaTimeline = buildPrelimsDeltaTimeline(
  snapshot.baseline.timelineData,
  snapshot.projected.timelineData,
  snapshot.prelimsProjected.timelineData
);
if (deltaTimeline.length === 0) {
  console.error('FAIL: expected non-empty prelims delta timeline');
  process.exit(1);
}

const emptyWorkspace = { ...workspace, menResults: withoutPrelims };
const emptyBundle = buildPrelimsProjectedBundle({ workspace: emptyWorkspace, gender: Gender.MEN });
if (emptyBundle.sortedTeams.length !== 0) {
  console.error('FAIL: empty prelims data should yield empty prelims bundle');
  process.exit(1);
}

// prelimsClock helper
const clock = prelimsClock(sprintRow('x', 'X', 'T', '48', '49.5'));
if (clock !== '49.5') {
  console.error('FAIL: prelimsClock should prefer prelimsTime');
  process.exit(1);
}

console.log('OK prelims projection tests');
console.log('  Team A prelims proj:', prelimsTeamA.totalPoints.toFixed(1));
console.log('  Team A baseline O/U:', baselineOu.toFixed(1));
console.log('  Team A projected O/U:', projectedOu.toFixed(1));
console.log('  Delta timeline events:', deltaTimeline.length);
