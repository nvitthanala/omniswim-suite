/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * What spends one of a swimmer's per-meet entries, and the two settings that
 * decide the contested cases (user rulings 2026-09-21 and 2026-10-01):
 *
 * - A swimmer entered in an event logged as a PRELIMS round is one entry, even
 *   with no final, rank 0, or a time of DFS / DQ. A prelims row and a finals row
 *   for one event are one entry.
 * - A time trial is not an entry (`entryCapCountsTimeTrials`, default false).
 * - An exhibition-tagged swim still is one (`entryCapCountsExhibition`, default
 *   true), prelims round included.
 * - Nothing is keyed to a conference: the flags live on `ScoringSettings`, and a
 *   non-NSISC settings object can turn either one.
 *
 * Fixtures are synthetic: invented names and times.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import {
  DEFAULT_ENTRY_CAP_POLICY,
  GENERIC_TOP16_SETTINGS,
  NSISC_PRESET_SETTINGS,
  entryCapPolicy,
  mergeScoringSettings,
} from '../packages/core/src/lib/scoringDefaults';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { applyScoringTheory, parseScoringTheory } from '../packages/core/src/lib/scoringTheory';
import { countSwimmerEntries, swimmerExceedsEntryLimits } from '../packages/core/src/lib/swimmerEntryLimits';

const TEAM = 'Alpha University';
const NAME = 'Ann Able';
const MATES = ['Bo Bee', 'Cy Cee', 'Di Dee'];

function swim(id: string, event: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  return {
    id,
    rank: 1,
    name: NAME,
    classYear: 'JR',
    team: TEAM,
    time: '50.00',
    points: 0,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...extra,
  } as SwimmerResult;
}

function relay(prefix: string, event: string, extra: Partial<SwimmerResult> = {}): SwimmerResult[] {
  const legs = [NAME, ...MATES];
  return legs.map((name, i) => ({
    id: `${prefix}-${i}`,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: '1:30.00',
    relayTeamTime: '1:30.00',
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
    ...extra,
  })) as SwimmerResult[];
}

const count = (rows: SwimmerResult[], settings?: Parameters<typeof countSwimmerEntries>[5]) =>
  countSwimmerEntries(rows, TEAM, Gender.MEN, NAME, undefined, settings);

const E50 = 'Event 8 Men 50 Yard Freestyle';
const E100 = 'Event 35 Men 100 Yard Freestyle';

describe('entryCapPolicy', () => {
  it('defaults: time trials do not count, exhibition does', () => {
    expect(entryCapPolicy()).toEqual({ countsTimeTrials: false, countsExhibition: true });
    expect(entryCapPolicy({})).toEqual(DEFAULT_ENTRY_CAP_POLICY);
  });

  it('takes a literal boolean and ignores anything else', () => {
    expect(entryCapPolicy({ entryCapCountsTimeTrials: true, entryCapCountsExhibition: false })).toEqual({
      countsTimeTrials: true,
      countsExhibition: false,
    });
    const junk = { entryCapCountsTimeTrials: 'yes', entryCapCountsExhibition: 0 } as never;
    expect(entryCapPolicy(junk)).toEqual(DEFAULT_ENTRY_CAP_POLICY);
  });

  it('survives mergeScoringSettings, including the NSISC conference override', () => {
    const flags = { entryCapCountsTimeTrials: true, entryCapCountsExhibition: false };
    for (const conference of ['NSISC', undefined]) {
      const merged = mergeScoringSettings({ ...NSISC_PRESET_SETTINGS, ...flags }, { conference });
      expect(entryCapPolicy(merged)).toEqual({ countsTimeTrials: true, countsExhibition: false });
    }
    // The shipped presets state nothing, so they resolve to the defaults.
    expect(entryCapPolicy(mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' }))).toEqual(
      DEFAULT_ENTRY_CAP_POLICY
    );
    expect(entryCapPolicy(mergeScoringSettings(GENERIC_TOP16_SETTINGS))).toEqual(DEFAULT_ENTRY_CAP_POLICY);
  });
});

describe('countSwimmerEntries: time trial policy', () => {
  const rows = [swim('a', E50), swim('tt', 'Event 300 Men 50 Yard Freestyle Time Trial', { isTimeTrial: true })];

  it('does not count a time trial by default', () => {
    expect(count(rows).total).toBe(1);
  });

  it('counts it when the setting is on', () => {
    expect(count(rows, { entryCapCountsTimeTrials: true }).total).toBe(2);
  });

  it('skips a time-trial relay row by default and counts it when on', () => {
    const tt = relay('rtt', 'Event 202 Men 4x200 Yard Freestyle Relay Time Trial', { isTimeTrial: true });
    expect(count(tt).relayCount).toBe(0);
    expect(count(tt, { entryCapCountsTimeTrials: true }).relayCount).toBe(1);
  });
});

describe('countSwimmerEntries: exhibition policy', () => {
  const exhibitionPrelims = swim('ex', E100, { isExhibition: true, roundSwam: 'Prelims' });

  it('counts an exhibition prelims swim by default', () => {
    expect(count([exhibitionPrelims]).total).toBe(1);
  });

  it('does not count it when the setting is off', () => {
    expect(count([exhibitionPrelims], { entryCapCountsExhibition: false }).total).toBe(0);
  });

  it('is still one entry when an exhibition prelims is followed by a scoring final', () => {
    const rows = [exhibitionPrelims, swim('fin', E100, { roundSwam: 'A Final' })];
    expect(count(rows).total).toBe(1);
    expect(count(rows, { entryCapCountsExhibition: false }).total).toBe(1);
  });

  it('counts an exhibition relay leg by default and not when off', () => {
    const rows = relay('rex', 'Event 20 Men 4x100 Yard Medley Relay', { isExhibition: true });
    expect(count(rows).relayCount).toBe(1);
    expect(count(rows, { entryCapCountsExhibition: false }).relayCount).toBe(0);
  });

  it('is not tied to a conference: a generic settings object can turn it off', () => {
    const settings = { ...GENERIC_TOP16_SETTINGS, entryCapCountsExhibition: false };
    expect(count([exhibitionPrelims], settings).total).toBe(0);
  });
});

describe('countSwimmerEntries: a prelims round is an entry', () => {
  it('counts a prelims-only row with no final, rank 0 and a DFS time', () => {
    const dfs = swim('p', E50, { roundSwam: 'Prelims', rank: 0, time: 'DFS' });
    expect(count([dfs]).total).toBe(1);
    expect(count([dfs]).individualEvents).toEqual(new Set([E50]));
  });

  it('counts a prelims DQ row', () => {
    expect(count([swim('p', E50, { roundSwam: 'Prelims', rank: 0, time: 'DQ' })]).total).toBe(1);
  });

  it('counts a DFS prelims relay row as one relay entry', () => {
    const rows = relay('rp', 'Event 11 Men 4x50 Yard Medley Relay', { roundSwam: 'Prelims', rank: 0, time: 'DFS' });
    expect(count(rows).relayCount).toBe(1);
  });

  it('counts a prelims row and a finals row of one event once', () => {
    const rows = [swim('p', E50, { roundSwam: 'Prelims', rank: 9 }), swim('f', E50, { roundSwam: 'B Final', rank: 2 })];
    expect(count(rows).total).toBe(1);
  });

  it('charges two events two entries', () => {
    expect(count([swim('a', E50, { roundSwam: 'Prelims' }), swim('b', E100, { roundSwam: 'Prelims' })]).total).toBe(2);
  });
});

describe('countSwimmerEntries: the five-individual, three-relay swimmer totals 8', () => {
  // The shape found in the real workspace: 5 individual events and 3 relays.
  const rows = [
    swim('i1', 'Event 6 Men 200 Yard IM', { roundSwam: 'Prelims' }),
    swim('i1f', 'Event 6 Men 200 Yard IM', { roundSwam: 'A Final' }),
    swim('i2', 'Event 26 Men 100 Yard Breaststroke'),
    swim('i3', 'Event 39 Men 200 Yard Breaststroke'),
    swim('i4', 'Event 15 Men 400 Yard IM'),
    swim('i5', 'Event 22 Men 500 Yard Freestyle'),
    ...relay('r1', 'Event 11 Men 4x50 Yard Medley Relay'),
    ...relay('r2', 'Event 20 Men 4x100 Yard Medley Relay'),
    ...relay('r3', 'Event 31 Men 4x50 Yard Freestyle Relay'),
    swim('tt', 'Event 100 Men 100 Yard Breaststroke Time Trial', { isTimeTrial: true }),
  ];

  it('counts 5 individual + 3 relay = 8, and the NSISC cap of 7 is exceeded', () => {
    const counts = count(rows);
    expect({ individual: counts.individual, relay: counts.relayCount, total: counts.total }).toEqual({
      individual: 5,
      relay: 3,
      total: 8,
    });
    const merged = mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' });
    expect(swimmerExceedsEntryLimits(counts, merged).totalOver).toBe(true);
  });

  it('would total 9 if time trials counted (settings flow through)', () => {
    expect(count(rows, { entryCapCountsTimeTrials: true }).total).toBe(9);
  });
});

describe('every counter reads the same policy', () => {
  const NSISC = { ...NSISC_PRESET_SETTINGS };

  function workspace(menResults: SwimmerResult[], scoringSettings = NSISC): Workspace {
    return {
      id: 'ws-policy',
      name: 'policy probe',
      createdAt: 0,
      menResults,
      womenResults: [],
      sourceMenResults: menResults,
      sourceWomenResults: [],
      recruits: [],
      scoringSettings,
      conference: 'NSISC',
      meetEntryPlans: [],
      activeEntryIds: [],
      historySources: [],
      scorerRosterOverrides: [],
      relayLegOverrides: [],
      athleteHistory: [],
    } as unknown as Workspace;
  }

  /** Four individual events and two relays: 6 of 7, plus a time trial. */
  const sixPlusTimeTrial = [
    swim('1', 'Event 15 Men 400 Yard IM'),
    swim('2', 'Event 26 Men 100 Yard Breaststroke'),
    swim('3', 'Event 28 Men 200 Yard Butterfly'),
    swim('4', 'Event 39 Men 200 Yard Breaststroke'),
    ...relay('r1', 'Event 11 Men 4x50 Yard Medley Relay'),
    ...relay('r2', 'Event 20 Men 4x100 Yard Medley Relay'),
    swim('tt', 'Event 101 Men 200 Yard Breaststroke Time Trial', { isTimeTrial: true }),
    swim('field', 'Event 30 Men 200 Yard Backstroke', { name: 'Bo Bee' }),
  ];

  const incoming: HistoricalSwim[] = [
    {
      name: NAME,
      team: TEAM,
      gender: Gender.MEN,
      event: '200 Backstroke',
      time: '1:50.00',
      timeType: 'SCY',
      source: 'swimcloud',
      meet: 'Synthetic Invite',
      date: '2026-01-01',
    } as HistoricalSwim,
  ];

  it('history import: a time trial leaves the 7th entry open by default and uses it when on', () => {
    const off = importHistoryToRoster(workspace(sixPlusTimeTrial), incoming, { team: TEAM, gender: Gender.MEN });
    expect(off.summary.lineupEntriesAdded).toBe(1);
    const on = importHistoryToRoster(
      workspace(sixPlusTimeTrial, { ...NSISC, entryCapCountsTimeTrials: true }),
      incoming,
      { team: TEAM, gender: Gender.MEN }
    );
    expect(on.summary.lineupEntriesAdded).toBe(0);
  });

  it('history import: an exhibition swim uses an entry by default and frees it when off', () => {
    const rows = sixPlusTimeTrial.map(r => (r.id === '4' ? { ...r, isExhibition: true } : r));
    const dflt = importHistoryToRoster(workspace(rows), incoming, { team: TEAM, gender: Gender.MEN });
    expect(dflt.summary.lineupEntriesAdded).toBe(1);
    // 6 -> 5 entries when exhibition stops counting: room for the import's one swim, still.
    const off = importHistoryToRoster(workspace(rows, { ...NSISC, entryCapCountsExhibition: false }), incoming, {
      team: TEAM,
      gender: Gender.MEN,
    });
    expect(off.summary.lineupEntriesAdded).toBe(1);
    // And a swimmer at 7 of 7 through an exhibition swim has room only when it is off.
    const full = [...rows, swim('5', 'Event 17 Men 200 Yard Freestyle', { isExhibition: true })];
    expect(
      importHistoryToRoster(workspace(full), incoming, { team: TEAM, gender: Gender.MEN }).summary.lineupEntriesAdded
    ).toBe(0);
    expect(
      importHistoryToRoster(workspace(full, { ...NSISC, entryCapCountsExhibition: false }), incoming, {
        team: TEAM,
        gender: Gender.MEN,
      }).summary.lineupEntriesAdded
    ).toBe(1);
  });

  it('scoring theory: a time trial spends an entry only when the setting is on', () => {
    const theory = parseScoringTheory(['Scoring team possibilities', `${NAME} (500, 1fly, 2im, 1back)`].join('\n'));
    const history = (event: string, time: string) =>
      ({ name: NAME, team: TEAM, gender: Gender.MEN, event, time, timeType: 'SCY', source: 'paste' }) as HistoricalSwim;
    const base = [swim('i1', 'Event 4 Men 50 Yard Freestyle'), swim('i2', 'Event 10 Men 100 Yard Freestyle'), swim('i3', 'Event 16 Men 200 Yard Freestyle')];
    const tt = swim('tt', 'Event 100 Men 100 Yard Breaststroke Time Trial', { isTimeTrial: true });
    const withHistory = (w: Workspace): Workspace => ({
      ...w,
      athleteHistory: [
        history('500 Freestyle', '4:30.00'),
        history('100 Butterfly', '49.00'),
        history('200 Individual Medley', '1:50.00'),
        history('100 Backstroke', '50.00'),
      ],
    });
    const added = (w: Workspace) =>
      applyScoringTheory(withHistory(w), theory, { team: TEAM, gender: Gender.MEN }).summary.entriesAdded;
    expect(added(workspace([...base, tt]))).toBe(4);
    expect(added(workspace([...base, tt], { ...NSISC, entryCapCountsTimeTrials: true }))).toBe(3);
  });
});
