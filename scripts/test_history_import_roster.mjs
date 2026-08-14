/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Phase 1: history import → roster bridge tests.
 */
import assert from 'node:assert/strict';
import {
  importHistoryToRoster,
  previewHistoryImportActions,
  formatHistoryImportSummary,
} from '../packages/core/src/lib/historyImportRoster.ts';
import { ClassYear, Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection.ts';
import { buildScorerRosterLookup } from '../packages/core/src/lib/scorerRoster.ts';
import { normalizeSwimmerName } from '../packages/core/src/lib/utils.ts';

function baseWorkspace(overrides = {}) {
  return {
    id: 'test-ws',
    name: 'Test',
    createdAt: Date.now(),
    menResults: [
      {
        id: 'r1',
        rank: 1,
        name: 'Smith, John',
        classYear: 'JR',
        team: 'Ouachita Baptist University',
        time: '20.50',
        points: 0,
        event: '50 Freestyle',
        gender: Gender.MEN,
      },
      {
        id: 'r2',
        rank: 2,
        name: 'Smith, John',
        classYear: 'JR',
        team: 'Ouachita Baptist University',
        time: '45.00',
        points: 0,
        event: '100 Freestyle',
        gender: Gender.MEN,
      },
    ],
    womenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    historySources: [],
    scorerRosterOverrides: [],
    ...overrides,
  };
}

// --- empty preview → noop ---
{
  const ws = baseWorkspace();
  const result = importHistoryToRoster(ws, [], {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.equal(result.noop, true);
  assert.deepEqual(result.patch, {});
  assert.equal(result.summary.swimsMerged, 0);
}

// --- blank team → noop ---
{
  const ws = baseWorkspace();
  const preview = [
    {
      name: 'New Kid',
      team: '',
      gender: Gender.MEN,
      event: '50 Freestyle',
      time: '21.00',
      source: 'paste',
    },
  ];
  const result = importHistoryToRoster(ws, preview, { team: '  ', gender: Gender.MEN });
  assert.equal(result.noop, true);
}

// --- unknown HS swimmer → recruits created, visible on roster ---
{
  const ws = baseWorkspace();
  const preview = [
    {
      name: 'Vera, Blaise',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '50 Freestyle',
      time: '19.50',
      source: 'paste',
      classYear: 'HS',
    },
    {
      name: 'Vera, Blaise',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '100 Freestyle',
      time: '43.00',
      source: 'paste',
    },
    {
      name: 'Vera, Blaise',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '200 Freestyle',
      time: '1:36.00',
      source: 'paste',
    },
    {
      name: 'Vera, Blaise',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '100 Butterfly',
      time: '48.00',
      source: 'paste',
    },
  ];
  const actions = previewHistoryImportActions(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.equal(actions[0]?.action, 'new_recruit');

  const result = importHistoryToRoster(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
    sourceLabel: 'test import',
  });
  assert.equal(result.noop, false);
  // All four swims are retained as history regardless of the meet program.
  assert.ok((result.patch.athleteHistory?.length ?? 0) >= 4);
  assert.ok(result.summary.newRecruits <= 7, 'total cap bounds recruit entries');
  // The loaded meet contests only 50 Free and 100 Free, so only those two become
  // entries. A swimmer is never entered in an event the meet does not contest —
  // 200 Freestyle and 100 Butterfly are dropped even though the athlete has times.
  assert.equal(result.summary.newRecruits, 2);
  const veraEvents = (result.patch.recruits ?? [])
    .filter(r => r.name === 'Vera, Blaise')
    .map(r => r.event)
    .sort();
  assert.deepEqual(veraEvents, ['100 Freestyle', '50 Freestyle']);

  const projected = buildWhatIfResults({
    workspace: { ...ws, ...result.patch },
    gender: Gender.MEN,
    removeSeniors: false,
  });
  const lookup = buildScorerRosterLookup(
    projected,
    NSISC_PRESET_SETTINGS,
    result.patch.scorerRosterOverrides ?? [],
    Gender.MEN
  );
  assert.ok(
    lookup.rows.some(r => normalizeSwimmerName(r.name) === normalizeSwimmerName('Vera, Blaise')),
    'recruit should appear in scorer roster lookup'
  );

  // Same swimmer, same swims — but a meet that DOES contest 200 Free and 100 Fly.
  // The gate must follow the meet, not narrow to a hardcoded list.
  const widerMeet = baseWorkspace({
    menResults: [
      ...baseWorkspace().menResults,
      {
        id: 'r3',
        rank: 1,
        name: 'Smith, John',
        classYear: 'JR',
        team: 'Ouachita Baptist University',
        time: '1:38.00',
        points: 0,
        event: 'Event 17 Men 200 Yard Freestyle',
        gender: Gender.MEN,
      },
      {
        id: 'r4',
        rank: 1,
        name: 'Smith, John',
        classYear: 'JR',
        team: 'Ouachita Baptist University',
        time: '47.00',
        points: 0,
        event: 'Event 13 Men 100 Yard Butterfly',
        gender: Gender.MEN,
      },
    ],
  });
  const widerResult = importHistoryToRoster(widerMeet, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  const widerEvents = (widerResult.patch.recruits ?? [])
    .filter(r => r.name === 'Vera, Blaise')
    .map(r => r.event)
    .sort();
  assert.deepEqual(
    widerEvents,
    ['100 Butterfly', '100 Freestyle', '200 Freestyle', '50 Freestyle'],
    'a meet that contests these events admits them (HyTek labels included)'
  );
}

// --- existing athlete → meetEntryPlans, no duplicate recruits ---
{
  // The meet must contest the events being added, or the gate correctly refuses
  // them and the athlete reports `history_matched` instead.
  const ws = baseWorkspace({
    menResults: [
      ...baseWorkspace().menResults,
      {
        id: 'r5',
        rank: 1,
        name: 'Other, Swimmer',
        classYear: 'SR',
        team: 'Ouachita Baptist University',
        time: '1:39.00',
        points: 0,
        event: '200 Freestyle',
        gender: Gender.MEN,
      },
      {
        id: 'r6',
        rank: 1,
        name: 'Other, Swimmer',
        classYear: 'SR',
        team: 'Ouachita Baptist University',
        time: '49.00',
        points: 0,
        event: '100 Backstroke',
        gender: Gender.MEN,
      },
    ],
  });
  const preview = [
    {
      name: 'Smith, John',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '200 Freestyle',
      time: '1:40.00',
      source: 'paste',
    },
    {
      name: 'Smith, John',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '100 Backstroke',
      time: '50.00',
      source: 'paste',
    },
  ];
  const actions = previewHistoryImportActions(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.equal(actions[0]?.action, 'add_to_lineup');

  const result = importHistoryToRoster(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.equal(result.summary.newRecruits, 0);
  assert.ok(result.summary.lineupEntriesAdded >= 1);
  assert.equal((result.patch.recruits ?? []).length, 0);
  const plans = (result.patch.meetEntryPlans ?? []).filter(
    p => normalizeSwimmerName(p.name) === normalizeSwimmerName('Smith, John')
  );
  assert.ok(plans.length >= 1);
  assert.ok(plans.every(p => p.source === 'swimcloud'));
}

// --- idempotent re-import ---
{
  const ws = baseWorkspace();
  const preview = [
    {
      name: 'Doe, Jane',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '50 Freestyle',
      time: '22.00',
      source: 'paste',
    },
    {
      name: 'Doe, Jane',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '100 Freestyle',
      time: '48.00',
      source: 'paste',
    },
  ];
  const first = importHistoryToRoster(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  const ws2 = { ...ws, ...first.patch };
  const second = importHistoryToRoster(ws2, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.equal(second.summary.newRecruits, 0);
  assert.equal(
    (second.patch.recruits ?? []).filter(r => r.name === 'Doe, Jane').length,
    (first.patch.recruits ?? []).filter(r => r.name === 'Doe, Jane').length
  );
}

// --- respects caps when athlete already at max entries ---
{
  const planFor = (id, event, time) => ({
    id,
    name: 'Smith, John',
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
    event,
    time,
    source: 'manual',
    active: true,
  });
  const ws = baseWorkspace({
    meetEntryPlans: [
      planFor('p1', '200 Freestyle', '1:40.00'),
      planFor('p2', '500 Freestyle', '4:40.00'),
      planFor('p3', '200 IM', '1:52.00'),
      planFor('p4', '400 IM', '4:00.00'),
      planFor('p5', '100 Backstroke', '50.00'),
    ],
  });
  // PDF has 50 Free + 100 Free; plans add 5 more → 7 total (NSISC total cap). Import should add 0.
  const preview = [
    {
      name: 'Smith, John',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '100 Butterfly',
      time: '49.00',
      source: 'paste',
    },
    {
      name: 'Smith, John',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '200 Butterfly',
      time: '1:50.00',
      source: 'paste',
    },
  ];
  const result = importHistoryToRoster(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.equal(result.summary.lineupEntriesAdded, 0);
  assert.ok((result.patch.athleteHistory?.length ?? 0) >= 2, 'history still merged');
}

// --- unrelated import does not disturb existing recruits/plans/overrides ---
{
  const ws = baseWorkspace({
    recruits: [
      {
        id: 'ex1',
        name: 'Existing, Recruit',
        team: 'Ouachita Baptist University',
        event: '50 Freestyle',
        time: '21.00',
        gender: Gender.MEN,
        classYear: ClassYear.HS,
        timeType: 'SCY',
      },
    ],
    meetEntryPlans: [
      {
        id: 'plan-ex',
        name: 'Smith, John',
        team: 'Ouachita Baptist University',
        gender: Gender.MEN,
        event: '200 IM',
        time: '1:55.00',
        source: 'manual',
        active: true,
      },
    ],
    activeEntryIds: ['plan-ex'],
    scorerRosterOverrides: [
      {
        name: 'Existing, Recruit',
        team: 'Ouachita Baptist University',
        gender: Gender.MEN,
        isScorer: true,
      },
    ],
  });
  const preview = [
    {
      name: 'Other, Athlete',
      team: 'Ouachita Baptist University',
      gender: Gender.MEN,
      event: '100 Breaststroke',
      time: '58.00',
      source: 'paste',
    },
  ];
  const result = importHistoryToRoster(ws, preview, {
    team: 'Ouachita Baptist University',
    gender: Gender.MEN,
  });
  assert.ok((result.patch.recruits ?? []).some(r => r.id === 'ex1'));
  assert.ok((result.patch.meetEntryPlans ?? []).some(p => p.id === 'plan-ex'));
  assert.ok((result.patch.activeEntryIds ?? []).includes('plan-ex'));
  assert.ok(
    (result.patch.scorerRosterOverrides ?? []).some(
      o => o.name === 'Existing, Recruit' && o.isScorer
    )
  );
}

// --- summary formatter ---
{
  const msg = formatHistoryImportSummary({
    swimsMerged: 5,
    newRecruits: 2,
    lineupEntriesAdded: 1,
    swimmers: [],
  });
  assert.ok(msg.includes('5 swim'));
  assert.ok(msg.includes('2 new recruit'));
  assert.ok(msg.includes('1 lineup'));
}

console.log('history import roster tests passed');
