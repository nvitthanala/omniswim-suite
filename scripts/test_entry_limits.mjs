import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { mergeScoringSettings, NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import {
  canAcceptAnotherEntry,
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '../packages/core/src/lib/swimmerEntryLimits.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const men = ws.menResults ?? [];
const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });

assert.equal(
  NSISC_PRESET_SETTINGS.maxIndividualEntriesPerSwimmer,
  999,
  'NSISC has no per-type individual cap (total-only)'
);
assert.equal(
  NSISC_PRESET_SETTINGS.maxRelayEntriesPerSwimmer,
  999,
  'NSISC has no per-type relay cap (total-only)'
);

const sample = men.find(r => !r.isRelay);
if (sample) {
  const counts = countSwimmerEntries(men, sample.team, Gender.MEN, sample.name);
  const label = formatEntryLimitLabel(counts, settings);
  const over = swimmerExceedsEntryLimits(counts, settings);
  console.log('sample athlete', sample.name, label, over);
}

// --- NSISC total cap (7 combined) --------------------------------------------
assert.equal(
  NSISC_PRESET_SETTINGS.maxTotalEntriesPerSwimmer,
  7,
  'NSISC total entry cap is 7'
);

const nsisc = mergeScoringSettings({}, { conference: 'NSISC Championship' });
assert.equal(nsisc.maxTotalEntriesPerSwimmer, 7, 'NSISC conference merge carries total cap');

// 3 ind + 4 relay = 7 total: at the cap, not over, but cannot accept another.
const atCap = { individual: 3, relayEvents: new Set(), relayCount: 4, total: 7 };
const overAtCap = swimmerExceedsEntryLimits(atCap, nsisc);
assert.ok(!overAtCap.totalOver, '7 total is not over the cap');
assert.ok(
  !canAcceptAnotherEntry(atCap, nsisc, '200 Freestyle Relay'),
  'no 8th event allowed at 7 total'
);
assert.ok(
  !canAcceptAnotherEntry(atCap, nsisc, '100 Freestyle'),
  'no 8th individual allowed at 7 total'
);

// Total-only: any mix under 7 is legal — 5 ind + 1 relay can add either type.
const sixTotal = { individual: 5, relayEvents: new Set(), relayCount: 1, total: 6 };
assert.ok(
  canAcceptAnotherEntry(sixTotal, nsisc, '100 Freestyle'),
  '6th individual allowed at 6 total (no per-type cap)'
);
assert.ok(
  canAcceptAnotherEntry(sixTotal, nsisc, '200 Medley Relay'),
  '2nd relay allowed at 6 total'
);
assert.ok(
  !swimmerExceedsEntryLimits({ individual: 5, relayEvents: new Set(), relayCount: 2, total: 7 }, nsisc).individualOver,
  '5 individuals not flagged over (total-only)'
);

// 8 total flags totalOver.
const overCap = { individual: 4, relayEvents: new Set(), relayCount: 4, total: 8 };
assert.ok(swimmerExceedsEntryLimits(overCap, nsisc).totalOver, '8 total flags totalOver');

// Label switches to total form when the cap is set.
const totalLabel = formatEntryLimitLabel(atCap, nsisc);
assert.ok(totalLabel.includes('7/7 total'), `label shows total cap (${totalLabel})`);

// Generic settings (no total cap) unchanged: total never blocks.
const generic = mergeScoringSettings({});
assert.ok(
  canAcceptAnotherEntry(atCap, generic, '100 Freestyle'),
  'generic settings have no total cap'
);
assert.ok(!swimmerExceedsEntryLimits(overCap, generic).totalOver, 'generic totalOver false');

console.log('entry limit tests passed');
