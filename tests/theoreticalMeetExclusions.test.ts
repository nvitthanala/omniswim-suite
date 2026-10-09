/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * T2: `excludedEvents` on `buildTheoreticalMeetSeeds` (rule 8 of packages/manager/src/lib/theoreticalMeetSeeds.ts).
 *
 * The user takes one chosen event out of a swimmer's lineup. The entry caps are applied to the order
 * without that event, by the same cap walk the builder always uses, so the next-best offered event may
 * fill the slot and the cap is never exceeded.
 *
 * ## Fixtures
 *
 * The same real inputs as tests/theoreticalMeetSeeds.test.ts: the real Ouachita Baptist roster page
 * (team 412) parsed by the real parser, and the real swimmer-times response
 * tests/fixtures/profile_fastest_times-1330318.json converted by the real converter. Under NSISC settings
 * (7 total) that swimmer has 14 SCY events; the strongest 7 are chosen (the order is pinned by
 * tests/theoreticalMeetSeeds.test.ts). Nothing here is a competition value typed by hand: every event and
 * time is read back from the builder's own output for the same input.
 * Constructed (and said so where used): one swimmer whose only swim is flagged exhibition.
 */
import { describe, expect, it } from 'vitest';

import { parseTeamRosterHtml, parseSwimmerFastestTimesJson } from '../packages/swimcloud/src/parser';
import type { SwimCloudAthlete } from '../packages/swimcloud/src/entities';
import { swimCloudSwimmerTimesToHistoricalSwims } from '../packages/manager/src/lib/swimCloudImportBridge';
import {
  TheoreticalMeetError,
  buildTheoreticalMeetSeeds,
  removedEventsCaveat,
  theoreticalEventExclusionKey,
  theoreticalSwimmerKey,
  type TheoreticalEventExclusion,
  type TheoreticalMeetAthleteInput,
  type TheoreticalMeetInput,
  type TheoreticalMeetSeeds,
  type TheoreticalSwimmerEvents,
} from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { Gender, type HistoricalSwim, type ScoringSettings } from '../packages/core/src/types';
import { GENERIC_TOP16_SETTINGS, NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { SWIMMER_BODY, rosterPage } from './helpers/multiTeamDriverHarness';

const RETRIEVED = '2026-10-03T12:00:00.000Z';
const OBU = 'Ouachita Baptist University';

const parsedRoster = (gender: 'M' | 'F') => {
  const parsed = parseTeamRosterHtml(rosterPage('412', gender), {
    sourceUrl: `https://www.swimcloud.com/team/412/roster/?gender=${gender}`,
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error('roster fixture does not parse');
  return parsed.data.athletes;
};
const MEN = parsedRoster('M');
const WOMEN = parsedRoster('F');

function swimsFor(athlete: SwimCloudAthlete, gender: Gender): HistoricalSwim[] {
  const parsed = parseSwimmerFastestTimesJson(SWIMMER_BODY, {
    sourceUrl: 'https://www.swimcloud.com/api/swimmers/1330318/profile_fastest_times/',
    retrievedAt: RETRIEVED,
    track: 'browser-extension',
  });
  if (!parsed.ok) throw new Error(parsed.failure.message);
  const converted = swimCloudSwimmerTimesToHistoricalSwims({ ...parsed.data, name: athlete.name }, { team: OBU, gender, retrievedAt: RETRIEVED });
  if (!converted.ok) throw new Error(converted.message);
  return [...converted.swims];
}

const withTimes = (athletes: readonly SwimCloudAthlete[], gender: Gender, take: number): TheoreticalMeetAthleteInput[] =>
  athletes.slice(0, take).map(athlete => ({ athlete, swims: swimsFor(athlete, gender), retrievedAt: RETRIEVED }));

/** 3 men and 2 women of one real roster, same team name. */
const teams = () => [
  { teamName: OBU, gender: Gender.MEN, rosterStatus: 'parsed' as const, rosterSeasonId: '29', athletes: withTimes(MEN, Gender.MEN, 3) },
  { teamName: OBU, gender: Gender.WOMEN, rosterStatus: 'parsed' as const, rosterSeasonId: '29', athletes: withTimes(WOMEN, Gender.WOMEN, 2) },
];

const meet = (over: Partial<TheoreticalMeetInput> = {}): TheoreticalMeetInput => ({
  meetId: 'ws-excl-1',
  course: 'SCY',
  scoringSettings: NSISC_PRESET_SETTINGS,
  teams: teams(),
  ...over,
});

const swimmerOf = (out: TheoreticalMeetSeeds, gender: Gender, index = 0): TheoreticalSwimmerEvents =>
  out.report.teams.find(t => t.gender === gender)!.eventsChosenPerSwimmer[index];
const chosenEvents = (s: TheoreticalSwimmerEvents) => s.events.filter(e => e.chosen).map(e => e.event);
const removal = (s: TheoreticalSwimmerEvents, event: string, gender = Gender.MEN): TheoreticalEventExclusion => ({
  teamName: OBU,
  gender,
  swimmerKey: s.swimmerKey,
  event,
});
const rowsOfSwimmer = (out: TheoreticalMeetSeeds, name: string, gender: Gender) => out.rows.filter(r => r.name === name && r.gender === gender);
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof TheoreticalMeetError) return e.code;
    throw e;
  }
  return undefined;
};

const base = buildTheoreticalMeetSeeds(meet());
const baseMan = swimmerOf(base, Gender.MEN);
const ORDER = baseMan.events.map(e => e.event);

describe('the baseline the removals are measured against', () => {
  it('has 14 offered events and the strongest 7 chosen, and every swimmer carries a key', () => {
    expect(ORDER.length).toBe(14);
    expect(chosenEvents(baseMan)).toEqual(ORDER.slice(0, 7));
    expect(baseMan.swimmerKey).toBe(theoreticalSwimmerKey(MEN[0]));
    expect(baseMan.swimmerKey).toMatch(/^(sc|nm):/);
    expect(base.report.unmatchedExclusions).toEqual([]);
    expect(base.report.teams.every(t => t.eventsRemovedByUser === 0)).toBe(true);
  });

  it('is unchanged by an empty or absent excludedEvents', () => {
    const empty = buildTheoreticalMeetSeeds(meet({ excludedEvents: [] }));
    expect(empty.rows).toEqual(base.rows);
    expect(empty.report).toEqual(base.report);
    expect(base.report.caveats.some(c => /removed by you/.test(c))).toBe(false);
  });
});

describe('removing a chosen event refills the slot under the same cap', () => {
  const victim = ORDER[2];
  const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: [removal(baseMan, victim)] }));
  const man = swimmerOf(out, Gender.MEN);

  it('drops that event, keeps the offered order, and marks the candidate removed by the user', () => {
    expect(man.events.map(e => e.event)).toEqual(ORDER);
    const gone = man.events.find(e => e.event === victim)!;
    expect(gone.chosen).toBe(false);
    expect(gone.notChosenReason).toBe('removed_by_user');
    expect(gone.rowId).toBeUndefined();
    expect(gone.chosenWithoutRemovals).toBe(true);
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).some(r => r.event === victim)).toBe(false);
  });

  it('fills the freed slot with the strongest event the cap had left out, and says so', () => {
    expect(chosenEvents(man)).toEqual([...ORDER.slice(0, 2), ...ORDER.slice(3, 8)]);
    const filler = man.events.find(e => e.event === ORDER[7])!;
    expect(filler.chosen).toBe(true);
    expect(filler.fillsRemovedSlot).toBe(true);
    expect(man.events.filter(e => e.fillsRemovedSlot === true).length).toBe(1);
    expect(man.events.slice(8).every(e => !e.chosen && e.notChosenReason === 'entry_cap')).toBe(true);
  });

  it('still enters exactly 7 events under the 7-total cap, with a source for each row and none for the removed one', () => {
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).length).toBe(7);
    expect(out.rows.length).toBe(base.rows.length);
    expect(out.sources.size).toBe(out.rows.length);
    const removedId = baseMan.events.find(e => e.event === victim)!.rowId!;
    expect(out.sources.has(removedId)).toBe(false);
    expect(out.rows.some(r => r.id === removedId)).toBe(false);
  });

  it('leaves every other swimmer, the other gender and the other events byte-identical', () => {
    for (let i = 1; i < 3; i += 1) expect(swimmerOf(out, Gender.MEN, i)).toEqual(swimmerOf(base, Gender.MEN, i));
    expect(swimmerOf(out, Gender.WOMEN, 0)).toEqual(swimmerOf(base, Gender.WOMEN, 0));
    expect(out.psychWomenResults).toEqual(base.psychWomenResults);
    const keep = (rows: readonly { id: string }[]) => rows.filter(r => !r.id.includes(encodeURIComponent(victim)) && !r.id.includes(encodeURIComponent(ORDER[7])));
    const sameSwimmer = (r: { name: string }) => r.name === MEN[0].name;
    expect(keep(out.rows.filter(sameSwimmer))).toEqual(keep(base.rows.filter(sameSwimmer)));
    expect(out.rows.filter(r => !sameSwimmer(r))).toEqual(base.rows.filter(r => !sameSwimmer(r)));
  });

  it('counts the removal in the team report and states it in the team and meet caveats', () => {
    const team = out.report.teams.find(t => t.gender === Gender.MEN)!;
    expect(team.eventsRemovedByUser).toBe(1);
    expect(out.report.teams.find(t => t.gender === Gender.WOMEN)!.eventsRemovedByUser).toBe(0);
    expect(team.caveats).toContain(removedEventsCaveat(1));
    expect(out.report.caveats).toContain(`All teams: ${removedEventsCaveat(1)}`);
    expect(out.report.unmatchedExclusions).toEqual([]);
  });
});

describe('the cap is never exceeded', () => {
  it('removing three chosen events still gives exactly 7 under NSISC (7 total)', () => {
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: [0, 1, 2].map(i => removal(baseMan, ORDER[i])) }));
    const man = swimmerOf(out, Gender.MEN);
    expect(chosenEvents(man)).toEqual(ORDER.slice(3, 10));
    expect(man.events.filter(e => e.fillsRemovedSlot === true).map(e => e.event)).toEqual(ORDER.slice(7, 10));
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).length).toBe(7);
  });

  it('removing 8 of 14 leaves exactly the 6 remaining events, never more than the cap, and says the slot stays empty', () => {
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: ORDER.slice(0, 8).map(e => removal(baseMan, e)) }));
    const man = swimmerOf(out, Gender.MEN);
    expect(chosenEvents(man)).toEqual(ORDER.slice(8));
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).length).toBe(6);
    // 7 events were chosen before, 6 are now: one freed slot has no event to fill it.
    expect(man.events.filter(e => e.chosenWithoutRemovals === true).length).toBe(7);
    expect(man.events.filter(e => e.fillsRemovedSlot === true).length).toBe(6);
  });

  it('removing every event leaves the swimmer in the report with no rows', () => {
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: ORDER.map(e => removal(baseMan, e)) }));
    const man = swimmerOf(out, Gender.MEN);
    expect(man.events.every(e => e.notChosenReason === 'removed_by_user')).toBe(true);
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN)).toEqual([]);
    expect(out.report.teams.find(t => t.gender === Gender.MEN)!.eventsRemovedByUser).toBe(14);
  });

  it('a per-type cap of 3 gives 3 rows after a removal', () => {
    const settings: ScoringSettings = { ...GENERIC_TOP16_SETTINGS, maxIndividualEntriesPerSwimmer: 3 };
    const plain = buildTheoreticalMeetSeeds(meet({ scoringSettings: settings }));
    const first = chosenEvents(swimmerOf(plain, Gender.MEN))[0];
    const out = buildTheoreticalMeetSeeds(meet({ scoringSettings: settings, excludedEvents: [removal(swimmerOf(plain, Gender.MEN), first)] }));
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).length).toBe(3);
    expect(chosenEvents(swimmerOf(out, Gender.MEN))).not.toContain(first);
  });

  it('with no cap at all a removal only removes: 13 rows, nothing to refill', () => {
    const plain = buildTheoreticalMeetSeeds(meet({ scoringSettings: GENERIC_TOP16_SETTINGS }));
    const man = swimmerOf(plain, Gender.MEN);
    expect(chosenEvents(man).length).toBe(14);
    const out = buildTheoreticalMeetSeeds(meet({ scoringSettings: GENERIC_TOP16_SETTINGS, excludedEvents: [removal(man, ORDER[0])] }));
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).length).toBe(13);
    expect(swimmerOf(out, Gender.MEN).events.some(e => e.fillsRemovedSlot === true)).toBe(false);
  });

  it('the conference cap still applies: NSISC over stale generic settings stays at 7', () => {
    const out = buildTheoreticalMeetSeeds(
      meet({ scoringSettings: GENERIC_TOP16_SETTINGS, conference: 'NSISC', excludedEvents: [removal(baseMan, ORDER[0])] })
    );
    expect(rowsOfSwimmer(out, MEN[0].name, Gender.MEN).length).toBe(7);
  });
});

describe('a removal of an event that was not chosen', () => {
  it('changes no row: the event is marked removed, nothing is refilled, no slot is reported freed', () => {
    const notChosen = ORDER[10];
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: [removal(baseMan, notChosen)] }));
    expect(out.rows).toEqual(base.rows);
    const man = swimmerOf(out, Gender.MEN);
    expect(chosenEvents(man)).toEqual(chosenEvents(baseMan));
    const marked = man.events.find(e => e.event === notChosen)!;
    expect(marked.notChosenReason).toBe('removed_by_user');
    expect(marked.chosenWithoutRemovals).toBeUndefined();
    expect(man.events.some(e => e.fillsRemovedSlot === true)).toBe(false);
    expect(out.report.unmatchedExclusions).toEqual([]);
  });
});

describe('a removal that names nothing offered is ignored and reported', () => {
  it('lists an unknown event, an unknown swimmer, another team and the other gender, each once, and changes no row', () => {
    const list: TheoreticalEventExclusion[] = [
      removal(baseMan, '999 Free SCY'),
      { ...removal(baseMan, ORDER[0]), swimmerKey: 'sc:no-such-swimmer' },
      { ...removal(baseMan, ORDER[0]), teamName: 'Another University' },
      // The women's team has the same name; a men's key with the women's gender names no one.
      { ...removal(baseMan, ORDER[0]), gender: Gender.WOMEN },
      removal(baseMan, '999 Free SCY'),
    ];
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: list }));
    expect(out.rows).toEqual(base.rows);
    expect(out.report.unmatchedExclusions).toEqual(list.slice(0, 4));
    expect(out.report.teams.every(t => t.eventsRemovedByUser === 0)).toBe(true);
    expect(out.report.caveats.some(c => /removed by you/.test(c))).toBe(false);
  });

  it('matches on the meet course label only: the same event in another course names nothing', () => {
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: [removal(baseMan, ORDER[0].replace('SCY', 'LCM'))] }));
    expect(out.rows).toEqual(base.rows);
    expect(out.report.unmatchedExclusions.length).toBe(1);
  });
});

describe('the removal does not depend on the meet id or on list order', () => {
  it('survives a rebuild under a new meet id', () => {
    const list = [removal(baseMan, ORDER[0]), removal(baseMan, ORDER[1])];
    const a = buildTheoreticalMeetSeeds(meet({ excludedEvents: list }));
    const b = buildTheoreticalMeetSeeds(meet({ meetId: 'a-fresh-workspace-id', excludedEvents: [...list].reverse() }));
    expect(chosenEvents(swimmerOf(b, Gender.MEN))).toEqual(chosenEvents(swimmerOf(a, Gender.MEN)));
    expect(b.rows.map(r => r.event)).toEqual(a.rows.map(r => r.event));
    expect(b.rows.every(r => r.id.includes('a-fresh-workspace-id'))).toBe(true);
  });

  it('treats repeated pairs as one removal', () => {
    const one = buildTheoreticalMeetSeeds(meet({ excludedEvents: [removal(baseMan, ORDER[0])] }));
    const twice = buildTheoreticalMeetSeeds(meet({ excludedEvents: [removal(baseMan, ORDER[0]), removal(baseMan, ORDER[0])] }));
    expect(twice.rows).toEqual(one.rows);
    expect(twice.report.teams[0].eventsRemovedByUser).toBe(1);
  });

  it('keys a removal by team (normalized), gender, swimmer and event', () => {
    const a = removal(baseMan, ORDER[0]);
    expect(theoreticalEventExclusionKey({ ...a, teamName: `  ${OBU.toUpperCase()} ` })).toBe(theoreticalEventExclusionKey(a));
    expect(theoreticalEventExclusionKey({ ...a, gender: Gender.WOMEN })).not.toBe(theoreticalEventExclusionKey(a));
    expect(theoreticalEventExclusionKey({ ...a, event: ORDER[1] })).not.toBe(theoreticalEventExclusionKey(a));
    expect(theoreticalEventExclusionKey({ ...a, swimmerKey: 'sc:other' })).not.toBe(theoreticalEventExclusionKey(a));
  });
});

describe('removal keys and the unmatched report', () => {
  it('a | inside the team name or the event cannot make two different removals share a key', () => {
    // Raw parts: team "x|y" + key "k" and team "x" + key "y|k" both join to "x|y|k". Encoding the team and the event keeps them apart.
    const a: TheoreticalEventExclusion = { teamName: 'x|y', gender: Gender.MEN, swimmerKey: 'k', event: '50 Free SCY' };
    const b: TheoreticalEventExclusion = { teamName: 'x', gender: Gender.MEN, swimmerKey: 'y|k', event: '50 Free SCY' };
    expect(theoreticalEventExclusionKey(a)).not.toBe(theoreticalEventExclusionKey(b));
    const c: TheoreticalEventExclusion = { teamName: 'x', gender: Gender.MEN, swimmerKey: 'k', event: 'a|b' };
    const d: TheoreticalEventExclusion = { teamName: 'x', gender: Gender.MEN, swimmerKey: 'k|a', event: 'b' };
    expect(theoreticalEventExclusionKey(c)).not.toBe(theoreticalEventExclusionKey(d));
  });

  it('report.unmatchedExclusions holds exactly the four fields, not extra properties of the caller object', () => {
    const extra = { ...removal(baseMan, '999 Free SCY'), note: 'ui state', nested: { a: 1 } } as TheoreticalEventExclusion;
    const out = buildTheoreticalMeetSeeds(meet({ excludedEvents: [extra] }));
    expect(out.report.unmatchedExclusions).toEqual([removal(baseMan, '999 Free SCY')]);
    expect(Object.keys(out.report.unmatchedExclusions[0]).sort()).toEqual(['event', 'gender', 'swimmerKey', 'teamName']);
    expect(out.report.unmatchedExclusions[0]).not.toBe(extra);
  });
});

describe('bad removals throw invalid-input', () => {
  const good = removal(baseMan, ORDER[0]);
  it.each([
    ['a missing event', { ...good, event: '' }],
    ['a missing swimmer key', { ...good, swimmerKey: '' }],
    ['a blank team name', { ...good, teamName: '  ' }],
    ['a gender the meet does not know', { ...good, gender: 'X' as unknown as Gender }],
    ['null', null as unknown as TheoreticalEventExclusion],
  ])('%s', (_label, bad) => {
    expect(codeOf(() => buildTheoreticalMeetSeeds(meet({ excludedEvents: [bad] })))).toBe('invalid-input');
  });
  it('a list that is not a list', () => {
    expect(codeOf(() => buildTheoreticalMeetSeeds(meet({ excludedEvents: 'all' as unknown as TheoreticalEventExclusion[] })))).toBe('invalid-input');
  });
});

describe('a swimmer whose only seeds are excluded exhibition swims', () => {
  /** Constructed: the real 100 Free swim of the fixture, flagged exhibition. */
  const only = (athlete: SwimCloudAthlete): HistoricalSwim[] =>
    swimsFor(athlete, Gender.MEN)
      .filter(s => s.event === '100 Free SCY')
      .map(s => ({ ...s, isExhibition: true as const }));
  const input = (mode: 'include' | 'exclude') =>
    meet({ exhibitionSeeds: mode, teams: [{ teamName: OBU, gender: Gender.MEN, rosterStatus: 'parsed', athletes: [{ athlete: MEN[0], swims: only(MEN[0]) }] }] });

  it('gets its own reason, naming the dropped event, and is not told "no event in program"', () => {
    expect(only(MEN[0]).length).toBe(1);
    const out = buildTheoreticalMeetSeeds(input('exclude'));
    expect(out.rows).toEqual([]);
    expect(out.report.teams[0].athletesWithNoSeedInMeetCourse).toEqual([
      expect.objectContaining({ name: MEN[0].name, reason: 'all_seeds_exhibition_excluded', excludedExhibitionEvents: ['100 Free SCY'] }),
    ]);
  });

  it('is seeded, and tagged exhibition, when exhibition swims are included', () => {
    const out = buildTheoreticalMeetSeeds(input('include'));
    expect(out.rows.map(r => r.event)).toEqual(['100 Free SCY']);
    expect(out.report.teams[0].athletesWithNoSeedInMeetCourse).toEqual([]);
  });
});

describe('the base build still answers a removal made on top of exhibition mode', () => {
  it('removes a chosen event in exclude mode without touching the exhibition drop list', () => {
    const plain = buildTheoreticalMeetSeeds(meet({ exhibitionSeeds: 'exclude' }));
    const man = swimmerOf(plain, Gender.MEN);
    const first = chosenEvents(man)[0];
    const out = buildTheoreticalMeetSeeds(meet({ exhibitionSeeds: 'exclude', excludedEvents: [removal(man, first)] }));
    expect(chosenEvents(swimmerOf(out, Gender.MEN))).not.toContain(first);
    expect(swimmerOf(out, Gender.MEN).excludedExhibitionEvents).toEqual(man.excludedExhibitionEvents);
  });
});
