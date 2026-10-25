// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F5: the season progression panel and its view helpers.
 *
 * Mutation map (revert the change, the named case turns red):
 *  - a path drawn across a missed meet                  -> "a missed meet ends the line"
 *  - null read as 0 in the geometry                     -> "a missed meet ends the line"
 *  - drop bar drawn for one swim or for a first-is-best -> "marks the drop only when there is one"
 *  - table dropped or gap shown as a time               -> "has a table alternative with a dash for a gap"
 *  - event picker not wired                             -> "the event picker changes the swimmers"
 *  - team null no empty state                           -> "asks for a team"
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SeasonProgressionPanel } from '../apps/shell/src/components/SeasonProgressionPanel';
import { describeDrop, describeRepeatSwims, sparkGeometry } from '../apps/shell/src/lib/seasonProgressionView';
import type { Workspace } from '../packages/core/src/types';

let n = 0;
const swim = (name: string, event: string, time: string) => ({
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
});
const meet = (id: string, rows: unknown[]): Workspace =>
  ({ id, name: `Meet ${id}`, createdAt: 1, menResults: rows, womenResults: [], recruits: [], deletedSwimmers: [] }) as unknown as Workspace;

const WORKSPACES = [
  meet('a', [swim('Ann', '100 Free', '52.00'), swim('Bob', '100 Free', '55.00'), swim('Ann', '200 Free', '1:55.00')]),
  meet('b', [swim('Bob', '100 Free', '54.00')]),
  meet('c', [swim('Ann', '100 Free', '51.00'), swim('Bob', '100 Free', '53.00'), swim('Solo', '100 Free', '50.00')]),
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(team: string | null, workspaces: Workspace[] = WORKSPACES) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(React.createElement(SeasonProgressionPanel, { workspaces, team }));
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('sparkGeometry', () => {
  it('a missed meet ends the line: no path crosses a null and no mark is invented', () => {
    const g = sparkGeometry([52, null, 51, 50.5]);
    expect(g.marks[1]).toBeNull();
    expect(g.paths).toHaveLength(1); // only the run 51 -> 50.5; the lone first point has no path
    expect(g.paths[0]!.split('L')).toHaveLength(2);
  });

  it('puts a faster swim lower and a single value mid-height', () => {
    const g = sparkGeometry([52, 51]);
    expect(g.marks[1]!.y).toBeGreaterThan(g.marks[0]!.y);
    const flat = sparkGeometry([50, 50]);
    expect(flat.marks[0]!.y).toBe(flat.marks[1]!.y);
  });
});

describe('describeDrop', () => {
  it('words one swim, no drop and a real drop apart', () => {
    expect(describeDrop(null)).toMatch(/only one swim/i);
    expect(describeDrop(0)).toMatch(/no drop yet/i);
    expect(describeDrop(0.7)).toBe('Dropped 0.70 seconds from the first swim to the best.');
  });
  it('notes repeat swims only when there are some', () => {
    expect(describeRepeatSwims({ swimmers: [] })).toBeNull();
  });
});

describe('SeasonProgressionPanel', () => {
  it('asks for a team when none is chosen', () => {
    const el = render(null);
    expect(el.querySelector('[data-testid="season-progression-empty"]')?.textContent).toMatch(/choose a team/i);
    expect(el.querySelector('select')).toBeNull();
  });

  it('shows no swimmers for a team with no rows', () => {
    const el = render('Nobody');
    expect(el.querySelector('[data-testid="season-progression-empty"]')?.textContent).toMatch(/No timed swims for Nobody/);
    expect(el.querySelectorAll('[data-testid="progression-card"]')).toHaveLength(0);
  });

  it('draws one card per swimmer with its own text alternative', () => {
    const el = render('Home');
    const cards = [...el.querySelectorAll('[data-testid="progression-card"]')];
    expect(cards.map(c => c.querySelector('h3')?.textContent)).toEqual(['Ann', 'Bob', 'Solo']);
    for (const card of cards) {
      const svg = card.querySelector('svg')!;
      const labelledBy = svg.getAttribute('aria-labelledby')!;
      expect(card.querySelector(`#${CSS.escape(labelledBy)}`)?.textContent).toMatch(/:/);
    }
    expect(cards[0]!.textContent).toMatch(/Dropped 1\.00 seconds/);
    expect(cards[2]!.textContent).toMatch(/Only one swim/);
  });

  it('marks the drop only when there is one', () => {
    const el = render('Home');
    const cards = [...el.querySelectorAll('[data-testid="progression-card"]')];
    expect(cards[0]!.querySelector('[data-testid="progression-drop"]')).not.toBeNull(); // Ann: 52 -> 51
    expect(cards[2]!.querySelector('[data-testid="progression-drop"]')).toBeNull(); // Solo: one swim
  });

  it('draws no drop bar for a swimmer whose first swim is still the best', () => {
    const flat = render('Home', [meet('a', [swim('Flat', '100 Free', '49.00')]), meet('b', [swim('Flat', '100 Free', '49.50')])]);
    expect(flat.querySelector('[data-testid="progression-drop"]')).toBeNull();
    expect(flat.textContent).toMatch(/No drop yet/);
  });

  it('has a table alternative with a dash for a gap, never a time', () => {
    const el = render('Home');
    const rows = [...el.querySelectorAll('[data-testid="progression-table"] tbody tr')];
    const ann = [...rows[0]!.querySelectorAll('td')].map(td => td.textContent);
    // First, best, drop, then meets 1..3 where Ann missed meet 2.
    expect(ann).toEqual(['52.00', '51.00', '1.00 seconds', '52.00', '—no timed swim', '51.00']);
  });

  it('the event picker changes the swimmers', () => {
    const el = render('Home');
    const select = el.querySelector('select') as HTMLSelectElement;
    const labels = [...select.options].map(o => o.textContent);
    expect(labels).toEqual(['100 Freestyle (SCY)', '200 Freestyle (SCY)']);
    const second = select.options[1]!.value;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(select, second);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const cards = [...el.querySelectorAll('[data-testid="progression-card"]')];
    expect(cards.map(c => c.querySelector('h3')?.textContent)).toEqual(['Ann']);
    expect(el.querySelector('[data-testid="progression-drop"]')).toBeNull();
  });
});
