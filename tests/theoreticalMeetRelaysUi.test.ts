// @vitest-environment happy-dom
/**
 * The relay switch, the flying-start setting, the relay list in the preview, the banner and the Manager tag.
 *
 * The capture API is faked over the committed fixtures (tests/theoreticalMeetUiFixtures.ts). No competition
 * value is typed in here: the relays shown are compared with the relays the data layer built.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../packages/core/src/types';
import { Gender } from '../packages/core/src/types';
import { displayTimeForRelayLeg } from '../packages/core/src/lib/relaySplits';
import { RELAYS_ESTIMATED_CAVEAT, RELAYS_EXCLUDED_CAVEAT } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { THEORETICAL_MEET_LABEL } from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { TheoreticalMeetDialogContent } from '../packages/manager/src/components/theoreticalMeet/TheoreticalMeetDialog';
import { buildMeet, readTeamCapture } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetFlow';
import { TheoreticalMeetBanner, bannerCaveatsFor, theoreticalMeetHasRelays } from '../packages/manager/src/components/theoreticalMeet/TheoreticalMeetBanner';
import { parseFlyingStartText, parseMaxRelaysText } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import RelayGroupCard from '../packages/manager/src/components/RelayGroupCard';
import RelaySplitInspector, { RELAY_SPLIT_ESTIMATED_LABEL, RELAY_SPLIT_KNOWN_LABEL } from '../packages/manager/src/components/RelaySplitInspector';
import { buildRelayGroups } from '../packages/manager/src/components/indRelayGroupsView';
import { CAPTURE_IDS, fakeCaptureApi, fixtureRecords } from './theoreticalMeetUiFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = CAPTURE_IDS[0];

/* -------------------------------------------------------------------------- */
/* The text boxes                                                              */
/* -------------------------------------------------------------------------- */

describe('parseMaxRelaysText', () => {
  it('reads an empty box as no limit, never as 0 or 1', () => {
    expect(parseMaxRelaysText('')).toBeUndefined();
    expect(parseMaxRelaysText('   ')).toBeUndefined();
  });
  it('reads a number, and passes a typo on as NaN so the builder rejects it', () => {
    expect(parseMaxRelaysText('2')).toBe(2);
    expect(Number.isNaN(parseMaxRelaysText('two'))).toBe(true);
  });
});

describe('parseFlyingStartText', () => {
  it('reads an empty box as no value, never as zero', () => {
    expect(parseFlyingStartText({ 50: '', 100: '  ', 200: '' })).toEqual({});
  });
  it('reads a typed number, and passes a typo on as NaN so the builder rejects it', () => {
    expect(parseFlyingStartText({ 50: '0.25', 100: '', 200: 'abc' })).toMatchObject({ 50: 0.25 });
    expect(Number.isNaN(parseFlyingStartText({ 50: '', 100: '', 200: 'abc' })[200])).toBe(true);
    // 0 is a typed value (no change), different from an empty box (no value).
    expect(parseFlyingStartText({ 50: '0', 100: '', 200: '' })).toEqual({ 50: 0 });
  });
});

/* -------------------------------------------------------------------------- */
/* The dialog                                                                  */
/* -------------------------------------------------------------------------- */

describe('the dialog: relays', () => {
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
  });

  const tick = (ms = 20) => act(async () => void (await new Promise(resolve => setTimeout(resolve, ms))));
  async function waitFor<T>(read: () => T | null | undefined | false, timeout = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`waitFor timed out. Dialog text: ${document.body.textContent?.slice(0, 600)}`);
      await tick();
    }
  }
  const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
  const qa = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)];
  const button = (name: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
  const click = (el: Element) => act(async () => void (el as HTMLElement).click());
  const choose = (select: HTMLSelectElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

  async function toScoringStep(presetId = 'nsisc') {
    act(() => {
      root.render(
        createElement(TheoreticalMeetDialogContent, {
          api: fakeCaptureApi(),
          workspaces: [] as Workspace[],
          restoreWorkspace: async (w: Workspace) => w,
          onCreated: () => undefined,
          onClose: () => undefined,
          now: () => Date.parse('2026-10-05T00:00:00Z'),
        })
      );
    });
    await waitFor(() => q(`input[id="tmeet-capture-${A}"]`));
    await click(q(`input[id="tmeet-capture-${A}"]`)!);
    await click(button('Next')!);
    await choose(q<HTMLSelectElement>('#tmeet-scoring-select')!, presetId);
  }

  async function toPreview() {
    await click(button('Next')!);
    await waitFor(() => {
      const b = button('Create theoretical meet');
      return b && !b.disabled ? b : null;
    });
  }

  const openTeams = async () => {
    for (const summary of document.body.querySelectorAll('button[aria-expanded="false"]')) await click(summary);
  };

  it('has an "Include relays (estimated)" switch, on by default, with one plain sentence', async () => {
    await toScoringStep();
    const relays = q<HTMLInputElement>('#tmeet-relays')!;
    expect(relays.checked).toBe(true);
    expect(relays.getAttribute('role')).toBe('switch');
    expect(relays.labels?.[0]?.textContent).toBe('Include relays (estimated)');
    const help = document.getElementById(relays.getAttribute('aria-describedby')!)!;
    expect(help.textContent).toBe("Relay times are built from each swimmer's individual best times, so they are estimates and not times any team swam.");
  });

  it('has a flying-start setting that is OFF by default, with no default value in any box', async () => {
    await toScoringStep();
    const flying = q<HTMLInputElement>('#tmeet-flying-start')!;
    expect(flying.checked).toBe(false);
    expect(q('#tmeet-flying-start-50')).toBeNull();
    expect(document.getElementById(flying.getAttribute('aria-describedby')!)?.textContent).toMatch(/A box left empty means no adjustment/);
    await click(flying);
    for (const distance of [50, 100, 200]) {
      const box = q<HTMLInputElement>(`#tmeet-flying-start-${distance}`)!;
      expect(box.value).toBe('');
      expect(box.labels?.[0]?.textContent).toContain(`${distance}-yard legs`);
    }
  });

  it('lists each relay in the preview with its four swimmers and the estimated tag, and says the totals are estimates', async () => {
    await toScoringStep();
    await toPreview();
    await openTeams();
    const cards = qa('[data-tmeet-relay]');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.textContent).toContain('estimated');
      expect(card.querySelectorAll('ol > li')).toHaveLength(4);
    }
    // The leg lines name leg 1 as a flat-start best and legs 2 to 4 as estimates.
    const first = cards[0];
    const legs = [...first.querySelectorAll('ol > li')].map(li => li.textContent ?? '');
    expect(legs[0]).toContain('flat-start best');
    expect(legs[0]).not.toMatch(/estimated$/);
    for (const text of legs.slice(1)) expect(text).toContain('estimated');
    expect(document.body.textContent).toContain('Relays are estimates');
    expect(document.body.textContent).not.toContain('Relays are not included');
    // A relay a team could not form says so, with the leg and the reason.
    expect(qa('[data-tmeet-relay-absent]').length).toBeGreaterThan(0);
    expect(qa('[data-tmeet-relay-absent]')[0].textContent).toMatch(/No .+ Relay SCY entry\. Leg \d \(/);
  });

  it('shows the same relays the data layer built', async () => {
    const records = await fixtureRecords();
    const api = fakeCaptureApi();
    const read = await readTeamCapture(api, A, records);
    const built = buildMeet({ captureIds: [A], resultsByCaptureId: { [A]: read }, scoringChoiceId: 'nsisc', includeRelays: true }, 'preview-id', 1);
    await toScoringStep();
    await toPreview();
    await openTeams();
    expect(qa('[data-tmeet-relay]').length).toBe(built.seeds.relayEntries.length);
    const shown = qa('[data-tmeet-relay]').map(c => c.textContent ?? '');
    for (const relay of built.seeds.relayEntries) {
      const card = shown.find(t => t.includes(relay.event) && relay.legs.every(l => t.includes(l.name)) && t.includes(relay.totalTime));
      expect(card, `${relay.team} ${relay.event}`).toBeDefined();
    }
  });

  it('builds no relay with the switch off, and says relays are not included', async () => {
    await toScoringStep();
    await click(q<HTMLInputElement>('#tmeet-relays')!);
    expect(q('#tmeet-flying-start')).toBeNull();
    await toPreview();
    await openTeams();
    expect(qa('[data-tmeet-relay]')).toHaveLength(0);
    expect(document.body.textContent).toContain(RELAYS_EXCLUDED_CAVEAT);
    expect(document.body.textContent).not.toContain('Relays are estimates');
  });

  it('subtracts a typed flying-start gain from legs 2 to 4 and shows it, leaving empty distances alone', async () => {
    await toScoringStep();
    await click(q<HTMLInputElement>('#tmeet-flying-start')!);
    await type(q<HTMLInputElement>('#tmeet-flying-start-50')!, '0.25');
    await toPreview();
    await openTeams();
    const text = qa('[data-tmeet-relay]').map(c => c.textContent ?? '');
    // 200 Free and 200 Medley have 50-yard legs, so they show the adjustment on legs 2 to 4.
    const fifty = text.filter(t => /^(200 (Free|Medley) Relay SCY)/.test(t));
    expect(fifty.length).toBeGreaterThan(0);
    for (const t of fifty) expect(t.match(/less 0\.25 s/g)).toHaveLength(3);
    // 100-yard and 200-yard legs have no value: no adjustment text.
    const others = text.filter(t => /^(400|800) /.test(t));
    expect(others.length).toBeGreaterThan(0);
    for (const t of others) expect(t).not.toContain('less ');
    expect(document.body.textContent).toMatch(/No adjustment for 100 yd, 200 yd legs/);
  });

  it('shows a problem, not a default, when a flying-start box holds a negative number', async () => {
    await toScoringStep();
    await click(q<HTMLInputElement>('#tmeet-flying-start')!);
    await type(q<HTMLInputElement>('#tmeet-flying-start-50')!, '-1');
    await click(button('Next')!);
    await waitFor(() => /relay settings cannot be used/.test(document.body.textContent ?? ''));
    expect(button('Create theoretical meet')?.disabled ?? true).toBe(true);
  });

  it('has a "Relays per swimmer: at most" box that is empty by default, with no number in it', async () => {
    await toScoringStep();
    const box = q<HTMLInputElement>('#tmeet-max-relays')!;
    expect(box.value).toBe('');
    expect(box.labels?.[0]?.textContent).toContain('Relays per swimmer: at most');
    expect(document.getElementById(box.getAttribute('aria-describedby')!)?.textContent).toMatch(/Empty: no limit beyond the entry cap/);
    // Unset: the preview says nothing about a limit.
    await toPreview();
    expect(document.body.textContent).not.toContain('Relays per swimmer: at most');
  });

  it('applies a typed limit: the preview says it, and the relays are the ones the data layer builds with that limit', async () => {
    await toScoringStep();
    await type(q<HTMLInputElement>('#tmeet-max-relays')!, '1');
    await toPreview();
    expect(document.body.textContent).toContain('Relays per swimmer: at most 1.');
    await openTeams();
    const records = await fixtureRecords();
    const read = await readTeamCapture(fakeCaptureApi(), A, records);
    const args = { captureIds: [A], resultsByCaptureId: { [A]: read }, scoringChoiceId: 'nsisc', includeRelays: true as const };
    const limited = buildMeet({ ...args, maxRelaysPerSwimmer: 1 }, 'ws-limit', 1).seeds;
    const unlimited = buildMeet(args, 'ws-limit', 1).seeds;
    expect(qa('[data-tmeet-relay]')).toHaveLength(limited.relayEntries.length);
    expect(limited.relayEntries.length).toBeLessThan(unlimited.relayEntries.length);
  });

  it('shows a problem, not a default, when the limit is 0', async () => {
    await toScoringStep();
    await type(q<HTMLInputElement>('#tmeet-max-relays')!, '0');
    await click(button('Next')!);
    await waitFor(() => /relay settings cannot be used/.test(document.body.textContent ?? ''));
    expect(button('Create theoretical meet')?.disabled ?? true).toBe(true);
  });

  it('says plainly that a preset with no relay program builds no relay', async () => {
    await toScoringStep('generic-top16');
    await toPreview();
    expect(document.body.textContent).toContain('No relay was built: this scoring preset has no relay program on record.');
    expect(document.body.textContent).toContain('no relay program is on record');
    expect(qa('[data-tmeet-relay]')).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The banner and the Manager card                                             */
/* -------------------------------------------------------------------------- */

describe('the banner and the Manager relay card', async () => {
  const records = await fixtureRecords();
  const api = fakeCaptureApi();
  const read = await readTeamCapture(api, A, records);
  const args = { captureIds: [A], resultsByCaptureId: { [A]: read }, scoringChoiceId: 'nsisc' };
  const withRelays = buildMeet({ ...args, includeRelays: true }, 'ws-banner', 1).build.payload;
  const without = buildMeet(args, 'ws-banner', 1).build.payload;

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
  });

  it('says relays are estimates when the workspace holds relay rows, and not included when it holds none', () => {
    expect(theoreticalMeetHasRelays(withRelays)).toBe(true);
    expect(theoreticalMeetHasRelays(without)).toBe(false);
    expect(theoreticalMeetHasRelays({ loadedMeet: { meetLabel: 'A real meet' }, menResults: withRelays.menResults })).toBe(false);
    act(() => root.render(createElement(TheoreticalMeetBanner, { workspace: withRelays as never })));
    expect(container.textContent).toContain('Relays are estimates.');
    expect(container.textContent).not.toContain('Relays are not included');
    act(() => container.querySelector('button')!.click());
    expect(container.textContent).toContain(RELAYS_ESTIMATED_CAVEAT);
    act(() => root.render(createElement(TheoreticalMeetBanner, { workspace: without as never })));
    expect(container.textContent).toContain('Relays are not included.');
    expect(bannerCaveatsFor(false)).toContain(RELAYS_EXCLUDED_CAVEAT);
    expect(bannerCaveatsFor(true)).not.toContain(RELAYS_EXCLUDED_CAVEAT);
    expect(THEORETICAL_MEET_LABEL).toBeTruthy();
  });

  it('shows the estimated tag on the Manager relay card of a theoretical meet only', () => {
    const rows = withRelays.menResults.filter(r => r.isRelay === true);
    const team = rows[0].team;
    const groups = buildRelayGroups({ allScored: rows, originalResults: rows, gender: Gender.MEN, team });
    expect(groups.length).toBeGreaterThan(0);
    const noop = () => undefined;
    const props = {
      group: groups[0],
      isSelected: false,
      whatIfMode: false,
      dragOverLeg: null,
      manualTimes: {},
      overrides: [],
      onSelect: noop,
      onAutofillAllVacant: noop,
      onAutofillLeg: noop,
      onAssignDragPayload: noop,
      onSetDragOverLeg: noop,
      onManualTimeChange: noop,
      onSaveManualLeg: noop,
      onClearLegOverride: noop,
    };
    act(() => root.render(createElement(RelayGroupCard, { ...props, estimated: true })));
    expect(container.textContent).toContain('estimated');
    // The leg times on the card are the estimated leg times, not the team clock.
    for (const leg of groups[0].legs) expect(container.textContent).toContain(displayTimeForRelayLeg(leg));
    act(() => root.render(createElement(RelayGroupCard, props)));
    expect(container.textContent).not.toContain('estimated');
  });
});

/* -------------------------------------------------------------------------- */
/* The split inspector                                                         */
/* -------------------------------------------------------------------------- */

describe('the relay split inspector label', () => {
  const rows = [
    { legIndex: 0, swimmerName: 'A1', knownSplit: '20.00', calculatedSplit: '20.10', deltaSec: 0.1, source: 'pdf' as const },
    { legIndex: 1, swimmerName: 'A2', knownSplit: '20.50', calculatedSplit: null, deltaSec: null, source: 'pdf' as const },
  ];
  let host: HTMLDivElement;
  let rootNode: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    rootNode = createRoot(host);
  });
  afterEach(() => {
    act(() => rootNode.unmount());
    host.remove();
  });

  it('calls the splits of an estimated relay "Estimated (flat-start best)", never "Known (PDF)"', () => {
    act(() => rootNode.render(createElement(RelaySplitInspector, { rows, eventLabel: '200 Free Relay SCY', estimated: true })));
    expect(host.textContent).toContain(RELAY_SPLIT_ESTIMATED_LABEL);
    expect(host.textContent).toContain('Estimated (flat-start best)');
    expect(host.textContent).not.toContain('Known (PDF)');
    expect(host.textContent).toContain('20.00');
  });

  it('keeps "Known (PDF)" for a real meet', () => {
    act(() => rootNode.render(createElement(RelaySplitInspector, { rows, eventLabel: '200 Free Relay SCY' })));
    expect(host.textContent).toContain(RELAY_SPLIT_KNOWN_LABEL);
    expect(host.textContent).not.toContain('Estimated');
  });
});
