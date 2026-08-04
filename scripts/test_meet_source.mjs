/**
 * Meet source copy + soft-remove regression tests.
 */
import assert from 'node:assert/strict';
import { Gender } from '../packages/core/src/types.ts';
import {
  cloneMeetResults,
  getSourceResults,
  meetCopyFromParsed,
  withSourceResultsBackfill,
} from '../packages/core/src/lib/meetSource.ts';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine.ts';
import {
  softRemoveSwimmerFromWorkspace,
  restoreSwimmerToWorkspace,
} from '../packages/core/src/lib/swimmerSoftRemove.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';

const sampleMen = [
  {
    id: 'a1',
    rank: 1,
    name: 'Alice, A',
    classYear: 'JR',
    team: 'Team A',
    time: '20.00',
    points: 0,
    event: '50 Freestyle',
    gender: Gender.MEN,
  },
  {
    id: 'b1',
    rank: 2,
    name: 'Bob, B',
    classYear: 'SO',
    team: 'Team A',
    time: '20.50',
    points: 0,
    event: '50 Freestyle',
    gender: Gender.MEN,
  },
];

{
  const copy = meetCopyFromParsed(sampleMen, []);
  assert.equal(copy.menResults?.length, 2);
  assert.equal(copy.sourceMenResults?.length, 2);
  assert.notEqual(copy.menResults?.[0], copy.sourceMenResults?.[0]);
  assert.deepEqual(copy.menResults?.[0], copy.sourceMenResults?.[0]);
}

{
  const ws = {
    id: 'w',
    name: 't',
    createdAt: 1,
    menResults: cloneMeetResults(sampleMen),
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
  };
  assert.equal(getSourceResults(ws, Gender.MEN).length, 2);
  const backfilled = withSourceResultsBackfill(ws);
  assert.equal(backfilled.sourceMenResults?.length, 2);
  const again = withSourceResultsBackfill(backfilled);
  assert.equal(again.sourceMenResults, backfilled.sourceMenResults);
}

{
  const parsed = meetCopyFromParsed(sampleMen, []);
  const ws = {
    id: 'w',
    name: 't',
    createdAt: 1,
    ...parsed,
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
  };
  const before = buildScoringSnapshot(ws, Gender.MEN, false);
  const baselineBefore = before.baseline.sortedTeams.find(t => t.teamName === 'Team A')?.totalPoints;

  // Soft-remove Bob — working rows stay; projected excludes Bob; baseline unchanged.
  const patch = softRemoveSwimmerFromWorkspace(ws, { name: 'Bob, B', gender: Gender.MEN });
  const afterWs = { ...ws, ...patch };
  assert.equal(afterWs.menResults.length, 2);
  assert.equal(afterWs.sourceMenResults?.length, 2);
  assert.equal(afterWs.deletedSwimmers?.length, 1);

  const after = buildScoringSnapshot(afterWs, Gender.MEN, false);
  const baselineAfter = after.baseline.sortedTeams.find(t => t.teamName === 'Team A')?.totalPoints;
  assert.equal(baselineAfter, baselineBefore, 'baseline must stay stable after soft remove');

  const restored = { ...afterWs, ...restoreSwimmerToWorkspace(afterWs, { name: 'Bob, B', gender: Gender.MEN }) };
  assert.equal((restored.deletedSwimmers ?? []).length, 0);
}

console.log('meet source + soft remove tests passed');
