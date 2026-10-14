// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F2: the meet-day deck in the Manager. It shows the same cards the print
 * sheet prints (`buildPrintCards`), one per screen. Written without JSX, like
 * the other panel tests.
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
import MeetDayDeck, { deckCards } from '../packages/manager/src/components/MeetDayDeck';
import MeetDayDeckButton from '../packages/manager/src/components/MeetDayDeckButton';
import { PRINT_ESTIMATE_LABEL } from '../packages/manager/src/components/PrintCards';
import { RELAY_LEG_TIME_TRIAL_LABEL } from '../packages/manager/src/components/RelayEligibleSwimmersPanel';
import { buildPrintCards } from '../packages/manager/src/components/printCardsView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
const EVENT_A = 'Event 4 Men 1000 Yard Freestyle';
const EVENT_B = 'Event 6 Men 100 Yard Backstroke';

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
    event: EVENT_A,
    time: '9:26.63',
    timeType: 'SCY',
    source: 'manual',
    active: true,
    ...over,
  };
}

const DEFAULT_ENTRIES = [
  entry({ id: 'a', name: 'Has Time', time: '9:26.63' }),
  entry({ id: 'b', name: 'Blank Time', time: '' }),
  entry({ id: 'c', name: 'Zero Time', time: '0.00' }),
  entry({ id: 'd', name: 'Backstroker', event: EVENT_B, time: '48.10' }),
];

function workspaceWith(entries: PlannedSwimEntry[], loadedMeetLabel?: string): Workspace {
  return {
    id: 'ws-deck',
    name: 'Deck',
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

function scoredBundle(timeTrialLeg?: number): ScoringBundle {
  const excluded = new Set([canonicalSwimmerName('Scott Doll')]);
  const scored = simulateRoster(menResults, [], false, excluded, [], new Set(), [], undefined);
  const rows =
    timeTrialLeg === undefined
      ? scored
      : scored.map(r =>
          r.isRelay && r.team === HSU && r.relayLegIndex === timeTrialLeg ? { ...r, relayLegTimeTrial: true as const } : r
        );
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

function setReducedMotion(reduced: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

describe('meet-day deck', () => {
  let container: HTMLDivElement;
  let root: Root;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    setReducedMotion(false);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.matchMedia = originalMatchMedia;
  });

  function renderDeck(entries: PlannedSwimEntry[] = DEFAULT_ENTRIES, opts?: { bundle?: ScoringBundle; meet?: string }) {
    const workspace = workspaceWith(entries, opts?.meet);
    const set = buildPrintCards({
      workspace,
      scoringBundle: opts?.bundle ?? scoredBundle(),
      gender: Gender.MEN,
      team: HSU,
    });
    const onClose = vi.fn();
    act(() => root.render(createElement(MeetDayDeck, { cards: set, meetLabel: 'Test meet', onClose })));
    return { set, onClose };
  }

  const pressKey = (key: string) =>
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
  const position = () => container.querySelector('[data-deck-position]')!.textContent;
  const currentCard = () => container.querySelector('[data-deck-card]')!;
  const button = (label: string) =>
    Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === label) as HTMLButtonElement;

  it('shows one card per screen with the position as text, and arrow keys change the event', () => {
    const { set } = renderDeck();
    const list = deckCards(set);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll('[data-deck-card]')).toHaveLength(1);
    expect(position()).toBe(`1 of ${list.length}`);
    expect(currentCard().getAttribute('aria-label')).toContain(list[0].event);

    pressKey('ArrowRight');
    expect(position()).toBe(`2 of ${list.length}`);
    expect(currentCard().getAttribute('aria-label')).toContain(list[1].event);

    pressKey('ArrowLeft');
    expect(position()).toBe(`1 of ${list.length}`);
    expect(currentCard().getAttribute('aria-label')).toContain(list[0].event);

    // Stops at the first card.
    pressKey('ArrowLeft');
    expect(position()).toBe(`1 of ${list.length}`);
  });

  it('has visible Previous and Next buttons that stop at each end', () => {
    const { set } = renderDeck();
    const total = deckCards(set).length;
    expect(button('Previous').disabled).toBe(true);
    expect(button('Next').disabled).toBe(false);
    for (let i = 1; i < total; i += 1) {
      act(() => button('Next').click());
    }
    expect(position()).toBe(`${total} of ${total}`);
    expect(button('Next').disabled).toBe(true);
    act(() => button('Previous').click());
    expect(position()).toBe(`${total - 1} of ${total}`);
  });

  it('shows the same cards in the same order as the print sheet', () => {
    const { set } = renderDeck();
    const seen: string[] = [];
    for (let i = 0; i < deckCards(set).length; i += 1) {
      seen.push(`${currentCard().getAttribute('data-deck-card')}|${currentCard().getAttribute('aria-label')}`);
      pressKey('ArrowRight');
    }
    expect(seen).toEqual(deckCards(set).map(c => `${c.kind}|${c.event}, ${c.round}`));
    // Events first, then relays, as the print sheet orders them.
    expect(deckCards(set).map(c => c.kind)).toEqual([
      ...set.events.map(() => 'event'),
      ...set.relays.map(() => 'relay'),
    ]);
  });

  it('shows NT, never 0.00, where a seed time is not stored', () => {
    renderDeck([entry({ id: 'b', name: 'Blank Time', time: '' }), entry({ id: 'c', name: 'Zero Time', time: '0.00' })]);
    const rows = Array.from(container.querySelectorAll('[data-deck-row]'));
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.textContent).toContain('NT');
    expect(currentCard().textContent).not.toContain('0.00');
  });

  it('shows the Time trial badge only on its relay leg', () => {
    renderDeck([], { bundle: scoredBundle(1) });
    // No events: the first card is a relay.
    expect(currentCard().getAttribute('data-deck-card')).toBe('relay');
    const legs = Array.from(currentCard().querySelectorAll('[data-deck-row]'));
    const badged = legs.filter(r => r.textContent?.includes(RELAY_LEG_TIME_TRIAL_LABEL));
    expect(RELAY_LEG_TIME_TRIAL_LABEL).toBe('Time trial');
    expect(badged).toHaveLength(1);
    expect(badged[0].textContent).toMatch(/^2/);
    // A leg with no swimmer shows NT, not a time.
    const vacant = legs.filter(r => r.textContent?.includes('Vacant'));
    expect(vacant.length).toBeGreaterThan(0);
    for (const row of vacant) {
      expect(row.textContent).toContain('NT');
      expect(row.textContent).not.toContain('0.00');
    }
  });

  it('shows no Time trial badge where no leg is flagged', () => {
    renderDeck([]);
    expect(container.textContent).not.toContain(RELAY_LEG_TIME_TRIAL_LABEL);
  });

  it('shows the word Estimate only on a relay of a theoretical meet', () => {
    renderDeck([], { meet: THEORETICAL_MEET_LABEL });
    expect(PRINT_ESTIMATE_LABEL).toBe('Estimate');
    expect(currentCard().textContent).toContain('Estimate');
  });

  it('shows no Estimate word on a real meet', () => {
    renderDeck([], { meet: 'NSISC Championships' });
    expect(currentCard().textContent).not.toContain('Estimate');
  });

  it('slides on a button press, not on a key press', () => {
    renderDeck();
    expect(currentCard().getAttribute('data-deck-motion')).toBe('none');
    act(() => button('Next').click());
    expect(currentCard().getAttribute('data-deck-motion')).toBe('slide');
    expect(currentCard().className).toContain('starting:');
    pressKey('ArrowRight');
    expect(currentCard().getAttribute('data-deck-motion')).toBe('none');
    expect(currentCard().className).not.toContain('starting:');
  });

  it('adds no motion class under prefers-reduced-motion', () => {
    setReducedMotion(true);
    renderDeck();
    act(() => button('Next').click());
    const card = currentCard();
    expect(card.getAttribute('data-deck-motion')).toBe('none');
    expect(card.className).not.toContain('starting:');
    expect(card.className).not.toContain('transition');
    expect(card.className).not.toContain('duration-');
  });

  it('closes on Escape and on the Close button', () => {
    const { onClose } = renderDeck();
    act(() => button('Close').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    pressKey('Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('says so when the team has nothing to show, and shows 0 of 0', () => {
    const workspace = workspaceWith([]);
    const set = buildPrintCards({ workspace, scoringBundle: scoredBundle(), gender: Gender.WOMEN, team: HSU });
    act(() => root.render(createElement(MeetDayDeck, { cards: set, meetLabel: 'Test meet', onClose: () => {} })));
    expect(position()).toBe('0 of 0');
    expect(container.textContent).toContain('no entries or relays');
    expect(container.querySelector('[data-deck-card]')).toBeNull();
    expect(button('Next').disabled).toBe(true);
  });

  it('has a "Meet-day view" button that opens the deck and is disabled with nothing to show', () => {
    act(() =>
      root.render(
        createElement(MeetDayDeckButton, {
          workspace: workspaceWith(DEFAULT_ENTRIES),
          gender: Gender.MEN,
          scoringBundle: scoredBundle(),
          team: HSU,
        })
      )
    );
    const open = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Meet-day view');
    expect(open, 'no Meet-day view button').toBeTruthy();
    expect((open as HTMLButtonElement).disabled).toBe(false);
    act(() => (open as HTMLButtonElement).click());
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(position()).toMatch(/^1 of \d+$/);
    act(() => button('Close').click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    act(() =>
      root.render(
        createElement(MeetDayDeckButton, {
          workspace: workspaceWith([]),
          gender: Gender.WOMEN,
          scoringBundle: scoredBundle(),
          team: HSU,
        })
      )
    );
    const disabled = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Meet-day view');
    expect((disabled as HTMLButtonElement).disabled).toBe(true);
  });
});
