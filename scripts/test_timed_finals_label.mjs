/** @license SPDX-License-Identifier: Apache-2.0 */
// "Timed Finals" holds the text "D FINAL" (TIME-D FINAL-s). The Python scorer must read it as a
// timed final, as packages/core/src/lib/scoringRules.ts does, and still treat a real D final as
// unscored.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const harness = `
import json, sys
sys.path.insert(0, 'backend')
import point_calculator as pc
print(json.dumps({
    'timed': pc.classify_round_tier('Timed Finals'),
    'dFinal': pc.classify_round_tier('D Final'),
    'timedRoundUnscored': pc.is_unscored_round_or_event('Timed Finals', '1650 Yard Freestyle', {'unscoredRounds': ['D FINAL']}),
    'timedEventUnscored': pc.is_unscored_round_or_event('Finals', 'Event 8 Women 400 Yard IM Timed Final', {'unscoredRounds': ['D FINAL']}),
    'dFinalUnscored': pc.is_unscored_round_or_event('D Final', '100 Yard Freestyle', {'unscoredRounds': ['D FINAL']}),
}))
`;
const run = spawnSync('python', ['-c', harness], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(run.status, 0, `python harness failed:\n${run.stderr}`);
assert.deepEqual(JSON.parse(run.stdout), {
  timed: 'FIN',
  dFinal: 'D',
  timedRoundUnscored: false,
  timedEventUnscored: false,
  dFinalUnscored: true,
});
console.log('PASS  Python scorer reads "Timed Finals" as a timed final and keeps a D final unscored');
