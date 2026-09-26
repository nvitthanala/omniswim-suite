/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Relay follow-ups found while fixing P15 (plans/2026-09-24, item R1).
 *
 *  (a) A Mixed-event row counts only for the swimmer's own gender.
 *  (b) A relay's distance comes from its own distance token, and a label that
 *      names none is refused, never read as 200.
 *  (c) An individual event's distance is its own token, never a HyTek entry
 *      number (the swap ranking's display key).
 *  (d) A graduate student (`GS`) graduates.
 *  (e) A history swim may fill a relay leg the meet holds no swim for.
 *  (f) The departed leg holder's swim is the relay team's own.
 *
 * The meet rows are real: `tests/fixtures/nsisc-2026-relay-followups-r1.json`
 * copies them verbatim from the 2026 NSISC Championships final results as
 * parsed into `data/meets.json`, and the first block ties every individual
 * time to the committed parser output, `tests/test_nsisc_output.json`. The
 * history swims are parsed here from the committed HSU roster export,
 * `hsuroster26-27.txt`. A test that needs a shape the real data does not hold
 * says so and names the real rows it varies.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type HistoricalSwim,
  type RelayLegOverride,
  type ScoringSettings,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import {
  findDepartedLegSwim,
  isGraduatingClassYear,
  simulateRoster,
} from '../packages/core/src/lib/utils';
import {
  parseRelayDistanceYards,
  parseRelayDistanceYardsOrNull,
  RelayDistanceUnreadableError,
  relayEntryKey,
  relayLegDistanceYardsOfEvent,
} from '../packages/core/src/lib/relaySplits';
import {
  buildRelayCandidateGenderIndex,
  eventLabelGender,
  individualEventDistanceStroke,
  isRelayCandidateOfGender,
  listEligibleRelayLegCandidates,
  relayCandidateGender,
  relayEntryGender,
  relayLegRequirements,
  resolveOverrideAssignee,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import {
  isRelayLegHistoryCandidate,
  relayLegHistoryCandidates,
} from '../packages/core/src/lib/relayLegHistoryCandidates';
import {
  historicalSwimFromResult,
  parseSwimCloudPasteDetailed,
} from '../packages/core/src/lib/athleteHistory';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';
import { rankRelayLegSwaps } from '../packages/core/src/lib/crossCourseArbitrage';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const DSU = 'Delta State University';
const OBU = 'Ouachita Baptist University';

const M_200FR = 'Event 31 Men 4x50 Yard Freestyle Relay';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
const M_400MR = 'Event 20 Men 4x100 Yard Medley Relay';

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };
const { menResults, womenResults } = fixture;
const menIndividuals = menResults.filter(r => !r.isRelay);

type ParserRow = {
  name: string;
  team: string;
  year: string;
  event: string;
  finals_time: string | null;
  prelims_time: string | null;
  gender: string;
  is_relay: boolean;
};
const parserOut = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'test_nsisc_output.json'), 'utf8')
) as ParserRow[];

/** One swimmer's block of the committed HSU roster export, checked at both ends. */
function rosterBlock(first: number, end: number, name: string, lastRow: RegExp): HistoricalSwim[] {
  const lines = readFileSync(join(repoRoot, 'hsuroster26-27.txt'), 'utf8').split(/\r?\n/);
  const block = lines.slice(first, end);
  expect(block[0]).toBe(name);
  expect(block[block.length - 1]).toMatch(lastRow);
  return parseSwimCloudPasteDetailed(block.join('\n'), { team: HSU, gender: Gender.MEN }).swims;
}

/** `hsuroster26-27.txt` lines 77-113. */
const coltonBennett = rosterBlock(76, 113, 'Colton Bennett', /^100 IM SCY\t57\.01\t/);
/** `hsuroster26-27.txt` lines 161-200. */
const gavinKock = rosterBlock(160, 200, 'Gavin Kock', /^100 IM SCY\t52\.57\t/);

/** The leg rows of one relay entry, in leg order. */
function relayLegRows(results: SwimmerResult[], team: string, event: string, rank: number): SwimmerResult[] {
  return results
    .filter(r => r.isRelay && r.team === team && r.event === event && r.rank === rank)
    .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
}

function fillOverride(template: SwimmerResult, legIndex: number, assigneeName: string): RelayLegOverride {
  return { relayEntryKey: relayEntryKey(template), legIndex, assigneeName, source: 'manual' };
}

/** Legs in an A/B final are not auto-eligible, so a non-scorer's vacated leg costs the relay. */
const STRICT: ScoringSettings = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
};

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-nsisc-2026-r1',
    name: '2026 NSISC (R1 relay follow-ups)',
    createdAt: 0,
    menResults,
    womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: NSISC_PRESET_SETTINGS,
    scorerRosterOverrides: [],
    ...over,
  } as Workspace;
}

/** Swap lines for a team with one leg holder marked a non-scorer. */
function swapsWithNonScorer(ws: Workspace, team: string, nonScorer: string): string[] {
  const w = { ...ws, scoringSettings: STRICT, scorerRosterOverrides: [{ name: nonScorer, team, gender: Gender.MEN, isScorer: false }] } as Workspace;
  return rankRelayLegSwaps(w, { team, gender: Gender.MEN, settings: STRICT }).swaps.map(
    s => `${s.relayEvent} leg${s.legIndex} ${s.inAthlete} ${s.inTime}${s.inFromHistory ? ' (history)' : ''}`
  );
}

describe('the fixture is the real meet', () => {
  it('every individual time agrees with the committed parser output', () => {
    const swimmers = new Set(
      [...menResults, ...womenResults].filter(r => !r.isRelay).map(r => `${r.name}|${r.team}`)
    );
    expect(swimmers.size).toBe(58);
    for (const key of swimmers) {
      const [name, team] = key.split('|');
      const ours = [...menResults, ...womenResults]
        .filter(r => !r.isRelay && r.name === name && r.team === team)
        .map(r => `${r.event} ${r.time}`)
        .sort();
      const parsed = parserOut
        .filter(r => !r.is_relay && r.name === name && r.team === team)
        .map(r => `${r.event} ${r.finals_time || r.prelims_time}`)
        .sort();
      expect(ours, key).toStrictEqual(parsed);
    }
  });

  it('holds the Mixed time trials, filed with the men', () => {
    const mixed = parserOut.filter(r => /\bMixed\b/.test(r.event));
    expect(mixed.map(r => [r.name, r.team, r.event, r.gender, r.finals_time])).toStrictEqual([
      ['Ave Owens', DSU, 'Event 403 Mixed 50 Yard Freestyle Time Trial', 'Men', '23.19'],
      ['Landon Dehn', OBU, 'Event 403 Mixed 50 Yard Freestyle Time Trial', 'Men', '28.98'],
      ['Anna Phelps', OBU, 'Event 503 Mixed 200 Yard Butterfly Time Trial', 'Men', '2:03.10'],
    ]);
    // Owens and Phelps swim the women's program; Dehn swims the men's.
    const program = (name: string) =>
      parserOut.filter(r => r.name === name && !/\bMixed\b/.test(r.event)).map(r => r.gender);
    expect(new Set(program('Ave Owens'))).toStrictEqual(new Set(['Women']));
    expect(new Set(program('Anna Phelps'))).toStrictEqual(new Set(['Women']));
    expect(new Set(program('Landon Dehn'))).toStrictEqual(new Set(['Men']));
  });

  it('holds the roster export rows the history tests lean on', () => {
    const at = (swims: HistoricalSwim[], event: string) =>
      swims.filter(s => s.event === event).map(s => [s.time, s.timeType, s.swimcloudBadge]);
    expect(at(coltonBennett, '50 Freestyle')).toStrictEqual([
      ['26.44', 'LCM', 'none'],
      ['22.93', 'SCY', 'none'],
    ]);
    // Extracted splits (`X`): never a best, never a leg candidate.
    expect(at(coltonBennett, '50 Backstroke')).toStrictEqual([
      ['27.01', 'SCY', 'extracted'],
      ['32.06', 'LCM', 'extracted'],
    ]);
    // A relay leadoff (`R`, line 173) is a swim from the blocks: a result.
    expect(at(gavinKock, '50 Freestyle').find(([, course]) => course === 'SCY')).toStrictEqual([
      '20.46',
      'SCY',
      'other',
    ]);
    // Colton Bennett swam no 50 Free at the meet; Gavin Kock swam 20.47.
    const meet50 = (name: string) =>
      menIndividuals.filter(r => r.name === name && r.event === 'Event 8 Men 50 Yard Freestyle').map(r => r.time);
    expect(meet50('Colton Bennett')).toStrictEqual([]);
    expect(meet50('Gavin Kock')).toStrictEqual(['20.47']);
  });
});

describe("(a) a Mixed-event row counts only for the swimmer's own gender", () => {
  it("Delta State's 200 Free Relay candidates hold no woman", () => {
    const names = listEligibleRelayLegCandidates(menIndividuals, M_200FR, 0, new Set(), DSU).map(
      r => `${r.name} ${r.time}`
    );
    // Before R1 the list ended with 'Ave Owens 23.19' (Event 403, Mixed).
    expect(names).toStrictEqual([
      'Ethan Baylin 20.36',
      'Lars Hetzel 21.03',
      'Sergio Rodriguez Rodriguez 21.22',
      'Kostantin Ilijic 21.45',
      'Alessandro Giustolisi 21.65',
    ]);
  });

  it("a man's Mixed swim still counts for the men (Landon Dehn)", () => {
    const rows = listEligibleRelayLegCandidates(menIndividuals, M_200FR, 0, new Set(), OBU).map(
      r => `${r.name} ${r.time} ${r.event}`
    );
    expect(rows).toStrictEqual([
      'Landon Dehn 21.58 Event 8 Men 50 Yard Freestyle',
      'Landon Dehn 28.98 Event 403 Mixed 50 Yard Freestyle Time Trial',
    ]);
  });

  it("naming Ave Owens for a men's leg leaves the leg vacant", () => {
    const legs = relayLegRows(menResults, DSU, M_200FR, 2);
    expect(legs.map(l => [l.name, l.relayLegSplit, l.relayTeamTime])[3]).toStrictEqual([
      'Austin Huffhines',
      '19.65',
      '1:21.60',
    ]);
    const out = simulateRoster(menResults, [], false, new Set(['austin huffhines']), [
      fillOverride(legs[0], 3, 'Ave Owens'),
    ]);
    const relay = relayLegRows(out, DSU, M_200FR, 2);
    // Before R1: 'Ave Owens' at 1:21.60 - 19.65 + 23.19 = 1:25.14.
    expect([relay[3].name, relay[3].relayLegVacant, relay[3].relayTeamTime]).toStrictEqual([
      '—',
      true,
      '1:24.60',
    ]);
  });

  it('the swap ranking never offers her either', () => {
    const swaps = swapsWithNonScorer(workspace(), DSU, 'Austin Huffhines');
    expect(swaps).toStrictEqual([
      `${M_200FR} leg3 Sergio Rodriguez Rodriguez 21.22`,
      `${M_200FR} leg3 Kostantin Ilijic 21.45`,
      `${M_200FR} leg3 Alessandro Giustolisi 21.65`,
    ]);
  });

  it("reads a Mixed row's gender from the swimmer's other rows", () => {
    const owensMixed = menIndividuals.find(r => r.name === 'Ave Owens')!;
    const dehnMixed = menIndividuals.find(r => r.name === 'Landon Dehn' && /Mixed/.test(r.event))!;
    expect(owensMixed.gender).toBe(Gender.MEN); // the results it was filed under
    const both = buildRelayCandidateGenderIndex([...menIndividuals, ...womenResults]);
    expect(relayCandidateGender(owensMixed, both)).toBe(Gender.WOMEN);
    expect(relayCandidateGender(dehnMixed, both)).toBe(Gender.MEN);
    // The men's results alone record nothing for her: unknown, never "Men".
    const menOnly = buildRelayCandidateGenderIndex(menIndividuals);
    expect(relayCandidateGender(owensMixed, menOnly)).toBeUndefined();
    expect(isRelayCandidateOfGender(owensMixed, Gender.MEN, menOnly)).toBe(false);
    expect(isRelayCandidateOfGender(owensMixed, Gender.WOMEN, both)).toBe(true);
    expect(isRelayCandidateOfGender(dehnMixed, Gender.MEN, menOnly)).toBe(true);
    // A Mixed row never fills a relay whose gender is unknown.
    expect(isRelayCandidateOfGender(dehnMixed, undefined, menOnly)).toBe(false);
  });

  it('reads the gender word of a label', () => {
    expect(eventLabelGender(M_200FR)).toBe(Gender.MEN);
    expect(eventLabelGender('Event 7 Women 50 Yard Freestyle')).toBe(Gender.WOMEN);
    expect(eventLabelGender('Event 403 Mixed 50 Yard Freestyle Time Trial')).toBe('mixed');
    expect(eventLabelGender('Event 939 Boys 100 Yard Breaststroke')).toBe(Gender.MEN);
    expect(eventLabelGender('200 Free Relay')).toBeNull();
    expect(relayEntryGender({ event: '200 Free Relay', gender: Gender.WOMEN })).toBe(Gender.WOMEN);
    expect(relayEntryGender({ event: 'Mixed 200 Yard Medley Relay', gender: Gender.MEN })).toBeUndefined();
  });

  it('a recruit row of the other gender does not resolve onto a leg', () => {
    const legs = relayLegRows(menResults, DSU, M_200FR, 2);
    const woman = { ...womenResults.find(r => r.name === 'Ave Owens' && /50 Yard Free/.test(r.event))!, team: DSU };
    expect(
      resolveOverrideAssignee(fillOverride(legs[0], 3, 'Ave Owens'), [woman], DSU, M_200FR, 3)
    ).toBeNull();
    expect(
      resolveOverrideAssignee(fillOverride(legs[0], 3, 'Ave Owens'), [woman], DSU, 'Event 30 Women 4x50 Yard Freestyle Relay', 3)
    ).toBe(woman);
  });
});

describe("(b) a relay's distance comes from its own distance token", () => {
  it('reads every relay label of the meet as its legs times the leg distance', () => {
    const labels = [...new Set(parserOut.filter(r => r.is_relay).map(r => r.event))];
    expect(labels.length).toBe(11);
    for (const label of labels) {
      const legs = /\b4x(\d+) Yard\b/.exec(label);
      expect(legs, label).not.toBeNull();
      expect(parseRelayDistanceYards(label), label).toBe(4 * Number(legs![1]));
    }
  });

  it('reads SwimCloud relay labels', () => {
    // As SwimCloud prints them on two captured meet pages.
    for (const [file, label, total] of [
      ['swimcloud-real-meet-landing-356467.html', '800 Free Relay', 800],
      ['swimcloud-real-meet-landing-379295-gender-m.html', '400 Free Relay', 400],
    ] as const) {
      const page = readFileSync(join(repoRoot, 'tests', 'fixtures', file), 'utf8');
      expect(page.includes(label), `${file}: ${label}`).toBe(true);
      expect(parseRelayDistanceYards(label), label).toBe(total);
    }
    // The same shape for the other championship relays.
    expect(parseRelayDistanceYards('200 Medley Relay')).toBe(200);
    expect(parseRelayDistanceYards('200 Free Relay SCY')).toBe(200);
  });

  it('reads the relay distance, never the HyTek entry number', () => {
    // The HyTek form with no "4x" token and an entry number past 100.
    // Before R1: 102 yards, 25.5-yard legs.
    const label = 'Event 102 Women 200 Yard Medley Relay';
    expect(parseRelayDistanceYards(label)).toBe(200);
    expect(relayLegRequirements(label, 1).legDistanceYards).toBe(50);
    expect(parseRelayDistanceYards('Event 202 Women 4x200 Yard Freestyle Relay Time Trial')).toBe(800);
  });

  it('refuses a label that names no distance, instead of reading 200', () => {
    for (const label of ['Event 10 Women Medley Relay', 'Relay', '']) {
      expect(parseRelayDistanceYardsOrNull(label), label).toBeNull();
      expect(relayLegDistanceYardsOfEvent(label), label).toBeNull();
      expect(() => parseRelayDistanceYards(label), label).toThrow(RelayDistanceUnreadableError);
    }
    // A four-leg relay's total divides by four.
    expect(parseRelayDistanceYardsOrNull('Event 5 Men 102 Yard Medley Relay')).toBeNull();
  });

  // Variant of the real rows: HSU's 200 Free Relay B final with its label's
  // distance token removed. The rows are otherwise verbatim.
  const UNREADABLE = 'Event 31 Men Yard Freestyle Relay';
  const relabelled = menResults.map(r => (r.isRelay && r.event === M_200FR ? { ...r, event: UNREADABLE } : r));

  it('a relay with no readable distance takes no swim', () => {
    const legs = relayLegRows(relabelled, HSU, UNREADABLE, 9);
    expect(legs.map(l => [l.name, l.classYear])[0]).toStrictEqual(['Scott Doll', 'SR']);
    expect(relayLegRequirements(UNREADABLE, 0).legDistanceYards).toBeNull();
    expect(menIndividuals.some(r => swimmerMatchesRelayLeg(r, UNREADABLE, 0))).toBe(false);
    // Reid Remmert (50 Free 21.00) fills the readable relay; the unreadable one stays vacant.
    const readable = simulateRoster(menResults, [], true, new Set(), [
      fillOverride(relayLegRows(menResults, HSU, M_200FR, 9)[0], 0, 'Reid Remmert'),
    ]);
    expect(relayLegRows(readable, HSU, M_200FR, 9)[0].name).toBe('Reid Remmert');
    const out = simulateRoster(relabelled, [], true, new Set(), [fillOverride(legs[0], 0, 'Reid Remmert')]);
    const relay = relayLegRows(out, HSU, UNREADABLE, 9);
    expect([relay[0].name, relay[0].relayLegVacant, relay[0].relayMissingLeg?.reason]).toStrictEqual([
      '—',
      true,
      'vacant',
    ]);
  });

  it('the lineup audit names the label', () => {
    const audit = buildTeamLineupAudit({
      workspace: workspace({ menResults: relabelled }),
      gender: Gender.MEN,
      team: HSU,
      settings: NSISC_PRESET_SETTINGS,
      allResults: relabelled,
      allScored: [],
      removeSeniors: false,
      detectDuplicates: false,
    });
    const items = audit.checklistItems.filter(i => i.type === 'relay_distance_unreadable');
    expect(items.map(i => [i.relayEvent, i.group])).toStrictEqual([[UNREADABLE, 'relays']]);
    const clean = buildTeamLineupAudit({
      workspace: workspace(),
      gender: Gender.MEN,
      team: HSU,
      settings: NSISC_PRESET_SETTINGS,
      allResults: menResults,
      allScored: [],
      removeSeniors: false,
      detectDuplicates: false,
    });
    expect(clean.checklistItems.some(i => i.type === 'relay_distance_unreadable')).toBe(false);
  });
});

describe("(c) an individual event's distance is its own token", () => {
  it('reads every single-stroke individual label of the meet', () => {
    const labels = [...new Set(parserOut.filter(r => !r.is_relay).map(r => r.event))];
    let singleStroke = 0;
    for (const label of labels) {
      const own = /\b(\d+) Yard (Freestyle|Backstroke|Breaststroke|Butterfly)\b/.exec(label);
      if (!own) {
        expect(individualEventDistanceStroke(label), label).toBeNull();
        continue;
      }
      singleStroke += 1;
      const stroke = { Freestyle: 'free', Backstroke: 'back', Breaststroke: 'breast', Butterfly: 'fly' }[own[2]];
      expect(individualEventDistanceStroke(label), label).toStrictEqual({ distance: Number(own[1]), stroke });
    }
    expect(singleStroke).toBeGreaterThan(20);
    // Entry numbers that the first-digits scan read as distances.
    expect(individualEventDistanceStroke('Event 35 Men 100 Yard Freestyle')).toStrictEqual({ distance: 100, stroke: 'free' });
    expect(individualEventDistanceStroke('Event 500 Women 100 Yard Butterfly Time Trial')).toStrictEqual({ distance: 100, stroke: 'fly' });
    expect(individualEventDistanceStroke('50 Free SCY')).toStrictEqual({ distance: 50, stroke: 'free' });
    expect(individualEventDistanceStroke('Event 6 Men 200 Yard IM')).toBeNull();
  });

  it('the swap ranking shows a HyTek-labelled history swim at its own distance', () => {
    // Vitor Sa's prelims 100 Free (45.57; the final was 45.90), as a loaded
    // meet stores it in history: `historicalSwimFromResult`, HyTek label.
    const row = menIndividuals.find(r => r.name === 'Vitor Sa' && r.event === 'Event 35 Men 100 Yard Freestyle')!;
    expect([row.prelimsTime, row.finalsTime]).toStrictEqual(['45.57', '45.90']);
    const prelim = historicalSwimFromResult({ ...row, time: row.prelimsTime! }, 'NSISC 2026 prelims')!;
    expect(prelim.event).toBe('Event 35 Men 100 Yard Freestyle');
    const swaps = swapsWithNonScorer(workspace({ athleteHistory: [prelim] }), HSU, 'Colton Bennett');
    // Before R1 the history swim keyed as a 35 Free, so the swap showed 45.90.
    expect(swaps).toContain(`${M_400FR} leg3 Vitor Sa 45.57`);
  });
});

describe('(d) a graduate student (GS) graduates', () => {
  it('Mark Eberhard is GS in the meet', () => {
    expect(parserOut.filter(r => r.year === 'GS').map(r => r.name)).toStrictEqual(Array(7).fill('Mark Eberhard'));
    const legs = relayLegRows(menResults, HSU, M_400MR, 10);
    expect(legs.map(l => [l.name, l.classYear])).toStrictEqual([
      ['Hunter Rytting', 'FR'],
      ['Mark Eberhard', 'GS'],
      ['Stevie Balistreri', 'JR'],
      ['Vitor Sa', 'SO'],
    ]);
  });

  it('isGraduatingClassYear reads GS with SR and GR, and guesses nothing else', () => {
    for (const y of ['GS', 'gs', ' Gs ', 'SR', 'GR', 'GRAD', 'Senior']) {
      expect(isGraduatingClassYear(y), y).toBe(true);
    }
    // 5Y and FY are the PDF parser's other year tokens; FY reads as "first
    // year" in some exports, so neither is guessed at.
    for (const y of ['5Y', 'FY', '5th', 'JR', 'FR', 'SO', 'HS', '', undefined, null]) {
      expect(isGraduatingClassYear(y), String(y)).toBe(false);
    }
  });

  it("drop seniors vacates his relay legs and drops his swims", () => {
    const out = simulateRoster(menResults, [], true);
    const relay = relayLegRows(out, HSU, M_400MR, 10);
    // Before R1 his breaststroke leg stayed: 'Mark Eberhard'.
    expect([relay[1].name, relay[1].relayLegVacant]).toStrictEqual(['—', true]);
    const projected = buildWhatIfResults({ workspace: workspace(), gender: Gender.MEN, removeSeniors: true });
    expect(projected.filter(r => r.name === 'Mark Eberhard')).toStrictEqual([]);
  });
});

describe('(e) a history swim fills a relay leg the meet holds no swim for', () => {
  const ws = workspace({ athleteHistory: [...coltonBennett, ...gavinKock] });
  const candidates = relayLegHistoryCandidates(ws, menIndividuals, Gender.MEN);
  const of = (name: string) =>
    candidates
      .filter(c => c.name === name)
      .map(c => [c.event, c.time, c.relayLegHistory!.time, c.relayLegHistory!.timeType, Boolean(c.convertedFrom)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  it("builds Colton Bennett's leg candidates from his results only", () => {
    expect(of('Colton Bennett')).toStrictEqual([
      // A metric swim is stated in SCY and says so; the fastest SCY-stated swim wins.
      ['100 Backstroke', '55.79', '1:06.02', 'LCM', true],
      ['100 Breaststroke', '1:04.80', '1:04.80', 'SCY', false],
      ['100 Butterfly', '51.82', '59.02', 'LCM', true],
      ['100 Freestyle', '48.98', '56.11', 'LCM', true],
      ['200 Freestyle', '1:41.40', '1:41.40', 'SCY', false],
      ['50 Butterfly', '23.14', '23.14', 'SCY', false],
      ['50 Freestyle', '22.93', '22.93', 'SCY', false],
      // No 50 Back or 50 Breast: his only ones are extracted splits (X).
    ]);
    const fifty = candidates.find(c => c.name === 'Colton Bennett' && c.event === '50 Freestyle')!;
    expect(isRelayLegHistoryCandidate(fifty)).toBe(true);
    expect([fifty.classYear, fifty.team, fifty.relayLegHistory!.meetLabel]).toStrictEqual([
      'JR',
      HSU,
      'ST TXLA Jingle Bell Splash',
    ]);
  });

  it('never replaces a meet swim: Gavin Kock keeps his meet 20.47, not his history 20.46', () => {
    expect(of('Gavin Kock').some(([event]) => event === '50 Freestyle')).toBe(false);
    const fifties = listEligibleRelayLegCandidates([...menIndividuals, ...candidates], M_200FR, 0, new Set(), HSU);
    expect(fifties.filter(r => r.name === 'Gavin Kock').map(r => r.time)).toStrictEqual(['20.47']);
  });

  it('offers Colton Bennett for a 50 Free leg, marked history', () => {
    const fifties = listEligibleRelayLegCandidates([...menIndividuals, ...candidates], M_200FR, 0, new Set(), HSU);
    const colton = fifties.filter(r => r.name === 'Colton Bennett');
    expect(colton.map(r => [r.time, isRelayLegHistoryCandidate(r)])).toStrictEqual([['22.93', true]]);
    // Before R1 the pool held only his meet rows, none of them a 50 Free.
    expect(listEligibleRelayLegCandidates(menIndividuals, M_200FR, 0, new Set(), HSU).some(r => r.name === 'Colton Bennett')).toBe(false);
  });

  it('a history candidate is only for a swimmer the pool holds', () => {
    const withoutColton = menIndividuals.filter(r => r.name !== 'Colton Bennett');
    expect(relayLegHistoryCandidates(ws, withoutColton, Gender.MEN).some(c => c.name === 'Colton Bennett')).toBe(false);
    expect(relayLegHistoryCandidates(ws, menIndividuals, Gender.WOMEN)).toStrictEqual([]);
  });

  it('an override naming him fills the leg in the projection', () => {
    const legs = relayLegRows(menResults, HSU, M_200FR, 9);
    expect(legs.map(l => [l.name, l.classYear, l.relayLegSplit])).toStrictEqual([
      ['Scott Doll', 'SR', '21.17'],
      ['Oskar Cebula', 'SR', '21.24'],
      ['Stevie Balistreri', 'JR', '20.69'],
      ['Avery Henke', 'JR', '20.20'],
    ]);
    const w = { ...ws, relayLegOverrides: [fillOverride(legs[0], 0, 'Colton Bennett')] } as Workspace;
    const relay = relayLegRows(buildWhatIfResults({ workspace: w, gender: Gender.MEN, removeSeniors: true }), HSU, M_200FR, 9);
    // Doll's own 50 Free (20.90) leaves, Bennett's 22.93 arrives; Cebula's
    // leg has no fill (+3.00): 1:23.30 + 2.03 + 3.00 = 1:28.33. Before R1 the
    // override resolved to nothing and both legs sat vacant: 1:29.30.
    expect(relay.map(r => r.name)).toStrictEqual(['Colton Bennett', '—', 'Stevie Balistreri', 'Avery Henke']);
    expect(relay[0].relayTeamTime).toBe('1:28.33');
    expect(relay[0].relayLegSplit).toBe('22.93');
    // A leg-only row never becomes an individual entry.
    const projected = buildWhatIfResults({ workspace: w, gender: Gender.MEN, removeSeniors: true });
    expect(projected.some(r => !r.isRelay && r.relayLegHistory)).toBe(false);
  });

  it('the swap ranking offers him from history, flagged', () => {
    const swaps = swapsWithNonScorer(ws, HSU, 'Scott Doll');
    expect(swaps).toContain(`${M_200FR} leg0 Colton Bennett 22.93 (history)`);
    expect(swaps).toContain(`${M_200FR} leg0 Gavin Kock 20.46`);
  });
});

describe("(f) the departed leg holder's swim is the relay team's own", () => {
  // Variant of the real rows: Landon Dehn's real 100 Free (Ouachita Baptist)
  // renamed "Austin Huffhines" and put first, so a namesake on another team
  // precedes Delta State's Huffhines. No such pair is in the loaded meet.
  const dehn100 = menIndividuals.find(r => r.name === 'Landon Dehn' && r.event === 'Event 35 Men 100 Yard Freestyle')!;
  const namesake = { ...dehn100, name: 'Austin Huffhines' };
  const withNamesake = [namesake, ...menResults];

  it("finds the team's own swim, not the first namesake", () => {
    expect([namesake.team, namesake.time]).toStrictEqual([OBU, '48.04']);
    expect(findDepartedLegSwim(withNamesake, 'Austin Huffhines', M_400FR, 3, DSU)?.time).toBe('45.85');
    expect(findDepartedLegSwim(withNamesake, 'Austin Huffhines', M_400FR, 3, OBU)?.time).toBe('48.04');
    expect(findDepartedLegSwim(withNamesake, 'Austin Huffhines', M_400FR, 3, HSU)).toBeUndefined();
  });

  it('simulateRoster measures the fill against it', () => {
    // As in the P15 test: 45.85 leaves, Sergio Rodriguez Rodriguez's 46.73
    // arrives, 3:00.20 + 0.88 = 3:01.08. Before R1 the namesake's 48.04 left.
    const legs = relayLegRows(menResults, DSU, M_400FR, 0);
    const out = simulateRoster(withNamesake, [], false, new Set(['austin huffhines']), [
      fillOverride(legs[0], 3, 'Sergio Rodriguez Rodriguez'),
    ]);
    expect(relayLegRows(out, DSU, M_400FR, 0)[3].relayTeamTime).toBe('3:01.08');
  });
});

describe('a swimmer never swims two legs of one relay (found by the R1 scenario run)', () => {
  it("naming the relay's anchor for its leadoff leaves the leadoff vacant", () => {
    const legs = relayLegRows(menResults, HSU, M_200FR, 1);
    expect(legs.map(l => [l.name, l.relayLegSplit])).toStrictEqual([
      ['Gavin Kock', '20.46'],
      ['Tristen Fergunson', '20.03'],
      ['Vitor Sa', '20.23'],
      ['Oliver Pozvai', '19.49'],
    ]);
    const out = simulateRoster(menResults, [], false, new Set(['gavin kock']), [
      fillOverride(legs[0], 0, 'Oliver Pozvai'),
    ]);
    const relay = relayLegRows(out, HSU, M_200FR, 1);
    // Before: Oliver Pozvai on legs 1 and 4 at 1:20.02. The anchor was added
    // to the relay's swimmers only when the walk reached leg 4.
    expect(relay.map(r => r.name)).toStrictEqual(['—', 'Tristen Fergunson', 'Vitor Sa', 'Oliver Pozvai']);
    expect([relay[0].relayMissingLeg?.reason, relay[0].relayTeamTime]).toStrictEqual([
      'stroke_mismatch',
      '1:23.21',
    ]);
  });
});
