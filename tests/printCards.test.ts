// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F1: printable lineup and relay cards in the Manager.
 *
 * Relay rows come from `tests/fixtures/nsisc-2026-relay-followups-r1.json` (2026 NSISC Championships,
 * Henderson State). Scott Doll leaves, so his relay legs are vacant. Written without JSX, like the other
 * panel tests. The cards read the plan and the scored rows; nothing in them is scored again.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Gender,
  type PlannedSwimEntry,
  type SwimmerResult,
  type TeamScore,
  type Workspace,
} from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { THEORETICAL_MEET_LABEL } from '@omniswim/core/lib/theoreticalMeetLabel';
import { canonicalSwimmerName, simulateRoster } from '@omniswim/core/lib/utils';
import PrintCards, { PRINT_ESTIMATE_LABEL } from '../packages/manager/src/components/PrintCards';
import PrintCardsButton from '../packages/manager/src/components/PrintCardsButton';
import { RELAY_LEG_TIME_TRIAL_LABEL } from '../packages/manager/src/components/RelayEligibleSwimmersPanel';
import { buildPrintCards, printableTime } from '../packages/manager/src/components/printCardsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[] };
const menResults = fixture.menResults.filter(r => !r.isRelay || r.event === M_400FR);

function entry(over: Partial<PlannedSwimEntry>): PlannedSwimEntry {
  return {
    id: 'e',
    name: 'Colton Bennett',
    team: HSU,
    gender: Gender.MEN,
    classYear: 'JR',
    event: 'Event 4 Men 1000 Yard Freestyle',
    time: '9:26.63',
    timeType: 'SCY',
    source: 'manual',
    active: true,
    ...over,
  };
}

function workspaceWith(entries: PlannedSwimEntry[], loadedMeetLabel?: string): Workspace {
  return {
    id: 'ws-print',
    name: 'Print cards',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    meetEntryPlans: entries,
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [{ name: 'Scott Doll', gender: Gender.MEN }],
    scorerRosterOverrides: [],
    ...(loadedMeetLabel ? { loadedMeet: { meetLabel: loadedMeetLabel } } : {}),
  } as unknown as Workspace;
}

/** Scored rows with Scott Doll's legs vacant. `timeTrialLeg` marks that leg's row as filled from a time trial. */
function scoredBundle(timeTrialLeg?: number): ScoringBundle {
  const excluded = new Set([canonicalSwimmerName('Scott Doll')]);
  const scored = simulateRoster(menResults, [], false, excluded, [], new Set(), [], undefined);
  const rows =
    timeTrialLeg === undefined
      ? scored
      : scored.map(r => (r.isRelay && r.team === HSU && r.relayLegIndex === timeTrialLeg ? { ...r, relayLegTimeTrial: true as const } : r));
  const team: TeamScore = { teamName: HSU, totalPoints: 412.5, swimmers: [], color: 'teal' };
  return {
    allResults: rows,
    allScored: rows,
    events: [],
    visibleEvents: [],
    sortedTeams: [team],
    timelineData: [],
    teamStyleSignature: '',
  };
}

describe('printableTime', () => {
  it('prints NT for a time that is not stored, and a stored time as stored', () => {
    expect(printableTime('')).toBe('NT');
    expect(printableTime(undefined)).toBe('NT');
    expect(printableTime('—')).toBe('NT');
    expect(printableTime('NT')).toBe('NT');
    expect(printableTime('0.00')).toBe('NT');
    expect(printableTime('0:00.00')).toBe('NT');
    expect(printableTime('9:26.63')).toBe('9:26.63');
    expect(printableTime('21.45')).toBe('21.45');
  });
});

describe('printable cards', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.querySelectorAll('[data-print-root]').forEach(n => n.remove());
  });

  function render(workspace: Workspace, bundle: ScoringBundle) {
    const cards = buildPrintCards({ workspace, scoringBundle: bundle, gender: Gender.MEN, team: HSU });
    act(() => root.render(createElement(PrintCards, { cards, meetLabel: 'Test meet' })));
    return cards;
  }

  it('prints NT, never 0.00, where a seed time is not stored', () => {
    const ws = workspaceWith([
      entry({ id: 'a', name: 'Has Time', time: '9:26.63' }),
      entry({ id: 'b', name: 'Blank Time', time: '' }),
      entry({ id: 'c', name: 'Zero Time', time: '0.00' }),
    ]);
    render(ws, scoredBundle());
    const rows = Array.from(container.querySelectorAll('[data-print-card="event"] tbody tr'));
    expect(rows).toHaveLength(3);
    const text = container.textContent ?? '';
    expect(text).toContain('9:26.63');
    expect(text).toContain('Blank Time');
    expect(text).not.toContain('0.00');
    const nt = rows.filter(r => r.textContent?.includes('NT'));
    expect(nt.map(r => r.textContent)).toEqual([
      expect.stringContaining('Blank Time'),
      expect.stringContaining('Zero Time'),
    ]);
    // A swimmer with a time sorts ahead of the two with none.
    expect(rows[0].textContent).toContain('Has Time');
  });

  it('prints team, event, round and the projected points on every card', () => {
    const ws = workspaceWith([entry({ id: 'a', projectedRound: 'Finals' })]);
    render(ws, scoredBundle());
    const card = container.querySelector('[data-print-card="event"]')!;
    expect(card.textContent).toContain(HSU);
    expect(card.textContent).toContain('Event 4 Men 1000 Yard Freestyle');
    expect(card.textContent).toContain('Round: Finals');
    expect(card.textContent).toContain('Projected points: 412.5');
  });

  it('prints a dash, not a guessed round, where no round is stored', () => {
    render(workspaceWith([entry({ id: 'a' })]), scoredBundle());
    expect(container.querySelector('[data-print-card="event"]')!.textContent).toContain('Round: —');
  });

  it('prints relay legs in order, a vacant leg as NT, and the time-trial badge only on its leg', () => {
    render(workspaceWith([]), scoredBundle(1));
    const relay = container.querySelector('[data-print-card="relay"]')!;
    expect(relay).toBeTruthy();
    const legs = Array.from(relay.querySelectorAll('tbody tr'));
    expect(legs.map(r => r.querySelector('td')?.textContent)).toEqual(['1', '2', '3', '4']);
    const badged = legs.filter(r => r.textContent?.includes(RELAY_LEG_TIME_TRIAL_LABEL));
    expect(badged).toHaveLength(1);
    expect(badged[0].querySelector('td')?.textContent).toBe('2');
    expect(RELAY_LEG_TIME_TRIAL_LABEL).toBe('Time trial');
    const vacant = legs.filter(r => r.textContent?.includes('Vacant'));
    expect(vacant.length).toBeGreaterThan(0);
    for (const row of vacant) {
      expect(row.textContent).toContain('NT');
      expect(row.textContent).not.toContain('0.00');
    }
  });

  it('prints no time-trial badge where no leg is flagged', () => {
    render(workspaceWith([]), scoredBundle());
    expect(container.textContent).not.toContain(RELAY_LEG_TIME_TRIAL_LABEL);
  });

  it('prints the word Estimate only on a relay of a theoretical meet', () => {
    render(workspaceWith([], THEORETICAL_MEET_LABEL), scoredBundle());
    const relay = container.querySelector('[data-print-card="relay"]')!;
    expect(PRINT_ESTIMATE_LABEL).toBe('Estimate');
    expect(relay.textContent).toContain('Estimate');

    render(workspaceWith([], 'NSISC Championships'), scoredBundle());
    expect(container.querySelector('[data-print-card="relay"]')!.textContent).not.toContain('Estimate');
  });

  it('puts every card on its own page', () => {
    const ws = workspaceWith([
      entry({ id: 'a' }),
      entry({ id: 'b', event: 'Event 6 Men 100 Yard Backstroke', time: '48.10' }),
    ]);
    const cards = render(ws, scoredBundle());
    const sections = Array.from(container.querySelectorAll('section'));
    expect(sections).toHaveLength(cards.events.length + cards.relays.length);
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) expect(s.classList.contains('ui-print-page')).toBe(true);
    // The stylesheet breaks the page after each card, and hides the rest of the screen.
    const css = readFileSync(join(repoRoot, 'packages', 'ui', 'src', 'index.css'), 'utf8');
    const printBlock = css.slice(css.indexOf('@media print'));
    expect(printBlock).toMatch(/\.ui-print-page\s*\{[^}]*break-after:\s*page/);
    expect(printBlock).toMatch(/body:has\(> \.ui-print-root\) > :not\(\.ui-print-root\)\s*\{[^}]*display:\s*none/);
  });

  it('has a "Print cards" button that prints through window.print and removes the sheet afterwards', () => {
    const print = vi.fn();
    const original = window.print;
    window.print = print;
    try {
      act(() =>
        root.render(
          createElement(PrintCardsButton, {
            workspace: workspaceWith([entry({ id: 'a' })]),
            gender: Gender.MEN,
            scoringBundle: scoredBundle(),
            team: HSU,
          })
        )
      );
      const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Print cards'));
      expect(button, 'no Print cards button').toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(false);

      act(() => {
        (button as HTMLButtonElement).click();
      });
      expect(print).toHaveBeenCalledTimes(1);
      const sheet = document.body.querySelector(':scope > .ui-print-root');
      expect(sheet, 'the sheet is not a direct child of body').toBeTruthy();
      expect(sheet!.querySelectorAll('.ui-print-page').length).toBeGreaterThan(0);

      act(() => {
        window.dispatchEvent(new Event('afterprint'));
      });
      expect(document.body.querySelector(':scope > .ui-print-root')).toBeNull();
    } finally {
      window.print = original;
    }
  });

  it('asks for review, and does not print, when the plan has an entry the export would flag', () => {
    const print = vi.fn();
    const original = window.print;
    window.print = print;
    try {
      act(() =>
        root.render(
          createElement(PrintCardsButton, {
            workspace: workspaceWith([entry({ id: 'a' }), entry({ id: 'b', name: '  ' })]),
            gender: Gender.MEN,
            scoringBundle: scoredBundle(),
            team: HSU,
          })
        )
      );
      const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Print cards'));
      act(() => {
        (button as HTMLButtonElement).click();
      });
      expect(print).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain('Review before print');
      expect(document.body.textContent).toContain('has no athlete name');
    } finally {
      window.print = original;
    }
  });

  it('disables the button when the team has nothing to print', () => {
    act(() =>
      root.render(
        createElement(PrintCardsButton, {
          workspace: workspaceWith([]),
          gender: Gender.WOMEN,
          scoringBundle: scoredBundle(),
          team: HSU,
        })
      )
    );
    const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Print cards'));
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
