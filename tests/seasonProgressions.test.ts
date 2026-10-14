/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F5: `buildSeasonProgressions`, the per-swimmer, per-event, per-meet times
 * behind the season progression chart.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - a missed meet read as 0 or skipped from `points`   -> "a missed meet is a null gap"
 *  - one swim reported as a drop of 0                   -> "one swim has no drop; a first swim that is still best drops 0"
 *  - athleteHistory rows read as swims                  -> "leaves athlete history out"
 *  - other teams' rows read                             -> "reads only the chosen team"
 *  - unreadable time coerced (parseFloat, `?? 0`)       -> "leaves an unreadable time out and counts it"
 *  - dives or relays kept                               -> "leaves dives and relays out"
 *  - two swims at one meet both plotted                 -> "plots the faster of two swims at one meet"
 *  - theoretical meet read                              -> "skips a theoretical meet"
 */
import { describe, expect, it } from 'vitest';
import { buildSeasonProgressions } from '../packages/core/src/lib/seasonAnalytics';
import { THEORETICAL_MEET_LABEL } from '../packages/core/src/lib/theoreticalMeetLabel';
import type { Workspace } from '../packages/core/src/types';

let n = 0;
const swim = (name: string, event: string, time: string, extra: Record<string, unknown> = {}) => ({
  id: `r${++n}`,
  name,
  event,
  time,
  team: 'Home',
  gender: 'Men',
  rank: 1,
  classYear: 'FR',
  points: 0,
  isRelay: false,
  ...extra,
});

function meet(id: string, rows: unknown[], extra: Record<string, unknown> = {}): Workspace {
  return {
    id,
    name: `Meet ${id}`,
    createdAt: 1,
    menResults: rows,
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    ...extra,
  } as unknown as Workspace;
}

const FREE = '100 Free';

describe('buildSeasonProgressions', () => {
  it('reads nothing without a team', () => {
    const out = buildSeasonProgressions([meet('a', [swim('Ann', FREE, '52.10')])], { team: null });
    expect(out.events).toEqual([]);
    expect(out.swimmers).toEqual([]);
    expect(out.selectedEventKey).toBeNull();
  });

  it('measures the drop from the first meet to the best, in meet order', () => {
    const out = buildSeasonProgressions(
      [
        meet('a', [swim('Ann', FREE, '52.10')]),
        meet('b', [swim('Ann', FREE, '51.40')]),
        meet('c', [swim('Ann', FREE, '51.62')]),
      ],
      { team: 'Home' }
    );
    expect(out.meets.map(m => m.id)).toEqual(['a', 'b', 'c']);
    const [ann] = out.swimmers;
    expect(ann).toMatchObject({
      name: 'Ann',
      firstIndex: 0,
      bestIndex: 1,
      firstTime: '52.10',
      bestTime: '51.40',
      meetsSwum: 3,
      dropSeconds: 0.7,
    });
    expect(ann?.points.map(p => p?.time)).toEqual(['52.10', '51.40', '51.62']);
  });

  it('one swim has no drop; a first swim that is still best drops 0', () => {
    const out = buildSeasonProgressions(
      [
        meet('a', [swim('Solo', FREE, '50.00'), swim('Flat', FREE, '49.00')]),
        meet('b', [swim('Flat', FREE, '49.50')]),
      ],
      { team: 'Home' }
    );
    const solo = out.swimmers.find(s => s.name === 'Solo');
    const flat = out.swimmers.find(s => s.name === 'Flat');
    expect(solo?.dropSeconds).toBeNull();
    expect(solo?.meetsSwum).toBe(1);
    expect(solo?.firstIndex).toBe(solo?.bestIndex);
    expect(flat?.dropSeconds).toBe(0);
    expect(flat?.bestIndex).toBe(0);
  });

  it('a missed meet is a null gap, never 0 or an interpolated time', () => {
    const out = buildSeasonProgressions(
      [
        meet('a', [swim('Ann', FREE, '52.00'), swim('Bob', FREE, '55.00')]),
        meet('b', [swim('Bob', FREE, '54.00')]),
        meet('c', [swim('Ann', FREE, '51.00'), swim('Bob', FREE, '53.00')]),
      ],
      { team: 'Home' }
    );
    const ann = out.swimmers.find(s => s.name === 'Ann');
    expect(ann?.points).toHaveLength(3);
    expect(ann?.points[1]).toBeNull();
    expect(ann?.meetsSwum).toBe(2);
    expect(ann?.dropSeconds).toBe(1);
  });

  it('plots the faster of two swims at one meet', () => {
    const out = buildSeasonProgressions(
      [meet('a', [swim('Ann', FREE, '52.10'), swim('Ann', FREE, '51.80')]), meet('b', [swim('Ann', FREE, '51.90')])],
      { team: 'Home' }
    );
    const ann = out.swimmers[0];
    expect(ann?.points[0]).toMatchObject({ time: '51.80', swimsAtMeet: 2 });
    expect(ann?.firstTime).toBe('51.80');
    expect(ann?.dropSeconds).toBe(0);
  });

  it('compares minutes against seconds, not as text', () => {
    const out = buildSeasonProgressions(
      [meet('a', [swim('Cy', '200 Free', '1:52.00')]), meet('b', [swim('Cy', '200 Free', '59.90')])],
      { team: 'Home' }
    );
    expect(out.swimmers[0]?.bestTime).toBe('59.90');
    expect(out.swimmers[0]?.dropSeconds).toBe(52.1);
  });

  it('reads only the chosen team', () => {
    const out = buildSeasonProgressions(
      [meet('a', [swim('Ann', FREE, '52.10'), swim('Rival', FREE, '45.00', { team: 'Away' })])],
      { team: 'home' }
    );
    expect(out.swimmers.map(s => s.name)).toEqual(['Ann']);
    expect(out.events[0]?.swimmerCount).toBe(1);
  });

  it('leaves athlete history out', () => {
    const ws = meet('a', [swim('Ann', FREE, '52.10')], {
      athleteHistory: [
        { name: 'Ann', team: 'Home', gender: 'Men', event: '100 Free SCY', time: '49.00', timeType: 'SCY', source: 'swimcloud' },
      ],
    });
    const out = buildSeasonProgressions([ws], { team: 'Home' });
    expect(out.swimmers[0]).toMatchObject({ firstTime: '52.10', bestTime: '52.10', meetsSwum: 1 });
  });

  it('leaves an unreadable time out and counts it', () => {
    const out = buildSeasonProgressions(
      [meet('a', [swim('Ann', FREE, '52.10'), swim('Bob', FREE, 'DQ'), swim('Cy', FREE, '52.1x')])],
      { team: 'Home' }
    );
    expect(out.swimmers.map(s => s.name)).toEqual(['Ann']);
    expect(out.unreadableTimeRows).toBe(2);
  });

  it("reads HyTek's record flag (51.86R) as the time it flags and shows the time without it", () => {
    const out = buildSeasonProgressions(
      [meet('a', [swim('Ann', FREE, '52.10')]), meet('b', [swim('Ann', FREE, '51.86R')])],
      { team: 'Home' }
    );
    expect(out.swimmers[0]).toMatchObject({ bestTime: '51.86', dropSeconds: 0.24 });
    expect(out.unreadableTimeRows).toBe(0);
  });

  it('lists an event whose every time is unreadable, with no swimmers', () => {
    const out = buildSeasonProgressions([meet('a', [swim('Bob', FREE, 'NS')])], { team: 'Home' });
    expect(out.events).toHaveLength(1);
    expect(out.swimmers).toEqual([]);
    expect(out.unreadableTimeRows).toBe(1);
  });

  it('leaves dives and relays out', () => {
    const out = buildSeasonProgressions(
      [
        meet('a', [
          swim('Div', '1 mtr Diving', '250.35'),
          swim('Home Relay', '200 Free Relay', '1:30.00', { isRelay: true }),
          swim('Ann', FREE, '52.10'),
        ]),
      ],
      { team: 'Home' }
    );
    expect(out.events.map(e => e.label)).toEqual(['100 Freestyle']);
    expect(out.swimmers.map(s => s.name)).toEqual(['Ann']);
  });

  it('skips a theoretical meet', () => {
    const theoretical = meet('t', [swim('Ann', FREE, '50.00')], {
      loadedMeet: { pdfFilename: THEORETICAL_MEET_LABEL, uploadedAt: 1, meetLabel: THEORETICAL_MEET_LABEL },
    });
    const out = buildSeasonProgressions([meet('a', [swim('Ann', FREE, '52.10')]), theoretical], { team: 'Home' });
    expect(out.meets.map(m => m.id)).toEqual(['a']);
    expect(out.swimmers[0]?.bestTime).toBe('52.10');
  });

  it('folds two labels of one event together and keeps courses apart', () => {
    const out = buildSeasonProgressions(
      [
        meet('a', [swim('Ann', 'Event 35 Men 100 Yard Freestyle', '52.10')]),
        meet('b', [swim('Ann', '100 Free SCY', '51.90'), swim('Ann', '100 Free SCM', '58.00')]),
      ],
      { team: 'Home' }
    );
    expect(out.events.map(e => [e.label, e.course])).toEqual([
      ['100 Freestyle', 'SCM'],
      ['100 Freestyle', 'SCY'],
    ]);
    const scy = buildSeasonProgressions(
      [
        meet('a', [swim('Ann', 'Event 35 Men 100 Yard Freestyle', '52.10')]),
        meet('b', [swim('Ann', '100 Free SCY', '51.90')]),
      ],
      { team: 'Home' }
    );
    expect(scy.swimmers[0]?.meetsSwum).toBe(2);
  });

  it('picks the event most swimmers swam when none is asked for, and honors a valid key', () => {
    const rows = [
      swim('Ann', '200 Free', '1:52.00'),
      swim('Ann', FREE, '52.00'),
      swim('Bob', FREE, '53.00'),
    ];
    const out = buildSeasonProgressions([meet('a', rows)], { team: 'Home' });
    expect(out.events.map(e => e.label)).toEqual(['100 Freestyle', '200 Freestyle']);
    expect(out.selectedEventKey).toBe(out.events[0]?.key);
    const asked = buildSeasonProgressions([meet('a', rows)], { team: 'Home', eventKey: out.events[1]?.key });
    expect(asked.swimmers.map(s => s.name)).toEqual(['Ann']);
    const unknown = buildSeasonProgressions([meet('a', rows)], { team: 'Home', eventKey: 'nope' });
    expect(unknown.selectedEventKey).toBe(out.selectedEventKey);
  });

  it('a team with no rows has no events and no points', () => {
    const out = buildSeasonProgressions([meet('a', [swim('Ann', FREE, '52.10')])], { team: 'Nobody' });
    expect(out.events).toEqual([]);
    expect(out.swimmers).toEqual([]);
  });
});
