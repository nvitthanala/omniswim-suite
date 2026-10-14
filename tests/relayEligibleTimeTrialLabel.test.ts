// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9 in the Manager UI: a relay-leg candidate that rests on a time trial carries a text label, and the
 * Individual and relay panel hands the workspace's scoring settings to the core matchers so the panel
 * and the scored lineup agree. Time trials stay off relay legs unless
 * `ScoringSettings.relayLegsAllowTimeTrials` is on.
 *
 * Real rows come from `tests/fixtures/nsisc-2026-relay-followups-r1.json` (2026 NSISC Championships).
 * Aiden Killackey (Henderson State) has a 100 Free time trial and no other 100 Free swim. Scott Doll
 * swims the third leg of the 4x100 Free Relay. Written without JSX, like the other panel tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type RelayLegHistoryOrigin, type ScoringSettings, type SwimmerResult, type TeamScore, type Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { canonicalSwimmerName, simulateRoster } from '@omniswim/core/lib/utils';
import IndRelayManagementView from '../packages/manager/src/components/IndRelayManagementView';
import RelayEligibleSwimmersPanel, {
  RELAY_LEG_TIME_TRIAL_LABEL,
} from '../packages/manager/src/components/RelayEligibleSwimmersPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const KILLACKEY = 'Aiden Killackey';
const ON: Pick<ScoringSettings, 'relayLegsAllowTimeTrials'> = { relayLegsAllowTimeTrials: true };

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
/**
 * The meet's individual rows plus its 4x100 Free Relay rows only. Scott Doll then vacates one relay, and
 * the panel's selected relay is the one a 100 Free time trial can fill.
 */
const menResults = fixture.menResults.filter(r => !r.isRelay || r.event === M_400FR);

/** A history-sourced leg candidate carries the swim as recorded. The panel only reads that it is present. */
const HISTORY_ORIGIN: RelayLegHistoryOrigin = { event: '100 Freestyle', time: '50.82', timeType: 'SCY', source: 'swimcloud' };

function row(over: Partial<SwimmerResult>): SwimmerResult {
  return {
    id: 'row',
    rank: 0,
    name: 'Row',
    classYear: 'JR',
    team: HSU,
    time: '50.82',
    points: 0,
    event: 'Event 35 Men 100 Yard Freestyle',
    gender: Gender.MEN,
    ...over,
  };
}

describe('RelayEligibleSwimmersPanel time-trial label', () => {
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

  it('labels a time-trial candidate in text, and only that candidate', () => {
    const candidates = [
      row({ id: 'a', name: 'Plain Swimmer' }),
      row({ id: 'b', name: 'Trial Swimmer', event: 'Event 201 Men 100 Yard Freestyle Time Trial', relayLegTimeTrial: true }),
    ];
    act(() => root.render(createElement(RelayEligibleSwimmersPanel, { eventLabel: '4x100 Free', poolCandidates: candidates })));

    const items = Array.from(container.querySelectorAll('li'));
    expect(items).toHaveLength(2);
    expect(RELAY_LEG_TIME_TRIAL_LABEL).toBe('Time trial');
    expect(items[0]!.textContent).not.toContain('Time trial');
    expect(items[1]!.textContent).toContain('Trial Swimmer');
    expect(items[1]!.textContent).toContain('Time trial');
    // The label is a text node inside a badge, not a colour on the row.
    const badge = Array.from(items[1]!.querySelectorAll('span')).find(
      s => s.textContent === 'Time trial' && s.children.length === 0
    );
    expect(badge).toBeTruthy();
    expect(badge!.className).toContain('border-theme-soft');
  });

  it('shows the label beside the history badge, and no label without the flag', () => {
    const candidates = [
      row({ id: 'h', name: 'History Trial', relayLegHistory: HISTORY_ORIGIN, relayLegTimeTrial: true }),
      row({ id: 'g', name: 'History Only', relayLegHistory: HISTORY_ORIGIN }),
    ];
    act(() => root.render(createElement(RelayEligibleSwimmersPanel, { eventLabel: '4x100 Free', poolCandidates: candidates })));

    const [both, historyOnly] = Array.from(container.querySelectorAll('li'));
    expect(both!.textContent).toContain('From history');
    expect(both!.textContent).toContain('Time trial');
    expect(historyOnly!.textContent).toContain('From history');
    expect(historyOnly!.textContent).not.toContain('Time trial');
  });
});

describe('IndRelayManagementView passes the scoring settings to the relay-leg matchers', () => {
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

  function bundle(allScored: SwimmerResult[]): ScoringBundle {
    const team: TeamScore = { teamName: HSU, totalPoints: 0, swimmers: [], color: '#38bdf8' };
    return {
      allResults: allScored,
      allScored,
      events: [],
      visibleEvents: [],
      sortedTeams: [team],
      timelineData: [],
      teamStyleSignature: '',
    };
  }

  /** Scott Doll leaves, so his relay legs are vacant. Killackey is the only 100 Free time trial. */
  async function renderPanel(
    settings: Partial<ScoringSettings> | undefined,
    onUpdate: (patch: Partial<Workspace>) => void = () => undefined,
    rows: SwimmerResult[] = menResults
  ) {
    const excluded = new Set([canonicalSwimmerName('Scott Doll')]);
    const scored = simulateRoster(rows, [], false, excluded, [], new Set(), [], settings);
    const workspace = {
      id: 'ws-time-trial-panel',
      name: 'Time trial panel',
      createdAt: 0,
      menResults: rows,
      womenResults: [],
      recruits: [],
      meetEntryPlans: [],
      activeEntryIds: [],
      athleteHistory: [],
      relayLegOverrides: [],
      deletedSwimmers: [{ name: 'Scott Doll', gender: Gender.MEN }],
      scorerRosterOverrides: [],
      ...(settings ? { scoringSettings: settings } : {}),
    } as unknown as Workspace;
    await act(async () => {
      root.render(
        createElement(IndRelayManagementView, {
          workspace,
          gender: Gender.MEN,
          scoringBundle: bundle(scored),
          selectedTeam: HSU,
          whatIfMode: true,
          removeSeniors: false,
          onUpdate,
          hideTeamPicker: true,
          onSelectTeam: () => undefined,
        })
      );
    });
  }

  it('offers no time-trial swimmer by default', async () => {
    await renderPanel(undefined);
    expect(container.textContent).not.toContain(KILLACKEY);
    expect(container.textContent).not.toContain('Time trial');
  });

  it('offers the time-trial swimmer, labelled, when the workspace allows it', async () => {
    await renderPanel(ON);
    const label = Array.from(container.querySelectorAll('li')).find(li => li.textContent?.includes(KILLACKEY));
    expect(label, 'Killackey was not offered').toBeTruthy();
    expect(label!.textContent).toContain('Time trial');
  });

  /** Fills the vacant leg through the "Auto-fill best" button and returns the override patch, if any. */
  async function autofillPatch(settings: Partial<ScoringSettings> | undefined, buttonText = 'Auto-fill best') {
    const patches: Partial<Workspace>[] = [];
    // Drop every other 100 Free swim, so the time trial is the only swim left that
    // fits the leg. Auto-fill picks the fastest candidate, so this isolates the setting's effect.
    const rows = menResults.filter(
      r => r.isRelay || r.name === KILLACKEY || !/100 Yard Freestyle/.test(r.event)
    );
    await renderPanel(settings, patch => patches.push(patch), rows);
    const button = Array.from(container.querySelectorAll('button')).find(b =>
      b.textContent?.includes(buttonText)
    );
    expect(button, `no ${buttonText} button`).toBeTruthy();
    await act(async () => {
      button!.click();
    });
    return patches;
  }

  it('auto-fill leaves the time trial out by default', async () => {
    const patches = await autofillPatch(undefined);
    const names = patches.flatMap(p => p.relayLegOverrides ?? []).map(o => o.assigneeName);
    expect(names).not.toContain(KILLACKEY);
  });

  it('auto-fill may use the time trial when the workspace allows it', async () => {
    const patches = await autofillPatch(ON);
    const names = patches.flatMap(p => p.relayLegOverrides ?? []).map(o => o.assigneeName);
    expect(names).toStrictEqual([KILLACKEY]);
  });

  it('auto-fill all follows the setting too', async () => {
    const off = await autofillPatch(undefined, 'Auto-fill all');
    expect(off.flatMap(p => p.relayLegOverrides ?? []).map(o => o.assigneeName)).not.toContain(KILLACKEY);
    // A fresh mount per call: unmount the first render before the second.
    act(() => root.unmount());
    root = createRoot(container);
    const on = await autofillPatch(ON, 'Auto-fill all');
    expect(on.flatMap(p => p.relayLegOverrides ?? []).map(o => o.assigneeName)).toStrictEqual([KILLACKEY]);
  });
});
