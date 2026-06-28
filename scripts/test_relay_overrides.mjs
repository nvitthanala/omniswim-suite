import { readFileSync } from 'fs';
import {
  convertTimeToSeconds,
  normalizeSwimmerName,
  simulateRoster,
} from '../packages/core/src/lib/utils.ts';
import {
  relayTemplateFromLeg,
  suggestBestRelayLegFill,
  swimmerMatchesRelayLeg,
  upsertRelayLegOverride,
} from '../packages/core/src/lib/relayLegMatching.ts';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits.ts';
import { Gender } from '../packages/core/src/types.ts';

const meets = JSON.parse(readFileSync('data/meets.json', 'utf8'));
const ws = meets[0];
const men = ws.menResults ?? [];

function findRelayWithSenior() {
  for (const r of men.filter(x => x.isRelay)) {
    const template = relayTemplateFromLeg(men, r);
    const names = template.relayNames ?? [];
    const legs =
      names.length > 0
        ? names
        : men
            .filter(
              x =>
                x.isRelay &&
                x.team === template.team &&
                x.event === template.event &&
                x.rank === template.rank
            )
            .map(x => ({ name: x.name, year: String(x.classYear) }));
    const seniorIdx = legs.findIndex(
      l => l.year === 'SR' || l.year === 'Sr' || l.year === 'Senior' || l.year === 'GR'
    );
    if (seniorIdx >= 0) return { template, seniorIdx };
  }
  return null;
}

let failed = 0;
const assert = (cond, msg) => {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
  }
};

const hit = findRelayWithSenior();
if (!hit) {
  console.log('SKIP: no men relay with senior leg in workspace');
  process.exit(0);
}

const { template, seniorIdx } = hit;
const entryKey = relayEntryKey(template);
const baseClock = convertTimeToSeconds(template.relayTeamTime || template.time);

const activePool = men.filter(r => {
  if (r.isRelay) return false;
  if (r.classYear === 'SR' || r.classYear === 'Sr' || r.classYear === 'Senior') return false;
  return true;
});

const vacantSim = simulateRoster(men, [], true, new Set());
const vacantGroup = vacantSim.filter(
  x => x.isRelay && relayEntryKey(relayTemplateFromLeg(men, x)) === entryKey
);
const vacantLeg = vacantGroup.find(x => (x.relayLegIndex ?? 0) === seniorIdx);
assert(vacantLeg?.relayLegVacant, 'vacant leg flagged');
assert(vacantLeg?.name === '—', 'vacant leg name is em dash');
assert(vacantLeg?.relayMissingLeg?.reason === 'vacant', 'vacant reason');
const vacantClock = convertTimeToSeconds(vacantLeg?.relayTeamTime || vacantLeg?.time || 'NT');
assert(vacantClock >= baseClock + 2.5, 'vacant adds ~3s penalty');

const manualOverride = {
  relayEntryKey: entryKey,
  legIndex: seniorIdx,
  manualLegTime: '59.99',
  source: 'manual',
};
const manualSim = simulateRoster(men, [], true, new Set(), [manualOverride]);
const manualLeg = manualSim.find(
  x =>
    x.isRelay &&
    relayEntryKey(relayTemplateFromLeg(men, x)) === entryKey &&
    (x.relayLegIndex ?? 0) === seniorIdx
);
assert(!manualLeg?.relayLegVacant, 'manual fill clears vacant flag');
const manualClock = convertTimeToSeconds(manualLeg?.relayTeamTime || manualLeg?.time || 'NT');
assert(manualClock !== vacantClock, 'manual time changes team clock');

const wrongStrokeRecruit = {
  id: 'test-wrong-stroke',
  rank: 0,
  name: 'Wrong Stroke Recruit',
  classYear: 'FR',
  team: template.team,
  time: '22.00',
  points: 0,
  event: '50 Freestyle',
  isRecruit: true,
  gender: Gender.MEN,
};
assert(
  !swimmerMatchesRelayLeg(wrongStrokeRecruit, template.event, seniorIdx),
  'stroke mismatch rejected'
);
const badOverride = upsertRelayLegOverride([], {
  relayEntryKey: entryKey,
  legIndex: seniorIdx,
  assigneeName: wrongStrokeRecruit.name,
  recruitId: wrongStrokeRecruit.id,
  source: 'drag',
});
const mismatchSim = simulateRoster(men, [wrongStrokeRecruit], true, new Set(), badOverride);
const mismatchLeg = mismatchSim.find(
  x =>
    x.isRelay &&
    relayEntryKey(relayTemplateFromLeg(men, x)) === entryKey &&
    (x.relayLegIndex ?? 0) === seniorIdx
);
assert(
  mismatchLeg?.relayMissingLeg?.reason === 'stroke_mismatch',
  'stroke mismatch override stays vacant'
);

const legNames =
  template.relayNames ??
  men
    .filter(
      x =>
        x.isRelay &&
        x.team === template.team &&
        x.event === template.event &&
        x.rank === template.rank &&
        (x.roundSwam || '').trim() === (template.roundSwam || '').trim()
    )
    .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0))
    .map(x => ({ name: x.name, year: String(x.classYear) }));
const exclude = new Set(
  legNames.map(l => normalizeSwimmerName(l.name)).filter(Boolean)
);
const fill = suggestBestRelayLegFill(activePool, template, seniorIdx, new Set(), exclude);
if (fill) {
  const autofillSim = simulateRoster(men, [], true, new Set(), [fill.override]);
  const filledLeg = autofillSim.find(
    x =>
      x.isRelay &&
      relayEntryKey(relayTemplateFromLeg(men, x)) === entryKey &&
      (x.relayLegIndex ?? 0) === seniorIdx
  );
  assert(
    normalizeSwimmerName(filledLeg?.name || '') === normalizeSwimmerName(fill.swimmer.name),
    'autofill assigns best swimmer'
  );

  const secondLegIdx = legNames.findIndex((_, i) => i !== seniorIdx);
  const secondLegName = legNames[secondLegIdx]?.name;
  const excluded = new Set([normalizeSwimmerName(secondLegName)]);
  const doubleBook = upsertRelayLegOverride([fill.override], {
    ...fill.override,
    legIndex: secondLegIdx,
  });
  const rosterWithTwoVacant = simulateRoster(men, [], true, excluded, doubleBook);
  const legs = rosterWithTwoVacant.filter(
    x => x.isRelay && relayEntryKey(relayTemplateFromLeg(men, x)) === entryKey
  );
  const booked = legs.filter(
    l =>
      normalizeSwimmerName(l.name) === normalizeSwimmerName(fill.swimmer.name) && !l.relayLegVacant
  );
  assert(booked.length <= 1, 'same swimmer blocked on second leg in same event');
} else {
  console.log('SKIP autofill/double-book: no eligible candidate');
}

if (failed > 0) {
  console.error(`${failed} test(s) failed`);
  process.exit(1);
}
console.log('relay override tests passed');
