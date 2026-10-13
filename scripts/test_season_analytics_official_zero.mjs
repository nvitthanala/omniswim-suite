/** @license SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { buildSeasonTrends } from '../packages/core/src/lib/seasonAnalytics.ts';

const workspace = {
  name: 'Official zero must win',
  officialTeamScores: { men: { 'Alpha University': 0 }, women: { 'Beta University': 0 } },
  menResults: [{ points: 99 }],
  womenResults: [{ points: 88 }],
};
// The trend is one team's score (user decision U7). Each published 0 belongs to a different team.
const men = buildSeasonTrends([workspace], { team: 'Alpha University' });
const women = buildSeasonTrends([workspace], { team: 'Beta University' });

assert.equal(men.teamScoreTrends[0].menTotal, 0, 'published men total 0 must not fall back to calculated points');
assert.equal(women.teamScoreTrends[0].womenTotal, 0, 'published women total 0 must not fall back to calculated points');
console.log('PASS  published official zero totals are not replaced by calculated totals');
