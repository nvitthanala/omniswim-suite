/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Headless verification that the Matrix chart data pipeline produces
 * well-formed input for Recharts (timeline line chart + team standings +
 * per-team event series). Catches regressions in the scoring engine that
 * would render empty/blank graphs even when the UI itself is fine.
 */
import { readFileSync } from 'fs';
import { buildScoringSnapshot } from '../packages/core/src/lib/scoringEngine.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
if (!Array.isArray(meets) || meets.length === 0) {
  throw new Error('no workspaces in data/meets.json to verify');
}

let failures = 0;
const assert = (cond, msg) => {
  if (!cond) {
    failures += 1;
    console.error('  FAIL:', msg);
  }
};

for (const ws of meets) {
  for (const gender of [Gender.MEN, Gender.WOMEN]) {
    const { projected, baseline } = buildScoringSnapshot(ws, gender, false);
    const results = gender === Gender.MEN ? ws.menResults : ws.womenResults;
    const hasData = Array.isArray(results) && results.length > 0;
    if (!hasData) continue;

    console.log(`\n[${ws.name} / ${gender}] results=${results.length}`);

    // Timeline (the main line chart)
    assert(projected.timelineData.length > 0, 'timelineData should be non-empty');
    assert(projected.sortedTeams.length > 0, 'sortedTeams should be non-empty');

    // Every timeline row must carry a "name" (X axis) and at least one team series key
    const badRow = projected.timelineData.find(
      row => typeof row.name !== 'string' || Object.keys(row).length < 3
    );
    assert(!badRow, 'each timeline row needs name + team series keys');

    // Each Line's dataKey (team name) must exist on the last timeline row
    const last = projected.timelineData[projected.timelineData.length - 1] || {};
    const missingSeries = projected.sortedTeams.filter(t => !(t.teamName in last));
    assert(missingSeries.length === 0, `all team series present on timeline (missing: ${missingSeries.map(t => t.teamName).join(', ')})`);

    // Per-team standings + event grouping (TeamCard charts)
    const topTeam = projected.sortedTeams[0];
    assert(topTeam.totalPoints > 0, 'top team should have > 0 points');
    assert(Array.isArray(topTeam.swimmers) && topTeam.swimmers.length > 0, 'top team should have swimmers');

    console.log(
      `  timelinePoints=${projected.timelineData.length} teams=${projected.sortedTeams.length} ` +
        `top="${topTeam.teamName}" pts=${topTeam.totalPoints.toFixed(1)} ` +
        `baselineTeams=${baseline.sortedTeams.length}`
    );
  }
}

if (failures > 0) {
  console.error(`\nchart data test FAILED (${failures} assertion failures)`);
  process.exit(1);
}
console.log('\nchart data tests passed');
