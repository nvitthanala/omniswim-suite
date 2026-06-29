/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { Gender } from '../packages/core/src/types.ts';
import {
  buildPrelimsExpectedRows,
  buildPrelimsProjectedBundle,
  buildPrelimsDeltaTimeline,
  buildPrelimsOverUnderByEntryKey,
  hasPrelimsData,
  isPrelimsOuEligibleEvent,
  pointsForPrelimsSeedRank,
  prelimsClock,
  prelimsOuOverUnderForDisplay,
  resolvePrelimsRanksForEvent,
  roundAndRankForPrelimsSeed,
  sumPrelimsOuForSwimmers,
} from '../packages/core/src/lib/prelimsProjection.ts';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine.ts';
import {
  calculatePoints,
  eventScoringStage,
  mergeScoringSettings,
  pointsForPlacement,
} from '../packages/core/src/lib/utils.ts';

const settings = mergeScoringSettings({});

// --- pointsForPrelimsSeedRank: 4th prelims → 15 pts (NCAA default ladder) ---
const pts4 = pointsForPrelimsSeedRank(4, 'Event 1 Men 100 Yard Freestyle', settings);
const pts1 = pointsForPrelimsSeedRank(1, 'Event 1 Men 100 Yard Freestyle', settings);
if (pts4 !== 15) {
  console.error('FAIL: prelims rank 4 should score 15, got', pts4);
  process.exit(1);
}
if (pts1 !== 20) {
  console.error('FAIL: prelims rank 1 should score 20, got', pts1);
  process.exit(1);
}

// --- roundAndRankForPrelimsSeed ---
const seed10 = roundAndRankForPrelimsSeed(10, 8);
if (seed10.roundSwam !== 'B Final' || seed10.rank !== 2) {
  console.error('FAIL: prelims rank 10 should map to B Final place 2', seed10);
  process.exit(1);
}

// --- hasPrelimsData ---
const withPrelims = [
  {
    id: 'a',
    rank: 4,
    name: 'Alice',
    classYear: 'SR',
    team: 'Team A',
    time: '49.00',
    prelimsTime: '49.00',
    roundSwam: 'Preliminaries',
    points: 0,
    event: 'Event 1 Men 100 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
];
if (!hasPrelimsData(withPrelims)) {
  console.error('FAIL: expected hasPrelimsData true');
  process.exit(1);
}

// --- PDF prelims rank preferred over time sort ---
const eventRows = [
  {
    id: 'fast',
    rank: 1,
    name: 'Fast',
    classYear: 'SR',
    team: 'Team B',
    time: '48.00',
    prelimsTime: '48.00',
    roundSwam: 'Preliminaries',
    points: 0,
    event: 'Event 2 Men 200 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
  {
    id: 'slow-pdf4',
    rank: 4,
    name: 'SlowPdf',
    classYear: 'JR',
    team: 'Team B',
    time: '52.00',
    prelimsTime: '52.00',
    roundSwam: 'Preliminaries',
    points: 0,
    event: 'Event 2 Men 200 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
];
const ranks = resolvePrelimsRanksForEvent(eventRows);
if (ranks.get('Event 2 Men 200 Yard Freestyle|Team B|slowpdf') !== 4) {
  console.error('FAIL: PDF prelims rank 4 should win over time sort', ranks);
  process.exit(1);
}

// --- Alice +5 O/U example ---
const alicePrelims = {
  id: 'alice-pre',
  rank: 4,
  name: 'Alice',
  classYear: 'SR',
  team: 'Team A',
  time: '49.50',
  prelimsTime: '49.50',
  roundSwam: 'Preliminaries',
  points: 0,
  event: 'Event 1 Men 100 Yard Freestyle',
  gender: Gender.MEN,
  isRelay: false,
};
const aliceFinals = {
  id: 'alice-fin',
  rank: 1,
  name: 'Alice',
  classYear: 'SR',
  team: 'Team A',
  time: '50.00',
  prelimsTime: '49.50',
  finalsTime: '50.00',
  roundSwam: 'A Final',
  points: 0,
  event: 'Event 1 Men 100 Yard Freestyle',
  gender: Gender.MEN,
  isRelay: false,
};

const expectedAlice = buildPrelimsExpectedRows([alicePrelims, aliceFinals], settings);
const aliceExpected = expectedAlice.find(r => r.name === 'Alice');
if (!aliceExpected || aliceExpected.points !== 15) {
  console.error('FAIL: Alice prelims expected points should be 15, got', aliceExpected?.points);
  process.exit(1);
}

const baselineScored = calculatePoints([aliceFinals], settings);
const aliceActual = baselineScored.find(r => r.name === 'Alice');
if (!aliceActual || aliceActual.points !== 20) {
  console.error('FAIL: Alice finals actual points should be 20, got', aliceActual?.points);
  process.exit(1);
}

const aliceOu = (aliceActual.points ?? 0) - (aliceExpected.points ?? 0);
if (aliceOu !== 5) {
  console.error('FAIL: Alice O/U should be +5, got', aliceOu);
  process.exit(1);
}

const ouLookup = buildPrelimsOverUnderByEntryKey(baselineScored, expectedAlice);
const aliceDisplayOu = prelimsOuOverUnderForDisplay(aliceActual, ouLookup);
if (aliceDisplayOu !== 5) {
  console.error('FAIL: display O/U should use row credit not inflate actual, got', aliceDisplayOu);
  process.exit(1);
}

// Relay: leg credits only (typical) — O/U actual must match sum of leg shares, not inflate
const relayEvent = 'Event 5 Men 200 Yard Freestyle Relay';
const relayLegs = ['A', 'B', 'C', 'D'].map((name, i) => ({
  id: `leg-${i}`,
  rank: 1,
  name,
  classYear: 'JR',
  team: 'Team R',
  time: '1:20.00',
  prelimsTime: '1:21.00',
  finalsTime: '1:20.00',
  roundSwam: 'A Final',
  points: 5,
  event: relayEvent,
  gender: Gender.MEN,
  isRelay: true,
}));
const relayPrelims = relayLegs.map((r, i) => ({
  ...r,
  id: `pre-${i}`,
  time: '1:21.00',
  finalsTime: undefined,
  roundSwam: 'Preliminaries',
  rank: 1,
  points: 0,
}));
const relayExpected = buildPrelimsExpectedRows([...relayPrelims, ...relayLegs], settings);
const relayBaseline = calculatePoints(relayLegs, settings);
const relayOu = buildPrelimsOverUnderByEntryKey(relayBaseline, relayExpected);
const relayKey = `${relayEvent}|Team R|relay`;
const relayEntry = relayOu.get(relayKey);
const relayLegPts = relayBaseline.reduce((s, r) => s + (r.points ?? 0), 0);
if (!relayEntry || relayEntry.actual !== relayLegPts) {
  console.error('FAIL: relay actual should match leg credit sum', relayLegPts, 'got', relayEntry?.actual);
  process.exit(1);
}
if (prelimsOuOverUnderForDisplay(relayLegs[0], relayOu) != null) {
  console.error('FAIL: relay leg should not show display O/U');
  process.exit(1);
}

// Relay aggregate row + legs: must not double-count (20 team pts, not 20 + leg shares)
const relayTeamRow = {
  id: 'relay-team',
  rank: 1,
  name: 'Team R',
  classYear: 'JR',
  team: 'Team R',
  time: '1:20.00',
  prelimsTime: '1:21.00',
  finalsTime: '1:20.00',
  roundSwam: 'A Final',
  points: 20,
  event: relayEvent,
  gender: Gender.MEN,
  isRelay: true,
};
const relayBaselineDup = [
  ...relayLegs.map(r => ({ ...r, points: 5 })),
  relayTeamRow,
];
const relayOuDup = buildPrelimsOverUnderByEntryKey(relayBaselineDup, relayExpected);
const relayEntryDup = relayOuDup.get(relayKey);
if (!relayEntryDup || relayEntryDup.actual !== 20) {
  console.error('FAIL: relay actual should be 20 not team+legs, got', relayEntryDup?.actual);
  process.exit(1);
}

// --- Timed-finals relay (single Finals session) excluded from O/U ---
const timedRelayEvent = 'Event 10 Men 200 Yard Medley Relay';
const timedRelayLegs = ['W', 'X', 'Y', 'Z'].map((name, i) => ({
  id: `tleg-${i}`,
  rank: 2,
  name,
  classYear: 'SR',
  team: 'Colin Team',
  time: '1:30.00',
  relayTeamTime: '1:30.00',
  roundSwam: 'Finals',
  points: 10,
  event: timedRelayEvent,
  gender: Gender.MEN,
  isRelay: true,
}));
if (eventScoringStage(timedRelayLegs) !== 'timed_finals') {
  console.error('FAIL: relay Finals-only should be timed_finals stage');
  process.exit(1);
}
if (isPrelimsOuEligibleEvent(timedRelayEvent, timedRelayLegs)) {
  console.error('FAIL: timed-finals relay should be excluded from prelims O/U');
  process.exit(1);
}
const timedRelayExpected = buildPrelimsExpectedRows(timedRelayLegs, settings);
if (timedRelayExpected.length > 0) {
  console.error('FAIL: timed-finals relay should produce no prelims expected rows');
  process.exit(1);
}
const timedRelayOu = buildPrelimsOverUnderByEntryKey(timedRelayLegs, timedRelayExpected);
if (timedRelayOu.size > 0) {
  console.error('FAIL: timed-finals relay should not appear in O/U lookup');
  process.exit(1);
}

// --- Swimmer aggregate: timed-finals relay credits must not inflate personal O/U ---
const colinInd = {
  id: 'colin-fin',
  rank: 1,
  name: 'Colin Candebat',
  classYear: 'SR',
  team: 'Colin Team',
  time: '20.00',
  prelimsTime: '20.50',
  finalsTime: '20.00',
  roundSwam: 'A Final',
  points: 20,
  event: 'Event 1 Men 50 Yard Freestyle',
  gender: Gender.MEN,
  isRelay: false,
};
const colinPre = {
  ...colinInd,
  id: 'colin-pre',
  rank: 2,
  time: '20.50',
  finalsTime: undefined,
  roundSwam: 'Preliminaries',
  points: 0,
};
const colinExpected = buildPrelimsExpectedRows([colinPre, colinInd], settings);
const colinBaseline = calculatePoints([colinInd], settings);
const colinLookup = buildPrelimsOverUnderByEntryKey(colinBaseline, colinExpected);
const colinSwims = [colinInd, ...timedRelayLegs.map(l => ({ ...l, name: 'Colin Candebat' }))];
const swimmerOu = sumPrelimsOuForSwimmers(colinSwims, colinLookup, { includeRelay: false });
const indOu = prelimsOuOverUnderForDisplay(colinInd, colinLookup);
if (swimmerOu !== indOu) {
  console.error('FAIL: swimmer O/U should ignore timed-finals relays, got', swimmerOu, 'expected', indOu);
  process.exit(1);
}
const expectedColinOu =
  (colinBaseline.find(r => r.name === 'Colin Candebat')?.points ?? 0) -
  (colinExpected.find(r => r.name === 'Colin Candebat')?.points ?? 0);
if (Math.abs(swimmerOu - expectedColinOu) > 0.01) {
  console.error('FAIL: Colin individual O/U mismatch, got', swimmerOu, 'expected', expectedColinOu);
  process.exit(1);
}

// --- Timed-finals 1650 excluded ---
const distance1650 = [
  {
    id: 'd1',
    rank: 1,
    name: 'D1',
    classYear: 'JR',
    team: 'Team C',
    time: '15:00.00',
    finalsTime: '15:00.00',
    roundSwam: 'Finals',
    points: 0,
    event: 'Event 20 Men 1650 Yard Freestyle',
    gender: Gender.MEN,
    isRelay: false,
  },
];
if (isPrelimsOuEligibleEvent('Event 20 Men 1650 Yard Freestyle', distance1650)) {
  console.error('FAIL: timed-finals 1650 should be excluded from prelims O/U');
  process.exit(1);
}
if (eventScoringStage(distance1650) !== 'timed_finals') {
  console.error('FAIL: 1650 Finals-only should be timed_finals stage');
  process.exit(1);
}

// --- Time trial excluded ---
const ttRows = [
  {
    id: 'tt1',
    rank: 1,
    name: 'TT',
    classYear: 'FR',
    team: 'Team D',
    time: '20.00',
    prelimsTime: '20.00',
    roundSwam: 'Preliminaries',
    points: 0,
    event: 'Event 99 Men 50 Free Time Trial',
    gender: Gender.MEN,
    isRelay: false,
    isTimeTrial: true,
  },
];
if (isPrelimsOuEligibleEvent('Event 99 Men 50 Free Time Trial', ttRows)) {
  console.error('FAIL: time trial event should be excluded');
  process.exit(1);
}

// --- Full snapshot integration ---
const workspace = {
  id: 'test-prelims',
  name: 'Test',
  conference: 'NCAA',
  menResults: [alicePrelims, aliceFinals],
  womenResults: [],
  scoringSettings: settings,
};

const snapshot = buildScoringSnapshot(workspace, Gender.MEN, false);
const prelimsTeamA = snapshot.prelimsProjected.sortedTeams.find(t => t.teamName === 'Team A');
const baselineTeamA = snapshot.baseline.sortedTeams.find(t => t.teamName === 'Team A');

if (!prelimsTeamA || prelimsTeamA.totalPoints !== 15) {
  console.error('FAIL: Team A prelims anchor should be 15, got', prelimsTeamA?.totalPoints);
  process.exit(1);
}
if (!baselineTeamA || baselineTeamA.totalPoints !== 20) {
  console.error('FAIL: Team A baseline should be 20, got', baselineTeamA?.totalPoints);
  process.exit(1);
}

const baselineOu = baselineTeamA.totalPoints - prelimsTeamA.totalPoints;
if (baselineOu !== 5) {
  console.error('FAIL: Team A baseline O/U should be +5, got', baselineOu);
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

const emptyBundle = buildPrelimsProjectedBundle({
  workspace: { ...workspace, menResults: [] },
  gender: Gender.MEN,
});
if (emptyBundle.sortedTeams.length !== 0) {
  console.error('FAIL: empty prelims data should yield empty bundle');
  process.exit(1);
}

const clock = prelimsClock(aliceFinals);
if (clock !== '49.50') {
  console.error('FAIL: prelimsClock should prefer prelimsTime on finals row');
  process.exit(1);
}

// Sanity: direct placement lookup matches
if (pointsForPlacement('A Final', 4, 'Event 1 Men 100 Yard Freestyle', settings) !== 15) {
  console.error('FAIL: pointsForPlacement A Final 4th should be 15');
  process.exit(1);
}

console.log('OK prelims placement O/U tests');
console.log('  Alice expected:', aliceExpected.points, 'actual:', aliceActual.points, 'O/U:', aliceOu);
console.log('  Team A baseline O/U:', baselineOu);
