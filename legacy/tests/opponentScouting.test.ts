/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: opponent scouting. The pure comparison (`scoutOpponent`) and the seed loader
 * (`loadOpponentSeeds`).
 *
 * The synthetic cases score through a real preset (the NCAA dual meet preset), and every expected
 * point value is read from that preset's own place table, never typed in. The last block runs the real
 * crawled fixtures (`tests/fixtures/theoretical-meet/`) end to end.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemSwimCloudCaptureStore } from '../../packages/swimcloud/src/captureStore';
import { parseSwimCloudCapture } from '../apps/shell/lib/swimcloudCaptureRoutes';
import { Gender } from '../../packages/core/src/types';
import type { PlannedSwimEntry, Recruit, ScoringSettings, SwimmerResult, Workspace } from '../../packages/core/src/types';
import { buildScoringSnapshot } from '../../packages/core/src/lib/scoringEngine';
import { mergeScoringSettings } from '../../packages/core/src/lib/scoringDefaults';
import {
  composeDualMeetPreset,
  presetIdForConference,
  settingsForBuiltInScoringPreset,
} from '../../packages/core/src/lib/scoringDefaults';
import { calculatePoints, convertTimeToSeconds } from '../../packages/core/src/lib/utils';
import {
  EVENT_ORDER_CAVEAT,
  RELAYS_NOT_SCOUTED_NOTE,
  ScoutError,
  scoutOpponent,
  type ScoutInput,
} from '../packages/manager/src/lib/opponentScouting';
import { handTypedRowIds, unknownSourceRowIds } from '../packages/manager/src/components/scoutOpponentView';
import { groupCaptures, type CaptureListRecord } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import { isSameSchool } from '../packages/manager/src/lib/opponentScouting';
import { OpponentLoadError, loadOpponentSeeds } from '../packages/manager/src/lib/opponentScoutingLoad';
import type { TheoreticalCaptureDeps } from '../packages/manager/src/lib/theoreticalMeetFromCaptures';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, '../../tests/fixtures/theoretical-meet');

const US = 'Henderson State University';
const THEM = 'Ouachita Baptist University';

const dualPreset = composeDualMeetPreset('dual-six-lanes-or-more', 'dual-diving-six-or-more');
if (dualPreset.settings === undefined) throw new Error('the dual preset carries no settings');
const DUAL: ScoringSettings = dualPreset.settings;
const TABLE = DUAL.scoringPoints;

const NSISC_SETTINGS = (() => {
  const id = presetIdForConference('NSISC');
  if (id === null) throw new Error('no preset for NSISC');
  return settingsForBuiltInScoringPreset(id);
})();

let counter = 0;
function swim(team: string, name: string, event: string, time: string, extra: Partial<SwimmerResult> = {}): SwimmerResult {
  counter += 1;
  return {
    id: `r${counter}`,
    rank: 0,
    name,
    classYear: 'SR',
    team,
    time,
    points: 0,
    event,
    gender: Gender.MEN,
    ...extra,
  };
}

function scout(ourRows: SwimmerResult[], theirRows: SwimmerResult[], extra: Partial<ScoutInput> = {}) {
  return scoutOpponent({ gender: Gender.MEN, ourTeam: US, opponentTeam: THEM, ourRows, theirRows, settings: DUAL, ...extra });
}

const tableAt = (index: number): number => {
  const v = TABLE[index];
  if (v === undefined) throw new Error(`the preset table has no place ${index + 1}`);
  return v;
};

/* -------------------------------------------------------------------------- */
/* Direction                                                                   */
/* -------------------------------------------------------------------------- */

describe('who leads: the faster best time wins', () => {
  it('the faster side leads, and the margin is the gap in seconds', () => {
    const report = scout([swim(US, 'Ann', '100 Free SCY', '48.50')], [swim(THEM, 'Bea', '100 Free SCY', '49.75')]);
    expect(report.events).toHaveLength(1);
    const [event] = report.events;
    expect(event?.leader).toBe('ours');
    expect(event?.marginSec).toBe(1.25);
    expect(report.wins.map(e => e.event)).toEqual(['100 Freestyle']);
    expect(report.losses).toEqual([]);
  });

  it('the slower side loses (direction is not symmetric by accident)', () => {
    const report = scout([swim(US, 'Ann', '100 Free SCY', '49.75')], [swim(THEM, 'Bea', '100 Free SCY', '48.50')]);
    expect(report.events[0]?.leader).toBe('theirs');
    expect(report.losses).toHaveLength(1);
    expect(report.wins).toEqual([]);
  });

  it('a minute-plus time compares as a time, not as text', () => {
    // "1:00.00" sorts before "59.99" as text. As a time it is slower.
    const report = scout([swim(US, 'Ann', '200 Free SCY', '1:59.99')], [swim(THEM, 'Bea', '200 Free SCY', '1:49.99')]);
    expect(report.events[0]?.leader).toBe('theirs');
    expect(report.events[0]?.marginSec).toBe(10);
  });

  it('compares whole hundredths: 59.99 against 1:00.00 is a margin of exactly 0.01', () => {
    const report = scout([swim(US, 'Ann', '100 Free SCY', '59.99')], [swim(THEM, 'Bea', '100 Free SCY', '1:00.00')]);
    expect(report.events[0]?.marginSec).toBe(0.01);
    expect(report.events[0]?.leader).toBe('ours');
  });

  it('the same time written two ways is a tie: float noise does not make a winner', () => {
    // 1:08.04 parses to 68.03999999999999 and 68.04 parses to 68.04, though both are 68.04 seconds.
    expect(convertTimeToSeconds('1:08.04')).not.toBe(convertTimeToSeconds('68.04'));
    const report = scout([swim(US, 'Ann', '200 Free SCY', '1:08.04')], [swim(THEM, 'Bea', '200 Free SCY', '68.04')]);
    expect(report.events[0]?.leader).toBe('tie');
    expect(report.events[0]?.marginSec).toBe(0);
    expect(report.events[0]?.ours[0]?.place).toBe(1);
    expect(report.events[0]?.theirs[0]?.place).toBe(1);
  });

  it('an exact tie is its own bucket: neither a win nor a loss, no swing', () => {
    const report = scout([swim(US, 'Ann', '50 Free SCY', '21.00')], [swim(THEM, 'Bea', '50 Free SCY', '21.00')]);
    expect(report.events[0]?.leader).toBe('tie');
    expect(report.events[0]?.marginSec).toBe(0);
    expect(report.ties).toHaveLength(1);
    expect(report.wins).toEqual([]);
    expect(report.losses).toEqual([]);
    expect(report.swingEvents).toEqual([]);
    expect(report.events[0]?.swap).toEqual({ ourChange: 0, theirChange: 0, leadChange: 0 });
  });

  it('each side keeps its fastest row for one swimmer in one event', () => {
    const report = scout(
      [swim(US, 'Ann', '100 Free SCY', '50.10', { roundSwam: 'Preliminaries' }), swim(US, 'Ann', '100 Free SCY', '49.40', { roundSwam: 'A Final' })],
      [swim(THEM, 'Bea', '100 Free SCY', '49.90')]
    );
    expect(report.events[0]?.ours).toHaveLength(1);
    expect(report.events[0]?.ourBest.time).toBe('49.40');
    expect(report.events[0]?.leader).toBe('ours');
  });
});

/* -------------------------------------------------------------------------- */
/* Absent is not empty                                                         */
/* -------------------------------------------------------------------------- */

describe('an event where a side has no time', () => {
  const report = scout(
    [swim(US, 'Ann', '100 Free SCY', '48.50'), swim(US, 'Cy', '100 Fly SCY', '52.00')],
    [swim(THEM, 'Bea', '100 Free SCY', '49.00'), swim(THEM, 'Dee', '200 Back SCY', '1:55.00')]
  );

  it('is listed with the side that is missing and the present side as context', () => {
    expect(report.noTime.map(n => [n.event, n.missing, n.present.swimmer, n.present.time])).toEqual([
      // Program order: freestyle, backstroke, breaststroke, butterfly, medley.
      ['200 Backstroke', 'ours', 'Dee', '1:55.00'],
      ['100 Butterfly', 'theirs', 'Cy', '52.00'],
    ]);
  });

  it('is left out of wins, losses, ties, swing events and both totals', () => {
    expect(report.events.map(e => e.event)).toEqual(['100 Freestyle']);
    expect(report.wins.length + report.losses.length + report.ties.length).toBe(1);
    // Only the 100 Free is scored: one swimmer each, so 1st and 2nd of the preset's table.
    expect(report.ourTotal).toBe(tableAt(0));
    expect(report.theirTotal).toBe(tableAt(1));
  });

  it('tells "no entry" (a measured time the entry limit left out) from "no time"', () => {
    const r = scout(
      [swim(US, 'Ann', '100 Free SCY', '48.50'), swim(US, 'Cy', '100 Fly SCY', '52.00')],
      [swim(THEM, 'Bea', '100 Free SCY', '49.00')],
      { theirEntryCapped: [{ swimmer: 'Dee', event: '100 Fly SCY', time: '53.10' }] }
    );
    expect(r.noTime).toHaveLength(1);
    expect(r.noTime[0]).toMatchObject({
      event: '100 Butterfly',
      missing: 'theirs',
      reason: 'entry_cap',
      cappedBest: { swimmer: 'Dee', time: '53.10' },
    });
    // The same event with no capped seed is a plain "no time".
    const plain = scout([swim(US, 'Cy', '100 Fly SCY', '52.00')], [swim(THEM, 'Bea', '100 Free SCY', '49.00')]);
    expect(plain.noTime.find(n => n.event === '100 Butterfly')?.reason).toBe('no_time');
  });

  it('an empty opponent reads as no time everywhere, never as a win by default', () => {
    const empty = scout([swim(US, 'Ann', '100 Free SCY', '48.50')], []);
    expect(empty.events).toEqual([]);
    expect(empty.wins).toEqual([]);
    expect(empty.noTime).toHaveLength(1);
    expect(empty.ourTotal).toBeNull();
    expect(empty.theirTotal).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Points, swap, caps                                                          */
/* -------------------------------------------------------------------------- */

describe('points and the swap', () => {
  it('pays the preset table to places 1 and 2 and swaps them exactly', () => {
    const report = scout([swim(US, 'Ann', '100 Free SCY', '48.50')], [swim(THEM, 'Bea', '100 Free SCY', '49.00')]);
    const event = report.events[0];
    expect(event?.ourPoints).toBe(tableAt(0));
    expect(event?.theirPoints).toBe(tableAt(1));
    expect(event?.ours[0]).toMatchObject({ place: 1, points: tableAt(0) });
    expect(event?.theirs[0]).toMatchObject({ place: 2, points: tableAt(1) });
    expect(event?.swap).toEqual({
      ourChange: tableAt(1) - tableAt(0),
      theirChange: tableAt(0) - tableAt(1),
      leadChange: 2 * (tableAt(1) - tableAt(0)),
    });
    expect(report.swingEvents.map(e => e.event)).toEqual(['100 Freestyle']);
  });

  it('a loss swaps the other way: we gain what they lose', () => {
    const report = scout([swim(US, 'Ann', '100 Free SCY', '49.00')], [swim(THEM, 'Bea', '100 Free SCY', '48.50')]);
    expect(report.events[0]?.swap.ourChange).toBe(tableAt(0) - tableAt(1));
    expect(report.events[0]?.swap.theirChange).toBe(tableAt(1) - tableAt(0));
  });

  it('ranks swing events by the gap as a percent of the slower time, not by seconds', () => {
    // 100 Free: 0.10 s of 47.10 = 0.21 percent. 200 Free: 1.00 s of 105.00 = 0.95 percent. 50 Free: 0.50 s of 21.50 = 2.3 percent.
    // By seconds the order would be 100, 50, 200.
    const report = scout(
      [swim(US, 'A', '50 Free SCY', '21.50'), swim(US, 'B', '100 Free SCY', '47.10'), swim(US, 'C', '200 Free SCY', '1:45.00')],
      [swim(THEM, 'X', '50 Free SCY', '21.00'), swim(THEM, 'Y', '100 Free SCY', '47.00'), swim(THEM, 'Z', '200 Free SCY', '1:44.00')]
    );
    expect(report.swingEvents.map(e => e.event)).toEqual(['100 Freestyle', '200 Freestyle', '50 Freestyle']);
    expect(report.swingEvents.map(e => e.swing?.gapSec)).toEqual([0.1, 1, 0.5]);
  });

  it('cuts each side to the per-team cap before places are set, so extra opponent swimmers cannot hold a place ahead of ours', () => {
    const cap = DUAL.maxIndividualScorersPerTeamPerEvent;
    expect(cap, 'the dual preset states a per-team cap').toBeGreaterThan(0);
    if (cap === undefined) return;
    // The opponent has cap + 2 swimmers, all faster than ours. Ours is behind every one of them.
    const theirs = Array.from({ length: cap + 2 }, (_, i) => swim(THEM, `T${i}`, '100 Free SCY', `${47 + i}.00`));
    const us = swim(US, 'Ann', '100 Free SCY', '58.00');
    const report = scout([us], theirs);
    const event = report.events[0];

    // The engine, run by hand on the trimmed lists: their fastest `cap` swimmers and ours, ranked by time.
    const kept = theirs.slice(0, cap);
    const field = [...kept, us].map((r, i) => ({ ...r, rank: i + 1, roundSwam: 'A Final', event: '100 Freestyle' }));
    const byHand = calculatePoints(field, DUAL);
    const ourHandPoints = byHand.find(r => r.name === 'Ann')?.points;

    expect(event?.theirs).toHaveLength(cap);
    expect(event?.ours[0]?.place).toBe(cap + 1);
    expect(event?.ours[0]?.points).toBe(ourHandPoints);
    expect(event?.ours[0]?.points).toBe(tableAt(cap));
    // The cut swimmers are listed, not dropped.
    expect(report.perTeamCap).toBe(cap);
    expect(report.cappedOut.map(c => [c.side, c.swimmer, c.time])).toEqual([
      ['theirs', `T${cap}`, `${47 + cap}.00`],
      ['theirs', `T${cap + 1}`, `${47 + cap + 1}.00`],
    ]);
    expect(report.caveats.some(c => c.includes(`fastest ${cap} swimmers`))).toBe(true);
  });

  it('a rule with no per-team cap cuts nothing', () => {
    const open: ScoringSettings = { ...NSISC_SETTINGS };
    delete open.maxIndividualScorersPerTeamPerEvent;
    const theirs = Array.from({ length: 6 }, (_, i) => swim(THEM, `T${i}`, '100 Free SCY', `${47 + i}.00`));
    const report = scout([swim(US, 'Ann', '100 Free SCY', '58.00')], theirs, { settings: open });
    expect(report.perTeamCap).toBeNull();
    expect(report.cappedOut).toEqual([]);
    expect(report.events[0]?.theirs).toHaveLength(6);
  });
});

describe('swing events: neighbouring entries of opposite teams whose trade changes who leads the event', () => {
  // NSISC place table: 20, 17, 16, 15, 14, 13, 12, 11, 9, ... Finish order and teams (o = ours, t = theirs):
  // o t o t o o t t t. Event points: ours 20+16+14+13 = 63, theirs 17+15+12+11+9 = 64. Theirs lead by 1.
  //  - trading places 1 and 2 (48.00 and 50.99, 2.99 s apart) moves 3 points each way: theirs still lead.
  //  - trading places 2 and 3 (0.01 s apart) moves 1 point each way: ours lead. This is the swing.
  const order: Array<['o' | 't', string, string]> = [
    ['o', 'A', '48.00'],
    ['t', 'X', '50.99'],
    ['o', 'B', '51.00'],
    ['t', 'Y', '51.50'],
    ['o', 'C', '52.00'],
    ['o', 'D', '52.50'],
    ['t', 'Z', '53.00'],
    ['t', 'W', '53.50'],
    ['t', 'V', '54.00'],
  ];
  const mine = order.filter(([side]) => side === 'o').map(([, name, time]) => swim(US, name, '100 Free SCY', time));
  const theirs = order.filter(([side]) => side === 't').map(([, name, time]) => swim(THEM, name, '100 Free SCY', time));
  const report = scout(mine, theirs, { settings: NSISC_SETTINGS, conference: 'NSISC' });
  const event = report.events[0];

  it('the best-against-best pair is not the swing: the 0.01 s race for second is', () => {
    expect(event?.ourPoints).toBe(63);
    expect(event?.theirPoints).toBe(64);
    // The two fastest swimmers are 2.99 s apart and trading them does not change who leads the event's points.
    expect(event?.marginSec).toBe(2.99);
    expect(event?.swing?.gapSec).toBe(0.01);
    expect(event?.swing?.theirSwimmer).toBe('X');
    expect(event?.swing?.ourSwimmer).toBe('B');
    expect([event?.swing?.theirPlace, event?.swing?.ourPlace]).toEqual([2, 3]);
    expect(event?.swing?.ourPointsNow).toBe(63);
    expect(event?.swing?.theirPointsNow).toBe(64);
    expect(event?.swing?.ourPointsIfTraded).toBe(64);
    expect(event?.swing?.theirPointsIfTraded).toBe(63);
    expect(report.swingEvents.map(e => e.event)).toEqual(['100 Freestyle']);
  });

  it('the wins list and the swing list differ: a win is the faster best swimmer, a swing is a changeable lead', () => {
    const second = scout(
      [...mine, swim(US, 'P', '200 Free SCY', '1:40.00'), swim(US, 'Q', '200 Free SCY', '1:41.00'), swim(US, 'R', '200 Free SCY', '1:42.00')],
      [...theirs, swim(THEM, 'S', '200 Free SCY', '1:50.00')],
      { settings: NSISC_SETTINGS, conference: 'NSISC' }
    );
    expect(second.wins.map(e => e.event)).toEqual(['100 Freestyle', '200 Freestyle']);
    expect(second.swingEvents.map(e => e.event)).toEqual(['100 Freestyle']);
  });

  it('inside one event the closest pair is the smallest percent of the slower time, not the smallest seconds', () => {
    // Same finish order and teams as above. Two pairs change the lead: places 2 and 3 (0.50 s of 100.50 = 0.50
    // percent) and places 4 and 5 (0.51 s of 190.51 = 0.27 percent). By seconds the first would be chosen.
    const times = ['99.00', '100.00', '100.50', '190.00', '190.51', '191.00', '192.00', '193.00', '194.00'];
    const rows = order.map(([side, name], i) => swim(side === 'o' ? US : THEM, name, '100 Free SCY', times[i] ?? ''));
    const r = scout(
      rows.filter(x => x.team === US),
      rows.filter(x => x.team === THEM),
      { settings: NSISC_SETTINGS, conference: 'NSISC' }
    );
    expect(r.events[0]?.swing?.gapSec).toBe(0.51);
    expect(r.events[0]?.swing?.theirSwimmer).toBe('Y');
    expect(r.events[0]?.swing?.ourSwimmer).toBe('C');
  });

  it('an event with no neighbouring trade that changes the lead is not a swing event', () => {
    // ours 1st, 2nd, 3rd; theirs 4th. Trading 3rd and 4th moves one point and ours still lead by a wide margin.
    const r = scout(
      [swim(US, 'A', '100 Free SCY', '48.00'), swim(US, 'B', '100 Free SCY', '48.50'), swim(US, 'C', '100 Free SCY', '49.00')],
      [swim(THEM, 'X', '100 Free SCY', '49.50')],
      { settings: NSISC_SETTINGS, conference: 'NSISC' }
    );
    expect(r.wins).toHaveLength(1);
    expect(r.events[0]?.swing).toBeNull();
    expect(r.swingEvents).toEqual([]);
  });

  it('two entries of one team side by side are not a pair, and a tie is not traded', () => {
    const r = scout(
      [swim(US, 'A', '100 Free SCY', '48.00'), swim(US, 'B', '100 Free SCY', '48.00')],
      [swim(THEM, 'X', '100 Free SCY', '48.00')],
      { settings: NSISC_SETTINGS, conference: 'NSISC' }
    );
    expect(r.events[0]?.swing).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* What is not compared, and why                                               */
/* -------------------------------------------------------------------------- */

describe('the event-order caveat', () => {
  const rows = [swim(US, 'Ann', '100 Free SCY', '48.50')];
  const them = [swim(THEM, 'Bea', '100 Free SCY', '49.00')];

  it('shows only for a meet-wide scorer pool, as the engine fills one in event order', () => {
    expect(NSISC_SETTINGS.scorerCapScope).toBe('meet');
    expect((NSISC_SETTINGS.maxIndividualScorersPerTeam ?? 999) < 999).toBe(true);
    expect(scout(rows, them, { settings: NSISC_SETTINGS, conference: 'NSISC' }).caveats).toContain(EVENT_ORDER_CAVEAT);
  });

  it('is absent for a pool that is not meet-wide, and for a dual meet', () => {
    const notMeetWide: ScoringSettings = { ...NSISC_SETTINGS, scorerCapScope: 'event' };
    expect(scout(rows, them, { settings: notMeetWide }).caveats).not.toContain(EVENT_ORDER_CAVEAT);
    expect(scout(rows, them).caveats).not.toContain(EVENT_ORDER_CAVEAT);
  });
});

describe('rows that are not a recorded yards swim', () => {
  const rows = [
    swim(US, 'Ann', '100 Free SCY', '48.50'),
    swim(US, 'Exh', '100 Free SCY', '40.00', { isExhibition: true }),
    swim(US, 'Tt', '100 Free SCY', '41.00', { isTimeTrial: true }),
    swim(US, 'Conv', '100 Free SCY', '42.00', {
      convertedFrom: { sourceCourse: 'LCM', sourceEvent: '100 Free LCM', sourceTime: '48.00', scyTime: '42.00', basis: {} as never },
    }),
    swim(US, 'Lcm', '100 Free LCM', '43.00'),
    swim(US, 'Nt', '100 Free SCY', 'NT'),
    swim(US, 'Typed', '100 Free SCY', '44.00', { id: 'typed-row' }),
  ];
  const report = scout(rows, [swim(THEM, 'Bea', '100 Free SCY', '49.00')], { excludeOurRowIds: new Set(['typed-row']) });

  it('lists each one with its reason and keeps it out of the comparison', () => {
    expect(report.leftOut.map(l => [l.swimmer, l.reason])).toEqual([
      ['Exh', 'exhibition'],
      ['Tt', 'time_trial'],
      ['Conv', 'converted_estimate'],
      ['Lcm', 'not_scy'],
      ['Nt', 'no_valid_time'],
      ['Typed', 'caller_excluded'],
    ]);
    expect(report.events[0]?.ours.map(e => e.swimmer)).toEqual(['Ann']);
    expect(report.events[0]?.ourBest.time).toBe('48.50');
  });

  it('a row with no recorded origin is left out and listed as unknown_source, apart from a typed one', () => {
    const r = scout(
      [
        swim(US, 'Ann', '100 Free SCY', '48.50'),
        swim(US, 'Unknown', '100 Free SCY', '40.00', { id: 'unknown-row' }),
        swim(US, 'Typed', '100 Free SCY', '41.00', { id: 'typed-row' }),
      ],
      [swim(THEM, 'Bea', '100 Free SCY', '49.00')],
      { excludeOurRowIds: new Set(['typed-row']), unknownSourceOurRowIds: new Set(['unknown-row']) }
    );
    expect(r.leftOut.map(l => [l.swimmer, l.reason])).toEqual([
      ['Unknown', 'unknown_source'],
      ['Typed', 'caller_excluded'],
    ]);
    expect(r.events[0]?.ours.map(e => e.swimmer)).toEqual(['Ann']);
  });

  it('lists diving and relays as not scouted, and never scores them', () => {
    const r = scout(
      [swim(US, 'Ann', '100 Free SCY', '48.50'), swim(US, 'Dive', '1M Diving', '300.45'), swim(US, 'R1', '200 Free Relay SCY', '1:25.00', { isRelay: true })],
      [swim(THEM, 'Bea', '100 Free SCY', '49.00'), swim(THEM, 'Dive2', '1M Diving', '280.10')]
    );
    expect(r.notScouted.some(n => n.reason === 'relay' && n.note === RELAYS_NOT_SCOUTED_NOTE)).toBe(true);
    expect(r.notScouted.filter(n => n.reason === 'diving').map(n => n.side)).toEqual(['ours', 'theirs']);
    expect(r.events.map(e => e.event)).toEqual(['100 Freestyle']);
  });
});

describe('input it will not guess about', () => {
  it('throws when the settings read points from a PDF', () => {
    const rows = [swim(US, 'Ann', '100 Free SCY', '48.50')];
    expect(() => scout(rows, rows, { settings: { ...DUAL, usePdfPlacePoints: true } })).toThrow(ScoutError);
    try {
      scout(rows, rows, { settings: { ...DUAL, usePdfPlacePoints: true } });
    } catch (e) {
      expect((e as ScoutError).code).toBe('pdf-points-settings');
    }
  });

  it('throws when our team and the opponent are one team', () => {
    expect(() => scout([], [], { opponentTeam: ` ${US.toLowerCase()} ` })).toThrow(/same team/);
  });

  it('throws when a row is the other gender', () => {
    expect(() => scout([swim(US, 'Ann', '100 Free SCY', '48.50', { gender: Gender.WOMEN })], [])).toThrow(ScoutError);
  });

  it('ignores rows of other teams on either side', () => {
    const r = scout(
      [swim(US, 'Ann', '100 Free SCY', '48.50'), swim('Some Third Team', 'Q', '100 Free SCY', '40.00')],
      [swim(THEM, 'Bea', '100 Free SCY', '49.00'), swim('Some Third Team', 'R', '100 Free SCY', '41.00')]
    );
    expect(r.events[0]?.ours.map(e => e.swimmer)).toEqual(['Ann']);
    expect(r.events[0]?.theirs.map(e => e.swimmer)).toEqual(['Bea']);
  });
});

/* -------------------------------------------------------------------------- */
/* Real crawled data                                                           */
/* -------------------------------------------------------------------------- */

function fixtureDeps(): TheoreticalCaptureDeps {
  const store = new FileSystemSwimCloudCaptureStore(FIXTURE_ROOT);
  return {
    listCaptures: async () => store.listCaptures(),
    parseCapture: async captureId => {
      const record = await store.getCapture(captureId);
      if (record === undefined) throw new Error(`no capture ${captureId}`);
      return parseSwimCloudCapture(store, record);
    },
    readRosterPageHtml: async (_id, canonicalUrl) => (await store.readPage(canonicalUrl))?.html,
  };
}



describe('Henderson State against Ouachita Baptist, from the real crawled fixtures', async () => {
  for (const gender of [Gender.MEN, Gender.WOMEN]) {
    const us = await loadOpponentSeeds({ captureIds: ['team-58-2026-2027'], gender, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS, conference: 'NSISC' });
    const them = await loadOpponentSeeds({ captureIds: ['team-412-2026-2027'], gender, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS, conference: 'NSISC' });
    const report = scoutOpponent({
      gender,
      ourTeam: us.teamName,
      opponentTeam: them.teamName,
      ourRows: us.rows,
      theirRows: them.rows,
      settings: NSISC_SETTINGS,
      conference: 'NSISC',
    });

    it(`${gender}: returns real rows, not a silent empty result`, () => {
      expect(us.teamName).toBe(US);
      expect(them.teamName).toBe(THEM);
      expect(us.rows.length).toBeGreaterThan(0);
      expect(them.rows.length).toBeGreaterThan(0);
      expect(report.events.length).toBeGreaterThan(0);
      expect(report.ourTotal).toBeGreaterThan(0);
      expect(report.theirTotal).toBeGreaterThan(0);
    });

    it(`${gender}: every compared event is a win, a loss or a tie, and the leader matches the times`, () => {
      expect(report.wins.length + report.losses.length + report.ties.length).toBe(report.events.length);
      for (const event of report.events) {
        const ours = convertTimeToSeconds(event.ourBest.time);
        const theirs = convertTimeToSeconds(event.theirBest.time);
        const expected = Math.round(ours * 100) === Math.round(theirs * 100) ? 'tie' : ours < theirs ? 'ours' : 'theirs';
        expect(event.leader, `${gender} ${event.event}`).toBe(expected);
        // Entries are fastest first, so the best is the first.
        expect(event.ours[0]?.time).toBe(event.ourBest.time);
        expect(event.theirs[0]?.time).toBe(event.theirBest.time);
      }
    });

    it(`${gender}: the totals are the sum of the entries' points`, () => {
      const ours = report.events.reduce((sum, e) => sum + e.ourPoints, 0);
      const theirs = report.events.reduce((sum, e) => sum + e.theirPoints, 0);
      expect(report.ourTotal).toBe(ours);
      expect(report.theirTotal).toBe(theirs);
    });

    it(`${gender}: events with a time on one side only are listed as no time, and counted nowhere else`, () => {
      const compared = new Set(report.events.map(e => e.event));
      for (const n of report.noTime) expect(compared.has(n.event)).toBe(false);
      expect(report.notScouted.some(n => n.reason === 'relay')).toBe(true);
    });
  }

  it('leaves exhibition swims out of the seeds, so they never take an event slot', async () => {
    // Ouachita men: 35 seed rows with exhibition swims included (9 of them exhibition), 33 with them excluded.
    const seeds = await loadOpponentSeeds({ captureIds: ['team-412-2026-2027'], gender: Gender.MEN, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS, conference: 'NSISC' });
    expect(seeds.rows).toHaveLength(33);
    expect(seeds.report.exhibitionSeedsUsed).toBe(0);
    expect(seeds.report.exhibitionEventsExcluded).toBe(11);
  });

  it('lists the measured seeds the entry limit left out, apart from events with no time', async () => {
    const seeds = await loadOpponentSeeds({ captureIds: ['team-412-2026-2027'], gender: Gender.MEN, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS, conference: 'NSISC' });
    expect(seeds.entryCapped.length).toBeGreaterThan(0);
    for (const seed of seeds.entryCapped) {
      expect(seeds.rows.some(r => r.name === seed.swimmer && r.event === seed.event), `${seed.swimmer} ${seed.event} has no row`).toBe(false);
      expect(convertTimeToSeconds(seed.time)).toBeGreaterThan(0);
    }
  });

  it('reads one capture at a time', async () => {
    await expect(
      loadOpponentSeeds({ captureIds: ['team-58-2026-2027', 'team-412-2026-2027'], gender: Gender.MEN, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS })
    ).rejects.toBeInstanceOf(OpponentLoadError);
  });
});

/* -------------------------------------------------------------------------- */
/* Our side as the app really scores it: HyTek labels, the HSU roster plan      */
/* -------------------------------------------------------------------------- */

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_ROOT, '..', name), 'utf8')) as T;
}

describe('the live panel path: allScored of a real workspace against crawled seeds', async () => {
  const them = await loadOpponentSeeds({ captureIds: ['team-412-2026-2027'], gender: Gender.MEN, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS, conference: 'NSISC' });
  const merged = (ws: Workspace): ScoringSettings => mergeScoringSettings(ws.scoringSettings, { conference: ws.conference });

  it('real NSISC meet rows (HyTek labels "Event 8 Men 50 Yard Freestyle") share an event identity with the seed labels', () => {
    const file = readFixture<{ menResults: SwimmerResult[]; womenResults: SwimmerResult[] }>('nsisc-2026-relay-followups-r1.json');
    const ws = { id: 'w1', name: 'NSISC fixture', menResults: file.menResults, womenResults: file.womenResults, recruits: [], createdAt: 0, conference: 'NSISC' } as Workspace;
    const allScored = buildScoringSnapshot(ws, Gender.MEN, false).projected.allScored;
    // The team string exactly as the real rows spell it.
    expect(allScored.some(r => r.team === US)).toBe(true);
    const report = scoutOpponent({ gender: Gender.MEN, ourTeam: US, opponentTeam: them.teamName, ourRows: allScored, theirRows: them.rows, settings: merged(ws), conference: 'NSISC' });
    expect(report.events.length).toBeGreaterThan(0);
    const fifty = report.events.find(e => e.event === '50 Freestyle');
    expect(fifty, '50 Freestyle is compared, not listed as no time').toBeDefined();
    expect(report.noTime.some(n => n.event === '50 Freestyle')).toBe(false);
    // Our best is the fastest individual HSU swim in that event in the source rows.
    const hsu50 = file.menResults
      .filter(r => r.team === US && r.isRelay !== true && r.event === 'Event 8 Men 50 Yard Freestyle' && r.isExhibition !== true)
      .map(r => r.time)
      .sort((a, b) => convertTimeToSeconds(a) - convertTimeToSeconds(b));
    expect(hsu50.length).toBeGreaterThan(0);
    expect(fifty?.ourBest.time).toBe(hsu50[0]);
  });

  it('the HSU 2026-27 roster plan (recruit rows and optimizer plans, no meet loaded) compares too', () => {
    const snap = readFixture<{ team: string; recruits: Recruit[]; meetEntryPlans: PlannedSwimEntry[]; activeEntryIds: string[] }>('hsu-2026-27-replace-snapshot.json');
    const ws = {
      id: 'w2',
      name: 'HSU roster plan',
      menResults: [],
      womenResults: [],
      recruits: snap.recruits,
      meetEntryPlans: snap.meetEntryPlans,
      activeEntryIds: snap.activeEntryIds,
      createdAt: 0,
      conference: 'NSISC',
    } as Workspace;
    const allScored = buildScoringSnapshot(ws, Gender.MEN, false).projected.allScored;
    expect(allScored.some(r => r.team === snap.team)).toBe(true);
    const report = scoutOpponent({
      gender: Gender.MEN,
      ourTeam: snap.team,
      opponentTeam: them.teamName,
      ourRows: allScored,
      theirRows: them.rows,
      settings: merged(ws),
      conference: 'NSISC',
      excludeOurRowIds: handTypedRowIds(ws, Gender.MEN, snap.team),
      unknownSourceOurRowIds: unknownSourceRowIds(ws, Gender.MEN, snap.team),
    });
    expect(report.events.length).toBeGreaterThan(0);
    expect(report.events.length + report.noTime.length).toBeGreaterThan(report.noTime.length);
    // Optimizer and SwimCloud plans are measured bests, so nothing is left out for being typed by hand.
    expect(report.leftOut.filter(l => l.reason === 'caller_excluded')).toEqual([]);
    // The recruit rows of this snapshot carry no source, so they are listed, not scored.
    expect(unknownSourceRowIds(ws, Gender.MEN, snap.team).size).toBeGreaterThan(0);
    expect(report.leftOut.some(l => l.reason === 'unknown_source')).toBe(true);
  });

  it('picking your own crawl is refused after the load, by the school name on the roster page', async () => {
    // The fixture capture records carry no school name, so the list titles the team "Team 58" and the
    // panel cannot hide it by name. The roster page names the school, and the comparison refuses it.
    const records = (await fixtureDeps().listCaptures()) as CaptureListRecord[];
    const own = groupCaptures(records, Date.now()).find(g => g.teamId === '58');
    expect(own?.named).toBe(false);
    const hsu = await loadOpponentSeeds({ captureIds: ['team-58-2026-2027'], gender: Gender.MEN, deps: fixtureDeps(), scoringSettings: NSISC_SETTINGS, conference: 'NSISC' });
    expect(() =>
      scoutOpponent({ gender: Gender.MEN, ourTeam: US, opponentTeam: hsu.teamName, ourRows: hsu.rows, theirRows: hsu.rows, settings: NSISC_SETTINGS, conference: 'NSISC' })
    ).toThrow(/same team/);
  });

  it('two spellings of one school are one school; two schools are not', () => {
    expect(isSameSchool('Henderson State', US)).toBe(true);
    expect(isSameSchool(US.toUpperCase(), US)).toBe(true);
    expect(isSameSchool(THEM, US)).toBe(false);
    expect(isSameSchool('Unmapped Club A', 'Unmapped Club B')).toBe(false);
  });
});
