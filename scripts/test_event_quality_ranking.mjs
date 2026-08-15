/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An athlete's "best events" are ranked by how good the swim is, not by how
 * short the event is.
 *
 * The bug: `categorizeBestEvents` sorted by raw elapsed seconds, so a 50 Free
 * (20s) outranked a 1650 Free (900s) for every swimmer alive. Under an entry cap
 * that entered distance swimmers in sprints — on the HSU roster, 27 of 32
 * athletes had the same three "best events" (50 Free, 100 Free, 100 Fly) purely
 * because those are the shortest.
 *
 * The yardstick is each event's published NCAA standard for the team's division.
 *
 * Test: npx tsx scripts/test_event_quality_ranking.mjs
 */
import assert from 'node:assert/strict';
import {
  rankEventsByQuality,
  getAthleteProfile,
} from '../packages/core/src/lib/athleteHistory.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import { convertTimeToSeconds } from '../packages/core/src/lib/utils.ts';
import { Gender } from '../packages/core/src/types.ts';

const D2_TEAM = 'Henderson State University';

function best(entries) {
  const out = {};
  for (const [event, time] of Object.entries(entries)) {
    out[event] = { time, timeSec: convertTimeToSeconds(time), source: 'swimcloud' };
  }
  return out;
}

// --- 1. A distance swimmer's mile outranks their sprint --------------------
{
  const bestByEvent = best({
    '50 Freestyle': '22.90',
    '100 Freestyle': '49.40',
    '200 Freestyle': '1:43.20',
    '500 Freestyle': '4:26.80',
    '1650 Freestyle': '15:18.00',
  });
  const r = rankEventsByQuality(bestByEvent, Gender.MEN, D2_TEAM);
  assert.equal(r.division, 'D2', 'HSU resolves to D2');
  assert.ok(r.tier === 'A' || r.tier === 'B');
  assert.equal(r.unranked.length, 0, 'D2 publishes a standard for every one of these');

  assert.equal(r.ranked[0], '1650 Freestyle', 'the mile is this swimmer’s best event');
  assert.equal(r.ranked[r.ranked.length - 1], '50 Freestyle', 'the 50 is their weakest');

  // Ratios must be strictly increasing along the ranked order.
  for (let i = 1; i < r.ranked.length; i += 1) {
    assert.ok(
      r.ratioByEvent[r.ranked[i - 1]] <= r.ratioByEvent[r.ranked[i]],
      'ranked order follows the ratio'
    );
  }
  // And the ranking must NOT be the raw-seconds order (that is the bug).
  const bySeconds = Object.keys(bestByEvent).sort(
    (a, b) => bestByEvent[a].timeSec - bestByEvent[b].timeSec
  );
  assert.notDeepEqual(r.ranked, bySeconds, 'quality order differs from raw-seconds order');
  assert.deepEqual(r.ranked, [...bySeconds].reverse(), 'here it is exactly inverted');
}

// --- 2. A genuine sprinter still ranks the sprint first --------------------
{
  // Fast 50, mediocre distance: the ranking must not simply prefer long events.
  const bestByEvent = best({
    '50 Freestyle': '19.60',
    '500 Freestyle': '5:10.00',
    '1650 Freestyle': '18:30.00',
  });
  const r = rankEventsByQuality(bestByEvent, Gender.MEN, D2_TEAM);
  assert.equal(r.ranked[0], '50 Freestyle', 'a real sprinter ranks the 50 first');
  assert.ok(
    r.ratioByEvent['50 Freestyle'] < r.ratioByEvent['1650 Freestyle'],
    'the sprint is the better swim here'
  );
}

// --- 3. An unmapped team is not a D1 team: nothing is rankable -------------
{
  const bestByEvent = best({ '50 Freestyle': '20.00', '1650 Freestyle': '15:00.00' });
  const r = rankEventsByQuality(bestByEvent, Gender.MEN, 'Nowhere Community College XYZ');
  assert.equal(r.division, null, 'unmapped team resolves to no division');
  assert.equal(r.tier, null);
  assert.deepEqual(r.ranked, [], 'nothing may be ranked without a table');
  assert.deepEqual(r.unranked.sort(), ['1650 Freestyle', '50 Freestyle']);
  assert.deepEqual(r.ratioByEvent, {}, 'no ratio is invented');
}

// --- 4. An explicit division override is honoured --------------------------
{
  const bestByEvent = best({ '50 Freestyle': '20.00', '200 Freestyle': '1:38.00' });
  const r = rankEventsByQuality(bestByEvent, Gender.MEN, 'Nowhere XYZ', 'D2');
  assert.equal(r.division, 'D2');
  assert.equal(r.unranked.length, 0, 'an explicit division gives us a table');
}

// --- 5. Unrankable events sort after ranked ones, and are surfaced ---------
{
  const ws = {
    id: 'ws',
    name: 'ws',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    sourceMenResults: [],
    sourceWomenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scorerRosterOverrides: [],
    scoringSettings: NSISC_PRESET_SETTINGS,
    conference: 'NSISC',
    athleteHistory: [
      swim('1650 Freestyle', '15:18.00'),
      swim('50 Freestyle', '22.90'),
    ],
  };
  const p = getAthleteProfile(ws, D2_TEAM, Gender.MEN, 'Test, Athlete', NSISC_PRESET_SETTINGS);
  assert.equal(p.primaryEvents[0], '1650 Freestyle', 'profile exposes the quality order');
  assert.ok(p.qualityByEvent && p.qualityByEvent['1650 Freestyle'] > 0);
  assert.deepEqual(p.unrankedEvents, [], 'nothing unrankable for D2 here');
  assert.equal(p.rankingDivision, 'D2');

  function swim(event, time) {
    return {
      name: 'Test, Athlete',
      team: D2_TEAM,
      gender: Gender.MEN,
      event,
      time,
      timeType: 'SCY',
      source: 'swimcloud',
    };
  }
}

// --- 6. Ratio is the documented quantity: swim / published standard --------
{
  const bestByEvent = best({ '100 Freestyle': '45.01' });
  const r = rankEventsByQuality(bestByEvent, Gender.MEN, D2_TEAM);
  const ratio = r.ratioByEvent['100 Freestyle'];
  assert.ok(ratio > 0.5 && ratio < 2, `ratio should be near 1, got ${ratio}`);
  // A swim exactly twice as slow has exactly twice the ratio.
  const slower = best({ '100 Freestyle': '90.02' });
  const r2 = rankEventsByQuality(slower, Gender.MEN, D2_TEAM);
  assert.ok(
    Math.abs(r2.ratioByEvent['100 Freestyle'] / ratio - 2) < 0.01,
    'ratio scales linearly with the swim'
  );
}

console.log('event quality ranking: all assertions passed');
