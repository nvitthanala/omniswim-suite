/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Gender } from '../packages/core/src/types.ts';
import {
  buildMomentumSeriesForTeam,
  buildPrelimsExpectedRows,
  buildPrelimsOverUnderByEntryKey,
  sumPrelimsOuForSwimmers,
  sumPrelimsOuForTeam,
} from '../packages/core/src/lib/prelimsProjection.ts';
import { calculatePoints, mergeScoringSettings } from '../packages/core/src/lib/utils.ts';

const settings = mergeScoringSettings({});

const event = 'Event 1 Men 100 Yard Freestyle';
const prelims = {
  id: 'pre',
  rank: 4,
  name: 'Alice',
  classYear: 'SR',
  team: 'Henderson State',
  time: '49.50',
  prelimsTime: '49.50',
  roundSwam: 'Preliminaries',
  points: 0,
  event,
  gender: Gender.MEN,
  isRelay: false,
};
const finals = {
  id: 'fin',
  rank: 1,
  name: 'Alice',
  classYear: 'SR',
  team: 'Henderson State',
  time: '50.00',
  prelimsTime: '49.50',
  finalsTime: '50.00',
  roundSwam: 'A Final',
  points: 0,
  event,
  gender: Gender.MEN,
  isRelay: false,
};

const expected = buildPrelimsExpectedRows([prelims, finals], settings);
const baseline = calculatePoints([finals], settings);
const lookup = buildPrelimsOverUnderByEntryKey(baseline, expected);

const rowSum = sumPrelimsOuForSwimmers([prelims, finals], lookup);
const teamSum = sumPrelimsOuForTeam('Henderson State', lookup);
if (rowSum !== teamSum) {
  console.error('FAIL: deduped row sum should match team sum', rowSum, teamSum);
  process.exit(1);
}

const series = buildMomentumSeriesForTeam('Henderson State', lookup, [event]);
const seriesTotal = series.length ? series[series.length - 1].cumulative : 0;
if (Math.abs(seriesTotal - teamSum) > 0.05) {
  console.error('FAIL: momentum cumulative should match team O/U', seriesTotal, teamSum);
  process.exit(1);
}

// Timed-finals relay: 0 delta
const relayEvent = 'Event 10 Men 200 Yard Medley Relay';
const relayLegs = ['A', 'B', 'C', 'D'].map((name, i) => ({
  id: `rl-${i}`,
  rank: 2,
  name,
  classYear: 'SR',
  team: 'Timed Team',
  time: '1:30.00',
  relayTeamTime: '1:30.00',
  roundSwam: 'Finals',
  points: 10,
  event: relayEvent,
  gender: Gender.MEN,
  isRelay: true,
}));
const relayLookup = buildPrelimsOverUnderByEntryKey(relayLegs, []);
const relaySeries = buildMomentumSeriesForTeam('Timed Team', relayLookup, [relayEvent]);
const relayDelta = relaySeries.find(p => p.rawEvent === relayEvent)?.delta ?? 0;
if (relayDelta !== 0) {
  console.error('FAIL: timed-finals relay should contribute 0 momentum delta, got', relayDelta);
  process.exit(1);
}

console.log('OK momentum series tests passed');

// Misaligned timeline lengths must not skew cumulative O/U (index-merge bug regression)
import { buildPrelimsDeltaTimeline } from '../packages/core/src/lib/prelimsProjection.ts';

const baselineTimeline = [
  { name: 'E1', fullEvent: 'Event 1 100 Free', TeamA: 20 },
  { name: 'E2', fullEvent: 'Event 2 200 Free', TeamA: 35 },
  { name: 'E3', fullEvent: 'Event 3 400 Free', TeamA: 50 },
];
const prelimsTimeline = [
  { name: 'E1', fullEvent: 'Event 1 100 Free', TeamA: 15 },
  { name: 'E3', fullEvent: 'Event 3 400 Free', TeamA: 40 },
];
const delta = buildPrelimsDeltaTimeline(baselineTimeline, baselineTimeline, prelimsTimeline);
const e2 = delta.find(p => p.fullEvent === 'Event 2 200 Free');
if (!e2 || e2.baselineDelta.TeamA !== 20) {
  console.error('FAIL: event 2 should carry prelims cumulative forward (+20 O/U), got', e2?.baselineDelta.TeamA);
  process.exit(1);
}
const last = delta[delta.length - 1];
if (last.baselineDelta.TeamA !== 10) {
  console.error('FAIL: final aligned O/U should be +10, got', last.baselineDelta.TeamA);
  process.exit(1);
}

console.log('OK timeline alignment tests passed');
