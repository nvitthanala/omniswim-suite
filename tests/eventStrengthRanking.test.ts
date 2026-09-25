/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A swimmer's strongest events, ranked fairly (plans/2026-09-24 item B3).
 *
 * The defect: `buildCategorizedScoringInputs` picked a catalog athlete's
 * entries by raw seconds, so a 50 always beat a 1650. On the real HSU roster
 * it entered Colton Bennett, a distance swimmer, in the 50 Free, 50 Fly and
 * 100 Free, and entered swimmers in 25s and 50s of stroke that no
 * championship contests.
 *
 * The rule (user decision, 2026-09-24), one shared function for every entry
 * suggestion (`rankEventsByStrength`, lib/eventStrength.ts):
 *   1. a meet is loaded: the place the time would take in that meet's results;
 *   2. otherwise, and as rule 1's tiebreak: distance to the division cut;
 *   3. raw seconds only as the last resort.
 *
 * Real data only:
 *   - `tests/test_nsisc_output.json`: committed parser output of the 2026 NSISC
 *     Championships final results (mapped exactly as meetResultsReachProfile
 *     .test.ts maps it);
 *   - `tests/fixtures/hsu-2026-27-event-strength.json`: three Henderson State
 *     men's SwimCloud history rows, verbatim from the HSU 2026-27 Roster Plan
 *     workspace (provenance in the file).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type EventStrength,
  type HistoricalSwim,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import {
  buildEventProfileFromCatalog,
  categorizeBestEvents,
  getAthleteProfile,
  rankEventsByQuality,
} from '../packages/core/src/lib/athleteHistory';
import {
  catalogEventOrderByStrength,
  compareEventStrength,
  meetPlaceFieldForWorkspace,
  rankEventsByStrength,
  sameSwimmerPredicate,
} from '../packages/core/src/lib/eventStrength';
import {
  buildCategorizedScoringInputs,
  buildMeetPlaceField,
  convertTimeToSeconds,
} from '../packages/core/src/lib/utils';
import { buildMeetEventLabelIndex } from '../packages/core/src/lib/eventIdentity';
import { buildStoredSwim, type CatalogTeamRoster } from '../packages/core/src/lib/rosterCatalog';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { optimizeEventLineupForTeam } from '../packages/core/src/lib/rosterOptimizer';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const DSU = 'Delta State University';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type ParserRow = {
  rank: number | string | null;
  name: string;
  year: string | null;
  team: string;
  finals_time: string | null;
  prelims_time: string | null;
  round_swam: string | null;
  event: string;
  gender: string;
  is_relay: boolean;
  relay_team_time: string | null;
};

const parserOut = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'test_nsisc_output.json'), 'utf8')
) as ParserRow[];

function nsiscRows(gender: Gender): SwimmerResult[] {
  return parserOut
    .filter(a => (gender === Gender.WOMEN ? a.gender === 'Women' : a.gender !== 'Women'))
    .map((a, i) => ({
      id: `nsisc-${gender}-${i}`,
      rank: a.rank ? Number.parseInt(String(a.rank), 10) || 0 : 0,
      name: a.name,
      classYear: a.year || 'UNKNOWN',
      team: a.team,
      time: a.finals_time || a.prelims_time || 'NT',
      finalsTime: a.finals_time ?? undefined,
      roundSwam: a.round_swam ?? undefined,
      points: 0,
      event: a.event,
      gender,
      isRelay: Boolean(a.is_relay),
      relayTeamTime: a.relay_team_time ?? undefined,
      isTimeTrial: /\btime\s+trials?\b/i.test(a.event),
    })) as SwimmerResult[];
}

const menResults = nsiscRows(Gender.MEN);
const womenResults = nsiscRows(Gender.WOMEN);

const hsuFixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'hsu-2026-27-event-strength.json'), 'utf8')
) as { team: string; athleteHistory: HistoricalSwim[] };

function workspace(opts: {
  meet: boolean;
  history?: HistoricalSwim[];
  settings?: Workspace['scoringSettings'];
  conference?: string;
}): Workspace {
  const men = opts.meet ? menResults : [];
  return {
    id: 'ws-b3',
    name: 'B3',
    createdAt: 0,
    menResults: men,
    womenResults: [],
    sourceMenResults: men,
    sourceWomenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scoringSettings: opts.settings ?? { ...NSISC_PRESET_SETTINGS },
    conference: opts.conference,
    athleteHistory: opts.history ?? [],
  } as unknown as Workspace;
}

const withMeet = (history: HistoricalSwim[] = []) =>
  workspace({ meet: true, history, conference: 'NSISC' });
const noMeet = (history: HistoricalSwim[] = hsuFixture.athleteHistory) =>
  workspace({ meet: false, history, conference: 'NSISC' });

const profile = (ws: Workspace, team: string, name: string) =>
  getAthleteProfile(ws, team, Gender.MEN, name, NSISC_PRESET_SETTINGS);

const sec = (t: string) => convertTimeToSeconds(t);

/** A catalog roster built from the HSU fixture, as a SwimCloud import would store it. */
function hsuCatalog(): CatalogTeamRoster {
  const names = ['Colton Bennett', 'Avery Henke', 'Colin Candebat'];
  return {
    team: { id: 't-hsu', name: HSU, gender: 'Men', sortIndex: 0, createdAt: 0, updatedAt: 0 },
    athletes: names.map((fullName, i) => ({
      id: `a${i}`,
      teamId: 't-hsu',
      fullName,
      nameKey: fullName.toLowerCase(),
      gender: 'Men' as const,
      createdAt: 0,
      updatedAt: 0,
      times: hsuFixture.athleteHistory
        .filter(h => h.name === fullName)
        .map((h, j) =>
          buildStoredSwim({
            id: `t${i}-${j}`,
            athleteId: `a${i}`,
            event: h.event,
            timeText: h.time,
            timeType: h.timeType ?? 'SCY',
            source: 'paste',
            gender: Gender.MEN,
            division: 'D2',
            swimcloudBadge:
              h.swimcloudBadge === 'extracted' ? 'X' : h.swimcloudBadge === 'user_input' ? 'U' : null,
          })
        ),
    })),
  };
}

function catalogPicks(rows: SwimmerResult[], name: string): string[] {
  return rows.filter(r => String(r.id).startsWith('catalog_') && r.name === name).map(r => r.event);
}

// ---------------------------------------------------------------------------

describe('the fixtures are the real sources', () => {
  it('holds the 2026 NSISC men 400 IM field and the post-meet Boys 100 Breast', () => {
    const im = menResults
      .filter(r => r.event === 'Event 15 Men 400 Yard IM')
      .slice(0, 3)
      .map(r => [r.name, r.time, r.roundSwam]);
    expect(im).toStrictEqual([
      ['Nojus Skirutis', '3:55.11', 'A Final'],
      ['Riley Oakes', '3:57.33', 'A Final'],
      ['Hunter Rytting', '3:57.74', 'A Final'],
    ]);
    const boys = menResults.filter(r => r.event === 'Event 939 Boys 100 Yard Breaststroke');
    expect(boys.map(r => [r.name, r.time, r.roundSwam])).toStrictEqual([
      ['Jacob Hamblen', '53.66R', 'A Final'],
    ]);
  });

  it('holds the HSU rows verbatim', () => {
    expect(hsuFixture.athleteHistory).toHaveLength(105);
    const colton = hsuFixture.athleteHistory.filter(h => h.name === 'Colton Bennett');
    const row = (event: string, course: string) =>
      colton.find(h => h.event === event && h.timeType === course)?.time;
    expect(row('1000 Freestyle', 'SCY')).toBe('9:24.87');
    expect(row('50 Freestyle', 'SCY')).toBe('22.93');
    expect(row('400 Individual Medley', 'LCM')).toBe('4:38.09');
  });
});

describe('buildMeetPlaceField: where a time would finish in the loaded meet', () => {
  const field = buildMeetPlaceField(menResults, Gender.MEN);
  if (!field) throw new Error('the real NSISC results must hold a scored field');

  it('holds a field for every individual program event the meet swam', () => {
    expect([...field.events].sort()).toStrictEqual([
      '100 backstroke',
      '100 breaststroke',
      '100 butterfly',
      '100 freestyle',
      '1000 freestyle',
      '1650 freestyle',
      '200 backstroke',
      '200 breaststroke',
      '200 butterfly',
      '200 freestyle',
      '200 individual medley',
      '400 individual medley',
      '50 freestyle',
      '500 freestyle',
    ]);
  });

  it("places Riley Oakes's 3:57.33 second, with his own row left out of the field", () => {
    const own = sameSwimmerPredicate('Riley Oakes', DSU, Gender.MEN);
    expect(field.placeFor('400 IM', sec('3:57.33'), own)).toStrictEqual({
      place: 2,
      fieldSize: 14,
      meetEvent: 'Event 15 Men 400 Yard IM',
    });
    // Without the exclusion he is in the field he is placed in: A final 8 + B final 7.
    expect(field.placeFor('400 IM', sec('3:57.33'))?.fieldSize).toBe(15);
  });

  it('reads one event under every label', () => {
    for (const label of ['400 IM', '400 Individual Medley', 'Event 15 Men 400 Yard IM', '400 IM SCY']) {
      expect(field.placeFor(label, sec('4:00.00'))).toStrictEqual({
        place: 5,
        fieldSize: 15,
        meetEvent: 'Event 15 Men 400 Yard IM',
      });
    }
  });

  it('shares a place only on an exact tie', () => {
    // Anthony Paculba won 5th in 4:00.74.
    expect(field.placeFor('400 IM', sec('4:00.74'))?.place).toBe(5);
    expect(field.placeFor('400 IM', sec('4:00.75'))?.place).toBe(6);
  });

  it('places a time slower than the whole field last, never invents a better place', () => {
    expect(field.placeFor('1650 Freestyle', 2000)).toStrictEqual({
      place: 11,
      fieldSize: 10,
      meetEvent: 'Event 33 Men 1650 Yard Freestyle',
    });
  });

  it('measures the program 100 Breast, not the post-meet Boys swim', () => {
    // Jacob Hamblen swam 53.66 in Event 939. Were his row in the field, 53.70
    // would place second; Avery Henke's 54.27 won the program final.
    expect(field.placeFor('100 Breaststroke', sec('53.70'))).toStrictEqual({
      place: 1,
      fieldSize: 15,
      meetEvent: 'Event 26 Men 100 Yard Breaststroke',
    });
  });

  it('gives no place where the meet holds no field or the time is unusable', () => {
    expect(field.placeFor('100 Breaststroke Time Trial', 50)).toBeNull();
    expect(field.placeFor('50 Backstroke', 25)).toBeNull();
    expect(field.placeFor('100 IM', 50)).toBeNull();
    expect(field.placeFor('200 Freestyle Relay', 90)).toBeNull();
    expect(field.placeFor('1 mtr Diving', 300)).toBeNull();
    expect(field.placeFor('400 IM', 0)).toBeNull();
    expect(field.placeFor('400 IM', Number.NaN)).toBeNull();
    expect(field.placeFor('400 IM', Number.POSITIVE_INFINITY)).toBeNull();
    // Every row excluded: no field left, so no place.
    expect(field.placeFor('400 IM', 240, () => true)).toBeNull();
  });

  it('is null, not "last place", when there is no scored field to rank against', () => {
    expect(buildMeetPlaceField([], Gender.MEN)).toBeNull();
    expect(buildMeetPlaceField(undefined, Gender.MEN)).toBeNull();
    const prelimsOnly = menResults.filter(r => r.roundSwam === 'Preliminaries');
    expect(prelimsOnly.length).toBeGreaterThan(0);
    expect(buildMeetPlaceField(prelimsOnly, Gender.MEN)).toBeNull();
    // A metre-labelled meet: an SCY time has no place among metre swims.
    const metres = menResults.map(r => ({ ...r, event: r.event.replace(/\bYard\b/, 'Meter') }));
    expect(buildMeetPlaceField(metres, Gender.MEN)).toBeNull();
  });

  it("keeps the other gender's rows out of the field", () => {
    const mixed = buildMeetPlaceField([...menResults, ...womenResults], Gender.MEN);
    expect(mixed?.placeFor('400 IM', sec('4:00.00'))?.fieldSize).toBe(15);
    const women = buildMeetPlaceField(womenResults, Gender.WOMEN);
    expect(women?.placeFor('400 IM', sec('4:00.00'))?.meetEvent).toBe('Event 14 Women 400 Yard IM');
    // Even under one label (a SwimCloud import labels both genders "400 IM"),
    // a women's row is never a man's competitor.
    const plain = (rows: SwimmerResult[]) =>
      rows.filter(r => /400 Yard IM/.test(r.event)).map(r => ({ ...r, event: '400 IM' }));
    const oneLabel = buildMeetPlaceField([...plain(menResults), ...plain(womenResults)], Gender.MEN);
    expect(oneLabel?.placeFor('400 IM', sec('4:00.00'))?.fieldSize).toBe(15);
  });

  it('picks the label the what-if remap picks (shared rule)', () => {
    const index = buildMeetEventLabelIndex(menResults);
    expect(index.get('100 Breaststroke')).toBe('Event 26 Men 100 Yard Breaststroke');
    expect(index.size).toBe(14);
    for (const identity of field.events) {
      const placed = field.placeFor(identity, 1);
      expect([...index.values()]).toContain(placed?.meetEvent);
    }
  });
});

describe('rankEventsByStrength', () => {
  it('rule 1: ranks by the place in the loaded meet (Hunter Rytting)', () => {
    const p = profile(withMeet(), HSU, 'Hunter Rytting');
    expect(p.rankedAgainstMeet).toBe(true);
    expect(p.primaryEvents).toStrictEqual([
      'Event 37 Men 200 Yard Backstroke',
      'Event 15 Men 400 Yard IM',
      'Event 6 Men 200 Yard IM',
      'Event 24 Men 100 Yard Backstroke',
    ]);
    expect(p.primaryEvents.map(e => p.strengthByEvent?.[e]?.meetPlace)).toStrictEqual([2, 3, 5, 6]);
    expect(p.primaryEvents.every(e => p.strengthByEvent?.[e]?.basis === 'meet_place')).toBe(true);
    // The cut order differs: his 400 IM is his closest swim to the D2 cut.
    const cut = rankEventsByQuality(p.bestByEvent, Gender.MEN, HSU);
    expect(cut.ranked[0]).toBe('Event 15 Men 400 Yard IM');
    expect(cut.ranked).not.toStrictEqual(p.primaryEvents);
  });

  it('rule 2 breaks a tie on place (Colton Bennett: 500 and 1650 both 4th)', () => {
    const p = profile(withMeet(hsuFixture.athleteHistory), HSU, 'Colton Bennett');
    const s = p.strengthByEvent ?? {};
    const five = p.primaryEvents.find(e => /500/.test(e)) as string;
    const mile = p.primaryEvents.find(e => /1650/.test(e)) as string;
    expect([s[five].meetPlace, s[mile].meetPlace]).toStrictEqual([4, 4]);
    expect(s[five].cutRatio as number).toBeLessThan(s[mile].cutRatio as number);
    expect(p.primaryEvents.indexOf(five)).toBeLessThan(p.primaryEvents.indexOf(mile));
    expect(p.primaryEvents.slice(0, 3)).toStrictEqual([
      '1000 Freestyle',
      'Event 22 Men 500 Yard Freestyle',
      '1650 Freestyle',
    ]);
  });

  it('rule 2 with no meet loaded: distance to the D2 cut (Colton Bennett)', () => {
    const p = profile(noMeet(), HSU, 'Colton Bennett');
    expect(p.rankedAgainstMeet).toBe(false);
    expect(p.rankingDivision).toBe('D2');
    expect(p.primaryEvents.slice(0, 3)).toStrictEqual(['1000 Freestyle', '500 Freestyle', '1650 Freestyle']);
    const s = p.strengthByEvent ?? {};
    expect(p.primaryEvents.every(e => s[e].basis === 'cut_distance' && s[e].meetPlace === undefined)).toBe(true);
    // The order is the cut ratio's, unchanged from before B3 for a no-meet workspace.
    const cut = rankEventsByQuality(p.bestByEvent, Gender.MEN, HSU);
    expect(p.primaryEvents).toStrictEqual([...cut.ranked, ...cut.unranked]);
  });

  it('a converted metric time ranks on its SCY equivalent and stays an estimate', () => {
    const p = profile(noMeet(), HSU, 'Colton Bennett');
    const im = p.strengthByEvent?.['400 Individual Medley'];
    expect(p.bestByEvent['400 Individual Medley'].time).toBe('4:03.33');
    expect(p.bestByEvent['400 Individual Medley'].convertedFrom).toMatchObject({
      sourceCourse: 'LCM',
      sourceTime: '4:38.09',
    });
    expect(im?.estimate).toBe(true);
    expect(p.strengthByEvent?.['1000 Freestyle']?.estimate).toBeUndefined();
  });

  it('an event the meet did not contest ranks after every placed event, and says why', () => {
    const r = rankEventsByStrength(
      {
        '50 Backstroke': { timeSec: 22.0 },
        '400 IM': { timeSec: sec('4:30.00') },
        '100 Freestyle': { timeSec: sec('46.00') },
      },
      Gender.MEN,
      HSU,
      { meetField: meetPlaceFieldForWorkspace(withMeet(), Gender.MEN) }
    );
    expect(r.order).toStrictEqual(['100 Freestyle', '400 IM', '50 Backstroke']);
    // Faster than Mark Eberhard's 4:53.08 only: 15th of the 15-row field.
    expect(r.strengthByEvent['400 IM'].meetPlace).toBe(15);
    expect(r.strengthByEvent['50 Backstroke']).toStrictEqual({
      event: '50 Backstroke',
      timeSec: 22.0,
      basis: 'time',
    });
  });

  it('rule 3 is the last resort, and nothing is invented for an unmapped team', () => {
    const r = rankEventsByStrength(
      { '1650 Freestyle': { timeSec: 900 }, '50 Freestyle': { timeSec: 20 } },
      Gender.MEN,
      'Nowhere Community College XYZ'
    );
    expect(r.division).toBeNull();
    expect(r.rankedAgainstMeet).toBe(false);
    expect(r.order).toStrictEqual(['50 Freestyle', '1650 Freestyle']);
    for (const e of r.order) {
      expect(r.strengthByEvent[e].basis).toBe('time');
      expect(r.strengthByEvent[e].cutRatio).toBeUndefined();
      expect(r.strengthByEvent[e].meetPlace).toBeUndefined();
    }
  });

  it('keeps the cut-ranking fields rankEventsByQuality returns', () => {
    const best = profile(noMeet(), HSU, 'Avery Henke').bestByEvent;
    const { order, strengthByEvent, rankedAgainstMeet, ...quality } = rankEventsByStrength(best, Gender.MEN, HSU);
    expect(quality).toStrictEqual(rankEventsByQuality(best, Gender.MEN, HSU));
    expect(order).toHaveLength(Object.keys(best).length);
    expect(Object.keys(strengthByEvent).sort()).toStrictEqual(Object.keys(best).sort());
    expect(rankedAgainstMeet).toBe(false);
  });

  it('compareEventStrength: place, then cut ratio, then seconds, then label', () => {
    const s = (over: Partial<EventStrength>): EventStrength => ({
      event: 'x',
      timeSec: 60,
      basis: 'time',
      ...over,
    });
    // A place beats no place, even against a far better cut ratio.
    expect(compareEventStrength(s({ meetPlace: 20 }), s({ cutRatio: 0.9 }))).toBeLessThan(0);
    expect(compareEventStrength(s({ meetPlace: 2 }), s({ meetPlace: 3, cutRatio: 0.5 }))).toBeLessThan(0);
    expect(compareEventStrength(s({ meetPlace: 3, cutRatio: 1.01 }), s({ meetPlace: 3, cutRatio: 1.02 }))).toBeLessThan(0);
    expect(compareEventStrength(s({ cutRatio: 1.02 }), s({ timeSec: 20 }))).toBeLessThan(0);
    expect(compareEventStrength(s({ cutRatio: 1, timeSec: 50 }), s({ cutRatio: 1, timeSec: 60 }))).toBeLessThan(0);
    expect(compareEventStrength(s({ event: 'a' }), s({ event: 'b' }))).toBeLessThan(0);
    expect(compareEventStrength(s({ timeSec: Number.NaN }), s({ timeSec: 900 }))).toBeGreaterThan(0);
  });
});

describe('every profile builder uses the shared ranking', () => {
  it("getAthleteProfile ranks Avery Henke's events by place at the loaded meet", () => {
    const p = profile(withMeet(hsuFixture.athleteHistory), HSU, 'Avery Henke');
    expect(p.primaryEvents.slice(0, 3)).toStrictEqual([
      '100 Breaststroke',
      '200 Breaststroke',
      '200 Individual Medley',
    ]);
    expect(p.strengthByEvent?.['100 Breaststroke']).toMatchObject({
      meetPlace: 1,
      meetFieldSize: 14,
      meetEvent: 'Event 26 Men 100 Yard Breaststroke',
      basis: 'meet_place',
    });
    // Without the meet the D2 cut puts the 200 IM ahead of the 200 Breast.
    expect(profile(noMeet(), HSU, 'Avery Henke').primaryEvents.slice(0, 3)).toStrictEqual([
      '100 Breaststroke',
      '200 Individual Medley',
      '200 Breaststroke',
    ]);
  });

  it('buildEventProfileFromCatalog ranks by place when given the meet field', () => {
    const roster = hsuCatalog();
    const ws = withMeet();
    const field = meetPlaceFieldForWorkspace(ws, Gender.MEN);
    const placed = buildEventProfileFromCatalog(roster, HSU, Gender.MEN, 'Avery Henke', NSISC_PRESET_SETTINGS, null, field);
    const unplaced = buildEventProfileFromCatalog(roster, HSU, Gender.MEN, 'Avery Henke', NSISC_PRESET_SETTINGS);
    expect(placed?.primaryEvents.slice(0, 3)).toStrictEqual(['100 Breaststroke', '200 Breaststroke', '200 Individual Medley']);
    expect(placed?.rankedAgainstMeet).toBe(true);
    expect(unplaced?.primaryEvents.slice(0, 3)).toStrictEqual(['100 Breaststroke', '200 Individual Medley', '200 Breaststroke']);
    expect(unplaced?.rankedAgainstMeet).toBe(false);
  });

  it('an import spends the entry budget in place order at the loaded meet', () => {
    // Colin Candebat imported as a new swimmer into the real NSISC meet. His own
    // meet rows come out of the workspace so he is new; they are left out of
    // the field he is placed in either way. NSISC allows 7 events in total.
    const name = 'Colin Candebat';
    const meet = menResults.filter(
      r => r.name !== name && !(r.relayNames ?? []).some(leg => leg.name === name)
    );
    const ws = { ...withMeet(), menResults: meet, sourceMenResults: meet } as Workspace;
    const preview = hsuFixture.athleteHistory.filter(h => h.name === name);
    const res = importHistoryToRoster(ws, preview, { team: HSU, gender: Gender.MEN });
    const events = (res.patch.recruits ?? []).map(r => r.event);
    expect(events).toStrictEqual([
      '200 Individual Medley',
      '100 Butterfly',
      '100 Freestyle',
      '200 Butterfly',
      '200 Breaststroke',
      '200 Freestyle',
      '400 Individual Medley',
    ]);
    // His 200 Breast (2:02.39) would place 3rd of 11 at this meet, though it is
    // 1.6% off the D2 cut; by the cut alone his 1000 Free took the 7th slot.
    expect(events).not.toContain('1000 Freestyle');
  });

  it('categorizeBestEvents takes the meet field (the import path passes it)', () => {
    const swims = hsuFixture.athleteHistory.filter(h => h.name === 'Avery Henke');
    const field = meetPlaceFieldForWorkspace(withMeet(), Gender.MEN);
    const args = [swims, HSU, Gender.MEN, 'Avery Henke', NSISC_PRESET_SETTINGS, [], undefined, null] as const;
    expect(categorizeBestEvents(...args, field).primaryEvents.slice(0, 3)).toStrictEqual([
      '100 Breaststroke',
      '200 Breaststroke',
      '200 Individual Medley',
    ]);
    expect(categorizeBestEvents(...args).primaryEvents.slice(0, 3)).toStrictEqual([
      '100 Breaststroke',
      '200 Individual Medley',
      '200 Breaststroke',
    ]);
  });
});

describe('buildCategorizedScoringInputs: which catalog events fill the cap', () => {
  const cap3 = (ws: Workspace, eventOrder?: ReturnType<typeof catalogEventOrderByStrength>) =>
    buildCategorizedScoringInputs({
      workspace: ws,
      gender: Gender.MEN,
      rosterCatalog: hsuCatalog(),
      maxIndividualEntriesPerSwimmer: 3,
      ...(eventOrder ? { eventOrder } : {}),
    });

  it('no meet: the strongest events by the D2 cut, not the shortest', () => {
    const ws = noMeet([]);
    const rows = cap3(ws, catalogEventOrderByStrength({ workspace: ws, gender: Gender.MEN, team: HSU }));
    expect(catalogPicks(rows, 'Colton Bennett')).toStrictEqual(['1000 Freestyle', '500 Freestyle', '1650 Freestyle']);
    expect(catalogPicks(rows, 'Avery Henke')).toStrictEqual(['100 Breaststroke', '200 Individual Medley', '200 Breaststroke']);
    expect(catalogPicks(rows, 'Colin Candebat')).toStrictEqual(['200 Individual Medley', '100 Freestyle', '100 Butterfly']);
  });

  it('without an order it falls back to raw seconds: the bias B3 removes', () => {
    const rows = cap3(noMeet([]));
    expect(catalogPicks(rows, 'Colton Bennett')).toStrictEqual(['50 Freestyle', '50 Butterfly', '100 Freestyle']);
    expect(catalogPicks(rows, 'Avery Henke')).toStrictEqual(['50 Freestyle', '50 Backstroke', '50 Butterfly']);
  });

  it('meet loaded: the places the times would take there', () => {
    const ws = withMeet();
    const rows = cap3(ws, catalogEventOrderByStrength({ workspace: ws, gender: Gender.MEN, team: HSU }));
    expect(catalogPicks(rows, 'Avery Henke')).toStrictEqual(['100 Breaststroke', '200 Breaststroke', '200 Individual Medley']);
    expect(catalogPicks(rows, 'Colin Candebat')).toStrictEqual(['200 Individual Medley', '100 Butterfly', '100 Freestyle']);
  });

  it('refuses an order that drops or invents a time', () => {
    expect(() => cap3(noMeet([]), (_name, times) => times.slice(1))).toThrow(/eventOrder returned/);
  });

  it('the scoring engine passes the strength order (production path)', () => {
    // A binding cap: 3 individual events, no conference override.
    const ws = workspace({
      meet: false,
      settings: { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 3, maxTotalEntriesPerSwimmer: undefined },
    });
    const bundle = buildScoringBundle({
      workspace: ws,
      gender: Gender.MEN,
      removeSeniors: false,
      applyWhatIf: true,
      scorerRosterOverrides: [],
      rosterCatalog: hsuCatalog(),
    });
    expect(catalogPicks(bundle.allResults, 'Colton Bennett')).toStrictEqual([
      '1000 Freestyle',
      '500 Freestyle',
      '1650 Freestyle',
    ]);
  });

  it('the optimizer plans a catalog athlete in their strongest events at the loaded meet', () => {
    const settings = { ...NSISC_PRESET_SETTINGS, maxIndividualEntriesPerSwimmer: 3, maxTotalEntriesPerSwimmer: undefined };
    const ws = workspace({ meet: true, settings });
    const { plans } = optimizeEventLineupForTeam(ws, Gender.MEN, HSU, settings, hsuCatalog());
    const avery = plans.filter(p => p.name === 'Avery Henke').map(p => p.event);
    expect(avery).toStrictEqual(['100 Breaststroke', '200 Breaststroke', '200 Individual Medley']);
  });

  it('every production caller passes eventOrder', () => {
    // A new caller that forgets it silently gets the raw-seconds order back.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'node_modules' || name === 'dist') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) {
          const src = readFileSync(path, 'utf8');
          const calls = src.split('buildCategorizedScoringInputs(').slice(1);
          for (const call of calls) {
            const body = call.slice(0, call.indexOf(')'));
            if (/^\s*args: CategorizedScoringInputArgs/.test(body)) continue; // the definition
            if (!/eventOrder/.test(body)) offenders.push(`${path}: ${body.slice(0, 60).replace(/\s+/g, ' ')}`);
          }
        }
      }
    };
    walk(join(repoRoot, 'packages'));
    walk(join(repoRoot, 'apps'));
    expect(offenders).toStrictEqual([]);
  });
});
