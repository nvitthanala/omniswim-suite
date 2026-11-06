/** @license SPDX-License-Identifier: Apache-2.0 */
// A relay has no A or B heat: it is swum once, as a timed final (tier FIN). The Python scorer must
// count a leg of it as a scorer, and treat the entry as roster-eligible, as
// packages/core/src/lib/scorerRoster.ts (`rowSuggestsScorer`, `relayEntryRosterEligible`) does.
// An individual timed-final swim (a 1650) must still mark no scorer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const harness = `
import json, sys
sys.path.insert(0, 'legacy/backend')
import point_calculator as pc
rules = {'abFinalTiers': ['A', 'B'], 'includeRelayLegsInFinals': True,
         'distanceFinalRequired': True, 'distanceEventPattern': ['1000', '1650', '1500']}
def row(name, rnd, relay, event='200 Yard Medley Relay'):
    return {'name': name, 'team': 'Alpha', 'gender': 'Men', 'round_swam': rnd, 'is_relay': relay, 'event': event}
cfg = {'scorerEligibilityMode': 'roster', 'scorerAutoRules': rules}
legs = [row(n, 'Timed Finals', True) for n in ['Ann', 'Bo', 'Cy', 'Di']]
off = {'scorerEligibilityMode': 'roster', 'scorerAutoRules': dict(rules, includeRelayLegsInFinals=False)}
is_scorer = pc._build_roster_is_scorer(legs, cfg)
label = dict(row('Alpha (A)', 'Timed Finals', True), relayNames=[{'name': 'Bo', 'year': ''}])
label_ab = dict(row('Alpha (A)', 'A Final', True), relayNames=[{'name': 'Bo', 'year': ''}])
print(json.dumps({
    'suggestsEntryLabelTimed': pc._row_suggests_scorer(label, rules),
    'suggestsEntryLabelAFinal': pc._row_suggests_scorer(label_ab, rules),
    'suggestsTimedRelay': pc._row_suggests_scorer(row('Bo', 'Timed Finals', True), rules),
    'suggestsFinalsRelay': pc._row_suggests_scorer(row('Bo', 'Finals', True), rules),
    'suggestsTimedIndividual': pc._row_suggests_scorer(row('Bo', 'Timed Finals', False, '1650 Yard Freestyle'), rules),
    'suggestsPrelimRelay': pc._row_suggests_scorer(row('Bo', 'Preliminaries', True), rules),
    'suggestsTimedRelayOff': pc._row_suggests_scorer(row('Bo', 'Timed Finals', True), off['scorerAutoRules']),
    'rosterHasRelayOnlyLeg': bool(is_scorer('Bo', 'Alpha', 'Men')),
    'eligibleTimedNoLookup': pc._relay_entry_roster_eligible(legs, cfg, None),
    'eligiblePrelimNoLookup': pc._relay_entry_roster_eligible([row(n, 'Preliminaries', True) for n in ['Ann']], cfg, None),
    'eligibleTimedOffNoLookup': pc._relay_entry_roster_eligible(legs, off, None),
}))
`;
const run = spawnSync('python', ['-c', harness], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(run.status, 0, `python harness failed:\n${run.stderr}`);
assert.deepEqual(JSON.parse(run.stdout), {
  suggestsEntryLabelTimed: false,
  suggestsEntryLabelAFinal: true,
  suggestsTimedRelay: true,
  suggestsFinalsRelay: true,
  suggestsTimedIndividual: false,
  suggestsPrelimRelay: false,
  suggestsTimedRelayOff: false,
  rosterHasRelayOnlyLeg: true,
  eligibleTimedNoLookup: true,
  eligiblePrelimNoLookup: false,
  eligibleTimedOffNoLookup: false,
});
console.log('PASS  Python scorer counts a timed-final relay leg as a scorer and its entry as eligible');
