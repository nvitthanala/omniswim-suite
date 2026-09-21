/**
 * Builds data/demo-seed.json — the workspace a fresh install starts from.
 *
 * Everything in it is invented. No real swimmer, school, meet or time appears,
 * and the names below are deliberately generic so nobody mistakes a row for a
 * result. The workspace name says so too, because a demo that reads as real
 * data is exactly the failure this file exists to prevent.
 */
import fs from 'node:fs';

const MEN = 'Men';
const WOMEN = 'Women';

const TEAM_A = 'Northgate University';
const TEAM_B = 'Riverside College';

const MEN_A = ['Avery Brooks', 'Casey Lindt', 'Devon Marsh', 'Elliot Pyne'];
const MEN_B = ['Finley Roe', 'Gray Halloway', 'Hayden Vale', 'Ira Trent'];
const WOMEN_A = ['Juno Ablett', 'Kit Marlowe', 'Lark Devon', 'Maren Ives'];
const WOMEN_B = ['Nova Reyes', 'Odessa Kane', 'Pia Solberg', 'Quinn Ashby'];

const EVENTS = [
  { n: 3, label: '50 Yard Freestyle', times: ['20.91', '21.14', '21.38', '21.55'] },
  { n: 6, label: '100 Yard Butterfly', times: ['49.62', '50.18', '50.44', '51.07'] },
  { n: 9, label: '100 Yard Breaststroke', times: ['55.31', '56.02', '56.77', '57.10'] },
  { n: 12, label: '200 Yard Freestyle', times: ['1:41.88', '1:42.55', '1:43.19', '1:44.02'] },
];

const POINTS = [20, 17, 16, 15, 14, 13, 12, 11];

let seq = 0;
const id = () => `demo-${String(++seq).padStart(4, '0')}`;

function eventRows(gender, eventDef, rosterA, rosterB) {
  // Alternate the two teams so standings are not a walkover.
  const swimmers = [rosterA[0], rosterB[0], rosterA[1], rosterB[1], rosterA[2], rosterB[2], rosterA[3], rosterB[3]];
  const teams = [TEAM_A, TEAM_B, TEAM_A, TEAM_B, TEAM_A, TEAM_B, TEAM_A, TEAM_B];
  return swimmers.map((name, i) => {
    const time = eventDef.times[i % eventDef.times.length];
    return {
      id: id(),
      rank: i + 1,
      name,
      classYear: ['FR', 'SO', 'JR', 'SR'][i % 4],
      team: teams[i],
      time,
      prelimsTime: null,
      finalsTime: time,
      roundSwam: 'A Final',
      points: POINTS[i] ?? 0,
      event: `Event ${eventDef.n} ${gender} ${eventDef.label}`,
      gender,
      isRelay: false,
      isExhibition: false,
      isTimeTrial: false,
    };
  });
}

const menResults = EVENTS.flatMap(e => eventRows(MEN, e, MEN_A, MEN_B));
const womenResults = EVENTS.flatMap(e => eventRows(WOMEN, e, WOMEN_A, WOMEN_B));

const workspace = {
  id: 'demo-workspace-0001',
  name: 'Demo meet (sample data — not real results)',
  menResults,
  womenResults,
  recruits: [],
  deletedSwimmers: [],
  createdAt: 0,
  // No conference, so no conference preset is auto-applied and the scoring
  // rule set stays the neutral default until the user picks one.
  scoringSettings: undefined,
};

// `createdAt: 0` and a fixed id keep this file byte-stable, so it does not
// churn in git every time it is regenerated.
const out = [workspace];
fs.writeFileSync('data/demo-seed.json', JSON.stringify(out, null, 2) + '\n', 'utf-8');
console.log(
  `wrote data/demo-seed.json — ${menResults.length} men rows, ${womenResults.length} women rows, ` +
    `${new Set([...menResults, ...womenResults].map(r => r.name)).size} invented swimmers, ` +
    `${(fs.statSync('data/demo-seed.json').size / 1024).toFixed(1)} KB`
);
