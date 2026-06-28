import { readFileSync } from 'fs';

import {

  buildSyntheticLegSplitDetail,

  displayTimeForRelayLeg,

  formatLegSplitSummary,

  formatTeamSplitSummary,

  isPlausibleLegTotal,

  normalizeRelayLegSplitDetail,

  normalizeSwimmerResultRelayFields,

  parseRelayDistanceYards,

  rebuildTeamSplitSummary,

} from '../packages/core/src/lib/relaySplits.ts';

import { simulateRoster, calculatePoints, mergeScoringSettings } from '../packages/core/src/lib/utils.ts';



const detail = buildSyntheticLegSplitDetail(0, 'free', 200, '1:37.39', [

  { yards: 200, segmentTime: '1:37.39', cumulativeLeg: '1:37.39' },

]);

console.log('formatLegSplitSummary', formatLegSplitSummary(detail));



const summary = rebuildTeamSplitSummary(['1:37.39', '1:40.48', '1:35.89', '1:39.12'], '6:35.54');

console.log('team summary halves', summary.firstHalf, summary.secondHalf);



console.log('4x200 distance', parseRelayDistanceYards('Event 2 Men 4x200 Yard Freestyle Relay'));



const snakeDetail = {

  leg_index: 0,

  stroke: 'free',

  leg_distance_yards: 200,

  segments: [{ yards: 200, segment_time: '1:37.39', cumulative_leg: '1:37.39' }],

  leg_total: '1:37.39',

};

const normalized = normalizeRelayLegSplitDetail(snakeDetail);

if (!normalized?.legTotal || normalized.legTotal !== '1:37.39') {

  throw new Error('snake_case detail normalization failed');

}

console.log('normalize snake_case legTotal', normalized.legTotal);



if (!isPlausibleLegTotal('1:37.39', 200)) throw new Error('1:37.39 should be plausible for 200');

if (isPlausibleLegTotal('6:35.54', 200)) throw new Error('team clock must not be plausible leg total');

if (isPlausibleLegTotal('5:18.69', 200)) throw new Error('cumulative team clock must not be plausible leg total');



const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));

const ws = meets[0];

const stefanRaw = (ws.menResults || []).find(

  r => r.isRelay && r.name === 'Stefan Duca' && String(r.event || '').includes('Event 2')

);

if (stefanRaw) {

  const stefan = normalizeSwimmerResultRelayFields(stefanRaw);

  const display = displayTimeForRelayLeg(stefan);

  console.log('Stefan legacy display (expect em-dash for corrupt data, not team clock):', display);

  if (display === '6:35.54' || display === stefanRaw.time) {

    throw new Error('displayTimeForRelayLeg must not return team clock for relay leg');

  }

}



const vinceRaw = (ws.menResults || []).find(

  r => r.isRelay && r.name === 'Vince Pal' && String(r.event || '').includes('Event 2')

);

if (vinceRaw) {

  const vince = normalizeSwimmerResultRelayFields(vinceRaw);

  const display = displayTimeForRelayLeg(vince);

  console.log('Vince anchor display (expect ~1:39):', display);

  if (display === '6:35.54') throw new Error('anchor leg must not show team clock');

}



const medleyAnchor = (ws.menResults || []).find(

  r =>

    r.isRelay &&

    r.relayLegIndex === 3 &&

    String(r.event || '').includes('Medley') &&

    r.relayTeamSplits?.leg_totals

);

if (medleyAnchor) {

  const norm = normalizeSwimmerResultRelayFields(medleyAnchor);

  console.log('medley team splits summary', formatTeamSplitSummary(norm.relayTeamSplits));

}



const men = (ws.menResults || [])

  .filter(r => r.isRelay && String(r.event || '').includes('Event 2') && r.relayLegIndex === 0)

  .map(normalizeSwimmerResultRelayFields);

const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });

const scored = calculatePoints(men, settings, { scorerRosterOverrides: ws.scorerRosterOverrides || [] });

const pts = scored.map(r => r.points);

console.log('Event 2 men relay legs scored:', pts.length, 'sample pts', pts.slice(0, 4));

const positive = pts.filter(p => typeof p === 'number' && p > 0);

if (positive.length >= 4) {

  const sum = positive.slice(0, 4).reduce((a, b) => a + b, 0);

  console.log('first relay unit leg sum', sum, 'per leg', positive[0]);

}



const relayLeg = men[0];

if (relayLeg) {

  console.log('displayTimeForRelayLeg (normalized legacy)', displayTimeForRelayLeg(relayLeg));

}



const simInput = (ws.menResults || [])

  .filter(

    r =>

      !r.isRecruit &&

      r.team === 'Ouachita Baptist University' &&

      (r.isRelay ? String(r.event || '').includes('Event 2') && r.finalsTime === '6:35.54' : true)

  )

  .map(normalizeSwimmerResultRelayFields);

const withSeniorRemoval = simulateRoster(simInput, [], true);

const ouachitaAFinal = withSeniorRemoval.filter(

  r =>

    r.isRelay &&

    r.team === 'Ouachita Baptist University' &&

    String(r.event || '').includes('Event 2') &&

    (r.relayTeamTime === '6:35.54' || r.finalsTime === '6:35.54')

);

if (ouachitaAFinal.length) {

  const replaced = ouachitaAFinal.filter(r => r.relayLegSplitDetail);

  console.log(

    'simulateRoster A-final legs',

    ouachitaAFinal.length,

    'with split detail',

    replaced.length

  );

  if (replaced.length) {

    console.log('sample rebuilt split', replaced[0].name, displayTimeForRelayLeg(replaced[0]));

  }

} else {

  console.log('simulateRoster: Ouachita A-final relay time changed after senior removal');

}



console.log('relay split tests ok');

