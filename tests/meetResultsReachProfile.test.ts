/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A loaded meet's results reach the athlete profile (plans/2026-09-22/01,
 * P14 item a).
 *
 * The defect: `getAthleteProfile` asked `isEventOffered` whether each swim's
 * event was one the meet contests, and it compared the raw label. A HyTek
 * label (`Event 4 Men 1000 Yard Freestyle`) never equals the canonical
 * program label (`1000 Freestyle`), so no loaded-meet swim ever ranked. A
 * probe on the real 2026 NSISC workspace returned `bestByEvent: {}` for
 * Delta State's Adam Rickert and Alessandro Giustolisi.
 *
 * The fixture is `tests/test_nsisc_output.json`, the committed parser output
 * of the 2026 NSISC Championships final results, mapped to `SwimmerResult`
 * exactly as `scripts/test_individual_scoring.mjs` maps it.
 *
 * Unchanged on purpose: the import and theory paths still match a meet
 * result to a plan by raw label (pinned in eventIdentityBestPicking.test.ts).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender, type HistoricalSwim, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import {
  buildHistoryFromWorkspace,
  getAthleteProfile,
  meetProgramEvents,
  mergeHistoryIndex,
} from '../packages/core/src/lib/athleteHistory';
import { compareRelayLegSplits } from '../packages/core/src/lib/relayBuilder';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const DSU = 'Delta State University';
const HSU = 'Henderson State University';

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

const menResults: SwimmerResult[] = parserOut
  .filter(a => a.gender !== 'Women')
  .map((a, i) => ({
    id: `nsisc-${i}`,
    rank: a.rank ? Number.parseInt(String(a.rank), 10) || 0 : 0,
    name: a.name,
    classYear: a.year || 'UNKNOWN',
    team: a.team,
    time: a.finals_time || a.prelims_time || 'NT',
    finalsTime: a.finals_time ?? undefined,
    roundSwam: a.round_swam ?? undefined,
    points: 0,
    event: a.event,
    gender: Gender.MEN,
    isRelay: Boolean(a.is_relay),
    relayTeamTime: a.relay_team_time ?? undefined,
    isTimeTrial: /\btime\s+trials?\b/i.test(a.event),
  })) as SwimmerResult[];

function nsiscWorkspace(athleteHistory: HistoricalSwim[] = []): Workspace {
  return {
    id: 'ws-nsisc-2026',
    name: '2026 NSISC',
    createdAt: 0,
    menResults,
    womenResults: [],
    sourceMenResults: menResults,
    sourceWomenResults: [],
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    loadedMeet: { pdfFilename: '2026_NSISC_Championships_Final_Results.pdf' },
    athleteHistory,
  } as unknown as Workspace;
}

const profileOf = (ws: Workspace, team: string, name: string) =>
  getAthleteProfile(ws, team, Gender.MEN, name, NSISC_PRESET_SETTINGS);

describe('the fixture is the real meet', () => {
  it('holds the swims the probe found unranked', () => {
    const rows = (name: string) =>
      menResults.filter(r => r.name === name && !r.isRelay).map(r => [r.event, r.time]);
    expect(rows('Adam Rickert')).toStrictEqual([['Event 4 Men 1000 Yard Freestyle', '9:38.13']]);
    expect(rows('Alessandro Giustolisi')).toStrictEqual([
      ['Event 8 Men 50 Yard Freestyle', '21.65'],
      ['Event 13 Men 100 Yard Butterfly', '49.73'],
      ['Event 28 Men 200 Yard Butterfly', '1:56.20'],
      ['Event 35 Men 100 Yard Freestyle', '47.83'],
    ]);
    // The meet program the profile is filtered by is canonical.
    expect(meetProgramEvents(menResults).has('1000 Freestyle')).toBe(true);
  });
});

describe('a loaded-meet swim ranks in the athlete profile', () => {
  it('Adam Rickert (Delta State): his 1000 Free is his best', () => {
    const profile = profileOf(nsiscWorkspace(), DSU, 'Adam Rickert');
    expect(profile.bestByEvent).toStrictEqual({
      'Event 4 Men 1000 Yard Freestyle': { time: '9:38.13', timeSec: 578.13, source: 'pdf' },
    });
    expect(profile.primaryEvents).toStrictEqual(['Event 4 Men 1000 Yard Freestyle']);
  });

  it('Alessandro Giustolisi (Delta State): all four individual swims', () => {
    const profile = profileOf(nsiscWorkspace(), DSU, 'Alessandro Giustolisi');
    expect(Object.fromEntries(Object.entries(profile.bestByEvent).map(([e, b]) => [e, b.time]))).toStrictEqual({
      'Event 8 Men 50 Yard Freestyle': '21.65',
      'Event 13 Men 100 Yard Butterfly': '49.73',
      'Event 28 Men 200 Yard Butterfly': '1:56.20',
      'Event 35 Men 100 Yard Freestyle': '47.83',
    });
    expect(profile.primaryEvents).toHaveLength(4);
    // Relays stay relays.
    expect(profile.relayEvents).toStrictEqual([
      'Event 11 Men 4x50 Yard Medley Relay',
      'Event 20 Men 4x100 Yard Medley Relay',
      'Event 42 Men 4x100 Yard Freestyle Relay',
    ]);
  });

  it('folds a meet swim and a history swim of one event into one best', () => {
    const history = (time: string): HistoricalSwim => ({
      name: 'Alessandro Giustolisi',
      team: DSU,
      gender: Gender.MEN,
      event: '100 Free SCY',
      time,
      timeType: 'SCY',
      source: 'swimcloud',
    });
    const faster = profileOf(nsiscWorkspace([history('47.10')]), DSU, 'Alessandro Giustolisi');
    const hundreds = (p: typeof faster) =>
      Object.entries(p.bestByEvent).filter(([e]) => /\b100\b.*free/i.test(e)).map(([e, b]) => [e, b.time]);
    expect(hundreds(faster)).toStrictEqual([['100 Free SCY', '47.10']]);
    const slower = profileOf(nsiscWorkspace([history('48.50')]), DSU, 'Alessandro Giustolisi');
    expect(hundreds(slower)).toStrictEqual([['Event 35 Men 100 Yard Freestyle', '47.83']]);
  });
});

describe('what a loaded meet still does not offer', () => {
  it('a time trial (Oskar Cebula, HSU): the program swim holds the best, not the faster time trial', () => {
    // Event 100 is a 100 Breast time trial at 54.86; the program 100 Breast was 55.45.
    const profile = profileOf(nsiscWorkspace(), HSU, 'Oskar Cebula');
    const breast = Object.entries(profile.bestByEvent).filter(([e]) => /100 Yard Breaststroke/.test(e));
    expect(breast.map(([e, b]) => [e, b.time])).toStrictEqual([['Event 26 Men 100 Yard Breaststroke', '55.45']]);
    expect(Object.keys(profile.bestByEvent).some(e => /time trial/i.test(e))).toBe(false);
  });

  it('a time trial a SwimCloud meet import flags by event number, under a plain label', () => {
    // SwimCloud labels both swims "100 Breast"; only `isTimeTrial` tells them apart
    // (swimCloudMeetImportBridge sets it from the programme number). Same swims
    // as Oskar Cebula's above.
    const row = (id: string, time: string, isTimeTrial: boolean): SwimmerResult =>
      ({
        id,
        rank: 1,
        name: 'Oskar Cebula',
        classYear: 'SR',
        team: HSU,
        time,
        points: 0,
        event: '100 Breast',
        gender: Gender.MEN,
        ...(isTimeTrial ? { isTimeTrial: true } : {}),
      }) as SwimmerResult;
    const results = [row('program', '55.45', false), row('trial', '54.86', true)];
    const ws = {
      ...nsiscWorkspace(),
      menResults: results,
      sourceMenResults: results,
    } as Workspace;
    const history = buildHistoryFromWorkspace(ws);
    expect(history.map(h => [h.time, h.isTimeTrial === true])).toStrictEqual([
      ['55.45', false],
      ['54.86', true],
    ]);
    // Both rows are kept: the faster time trial does not evict the program swim.
    expect(mergeHistoryIndex(history, []).map(h => h.time).sort()).toStrictEqual(['54.86', '55.45']);
    const profile = profileOf(ws, HSU, 'Oskar Cebula');
    expect(Object.entries(profile.bestByEvent).map(([e, b]) => [e, b.time])).toStrictEqual([['100 Breast', '55.45']]);
  });

  it('a time trial in an event the swimmer never swam in the program (Aiden Killackey, HSU)', () => {
    const profile = profileOf(nsiscWorkspace(), HSU, 'Aiden Killackey');
    expect(Object.keys(profile.bestByEvent).some(e => /100 Yard Freestyle/.test(e))).toBe(false);
  });

  it('a dive (Delta State divers score in points)', () => {
    const profile = profileOf(nsiscWorkspace(), DSU, 'Santiago Santodomingo');
    expect(Object.keys(profile.bestByEvent).some(e => /diving/i.test(e))).toBe(false);
  });
});

describe('a relay leg reads only its own distance and stroke from the profile', () => {
  function leg(name: string, relayEvent: string, relayLegIndex: number): SwimmerResult {
    return {
      id: `leg-${name}-${relayLegIndex}`,
      rank: 1,
      name,
      classYear: 'SO',
      team: DSU,
      time: '3:07.46',
      points: 0,
      event: relayEvent,
      gender: Gender.MEN,
      isRelay: true,
      relayLegIndex,
    } as SwimmerResult;
  }
  const calculated = (name: string, relayEvent: string, legIndex: number) =>
    compareRelayLegSplits(nsiscWorkspace(), Gender.MEN, [leg(name, relayEvent, legIndex)], relayEvent, DSU)[legIndex]
      .calculatedSplit;

  it('takes a swimmer’s own 100 Free for a 100 free leg', () => {
    expect(calculated('Alessandro Giustolisi', 'Event 42 Men 4x100 Yard Freestyle Relay', 0)).toBe('47.83');
  });

  it('never takes a 1000 Free for a 100 free leg', () => {
    // "1000 freestyle" contains "100". Adam Rickert swam no 100 Free.
    expect(calculated('Adam Rickert', 'Event 42 Men 4x100 Yard Freestyle Relay', 0)).toBeNull();
  });

  it('never takes a 500 Free for a 50 free leg', () => {
    const history: HistoricalSwim = {
      name: 'Adam Rickert',
      team: DSU,
      gender: Gender.MEN,
      event: '500 Free SCY',
      time: '4:40.00',
      timeType: 'SCY',
      source: 'swimcloud',
    };
    const ws = nsiscWorkspace([history]);
    const relayEvent = 'Event 31 Men 4x50 Yard Freestyle Relay';
    const [first] = compareRelayLegSplits(ws, Gender.MEN, [leg('Adam Rickert', relayEvent, 0)], relayEvent, DSU);
    expect(first.calculatedSplit).toBeNull();
  });

  it('takes the stroke the medley leg needs', () => {
    expect(calculated('Alessandro Giustolisi', 'Event 20 Men 4x100 Yard Medley Relay', 2)).toBe('49.73');
    // No 100 Back on record for him.
    expect(calculated('Alessandro Giustolisi', 'Event 20 Men 4x100 Yard Medley Relay', 0)).toBeNull();
  });
});
