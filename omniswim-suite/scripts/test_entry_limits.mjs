import { readFileSync } from 'fs';
import { mergeScoringSettings, NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults.ts';
import {
  countSwimmerEntries,
  formatEntryLimitLabel,
  swimmerExceedsEntryLimits,
} from '../packages/core/src/lib/swimmerEntryLimits.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const men = ws.menResults ?? [];
const settings = mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });

console.assert(
  NSISC_PRESET_SETTINGS.maxIndividualEntriesPerSwimmer === 3,
  'NSISC ind entry cap'
);
console.assert(
  NSISC_PRESET_SETTINGS.maxRelayEntriesPerSwimmer === 4,
  'NSISC relay entry cap'
);

const sample = men.find(r => !r.isRelay);
if (sample) {
  const counts = countSwimmerEntries(men, sample.team, Gender.MEN, sample.name);
  const label = formatEntryLimitLabel(counts, settings);
  const over = swimmerExceedsEntryLimits(counts, settings);
  console.log('sample athlete', sample.name, label, over);
}

console.log('entry limit tests passed');
