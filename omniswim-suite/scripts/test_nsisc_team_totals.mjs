import { readFileSync } from 'fs';
import {
  calculatePoints,
  mergeScoringSettings,
  looksLikeInstitutionTeamName,
} from '../packages/core/src/lib/utils.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets.find(m => m.conference === 'NSISC');
if (!ws) {
  console.error('NSISC workspace not found');
  process.exit(1);
}

const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });
const official = {
  'Women|University of West Florida': 1239,
  'Women|Delta State University': 916,
  'Women|Ouachita Baptist University': 536,
  'Women|Henderson State University': 476,
  'Men|Henderson State University': 1056,
  'Men|Ouachita Baptist University': 1029.5,
  'Men|Delta State University': 875.5,
};

let failed = false;

function teamTotals(results) {
  const scored = calculatePoints(results ?? [], settings, {
    scorerRosterOverrides: ws.scorerRosterOverrides,
  });
  const byTeam = {};
  for (const r of scored) {
    const tName = String(r.name ?? '').trim().toLowerCase();
    const tTeam = String(r.team ?? '').trim().toLowerCase();
    if (tName && tTeam === tName && !looksLikeInstitutionTeamName(r.team)) continue;
    const t = r.team;
    if (!t) continue;
    byTeam[t] = (byTeam[t] ?? 0) + (typeof r.points === 'number' ? r.points : 0);
  }
  return byTeam;
}

for (const [label, results] of [
  ['Women', ws.womenResults],
  ['Men', ws.menResults],
]) {
  const byTeam = teamTotals(results);
  for (const [team, off] of Object.entries(official)) {
    if (!team.startsWith(label + '|')) continue;
    const school = team.slice(label.length + 1);
    const calc = byTeam[school] ?? 0;
    const delta = Math.round((calc - off) * 100) / 100;
    const ok = Math.abs(delta) < 0.01;
    console.log(
      ok ? 'OK' : 'FAIL',
      `${label} ${school}:`,
      calc.toFixed(2),
      'official',
      off,
      'delta',
      delta.toFixed(2)
    );
    if (!ok) failed = true;
  }
}

process.exit(failed ? 1 : 0);
