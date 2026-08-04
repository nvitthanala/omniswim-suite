/**
 * Arbitrage optimizer smoke tests.
 */
import assert from 'node:assert/strict';
import { Gender } from '../packages/core/src/types.ts';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import {
  buildArbitrageCards,
  optimizeWithArbitrage,
} from '../packages/core/src/lib/rosterArbitrage.ts';

const ws = {
  id: 'w',
  name: 't',
  createdAt: 1,
  menResults: [
    {
      id: '1',
      rank: 1,
      name: 'Fast, A',
      classYear: 'JR',
      team: 'Team A',
      time: '19.50',
      points: 0,
      event: '50 Freestyle',
      gender: Gender.MEN,
    },
    {
      id: '2',
      rank: 1,
      name: 'Fast, A',
      classYear: 'JR',
      team: 'Team A',
      time: '43.00',
      points: 0,
      event: '100 Freestyle',
      gender: Gender.MEN,
    },
    {
      id: '3',
      rank: 2,
      name: 'Other, B',
      classYear: 'SO',
      team: 'Team A',
      time: '20.20',
      points: 0,
      event: '50 Freestyle',
      gender: Gender.MEN,
    },
  ],
  womenResults: [],
  recruits: [],
  athleteHistory: [
    {
      name: 'Fast, A',
      team: 'Team A',
      gender: Gender.MEN,
      event: '200 Freestyle',
      time: '1:36.00',
      source: 'paste',
    },
  ],
  scoringSettings: { ...NSISC_PRESET_SETTINGS },
  scorerRosterOverrides: [],
  meetEntryPlans: [],
};

const cards = buildArbitrageCards(ws, Gender.MEN, 'Team A', NSISC_PRESET_SETTINGS);
assert.ok(Array.isArray(cards));

const indFirst = optimizeWithArbitrage(
  ws,
  Gender.MEN,
  'Team A',
  false,
  NSISC_PRESET_SETTINGS,
  'individual_first'
);
assert.ok(indFirst.meetEntryPlans.length >= 0);
assert.equal(indFirst.mode, 'individual_first');

const relayFirst = optimizeWithArbitrage(
  ws,
  Gender.MEN,
  'Team A',
  false,
  NSISC_PRESET_SETTINGS,
  'relay_first'
);
assert.equal(relayFirst.mode, 'relay_first');

console.log('roster arbitrage tests passed');
