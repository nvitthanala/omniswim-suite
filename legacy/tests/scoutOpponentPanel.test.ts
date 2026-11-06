/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: the "Scout a team" panel and its report view render without a crash and show an absent side as
 * "no time", never as a number.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Gender } from '../../packages/core/src/types';
import type { SwimmerResult, Workspace } from '../../packages/core/src/types';
import { composeDualMeetPreset } from '../../packages/core/src/lib/scoringDefaults';
import { scoutOpponent } from '../packages/manager/src/lib/opponentScouting';
import ScoutOpponentPanel from '../packages/manager/src/components/ScoutOpponentPanel';
import { ScoutReportView } from '../packages/manager/src/components/ScoutReportView';

const preset = composeDualMeetPreset('dual-six-lanes-or-more', 'dual-diving-six-or-more');
if (preset.settings === undefined) throw new Error('no settings');
const SETTINGS = preset.settings;
const US = 'Henderson State University';
const THEM = 'Ouachita Baptist University';

function swim(team: string, name: string, event: string, time: string): SwimmerResult {
  return { id: `${team}|${name}|${event}`, rank: 0, name, classYear: 'SR', team, time, points: 0, event, gender: Gender.MEN };
}

describe('Scout a team panel', () => {
  it('renders its first state (loading the crawled teams) with the intro and the terms', () => {
    const workspace = { id: 'w', name: 'W', menResults: [], womenResults: [], recruits: [], createdAt: 0 } as Workspace;
    const html = renderToStaticMarkup(
      createElement(ScoutOpponentPanel, {
        workspace,
        gender: Gender.MEN,
        team: US,
        scoredRows: [],
        scoringSettings: SETTINGS,
        captureApi: { listCaptures: () => new Promise<never>(() => undefined), parseCapture: () => new Promise<never>(() => undefined) },
      })
    );
    expect(html).toContain('Scout a team');
    expect(html).toContain('Loading crawled teams');
    expect(html).toContain('Swing event');
  });

  it('shows an event with one side missing as "no time" and never as 0', () => {
    const report = scoutOpponent({
      gender: Gender.MEN,
      ourTeam: US,
      opponentTeam: THEM,
      ourRows: [swim(US, 'Ann', '100 Free SCY', '48.50'), swim(US, 'Cy', '100 Fly SCY', '52.00')],
      theirRows: [swim(THEM, 'Bea', '100 Free SCY', '49.00')],
      settings: SETTINGS,
    });
    const html = renderToStaticMarkup(createElement(ScoutReportView, { report, caveats: ['Seeds are all-time bests.'], warnings: [] }));
    expect(html).toContain('Where you lead');
    expect(html).toContain('100 Butterfly');
    expect(html).toContain(`${THEM}: no time`);
    expect(html).toContain('Relays and diving are not included.');
    expect(html).toContain('Relays are not scouted');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('shows "no entry" for an event the entry limit left out, and the capped time', () => {
    const report = scoutOpponent({
      gender: Gender.MEN,
      ourTeam: US,
      opponentTeam: THEM,
      ourRows: [swim(US, 'Ann', '100 Free SCY', '48.50'), swim(US, 'Cy', '100 Fly SCY', '52.00')],
      theirRows: [swim(THEM, 'Bea', '100 Free SCY', '49.00')],
      settings: SETTINGS,
      theirEntryCapped: [{ swimmer: 'Dee', event: '100 Fly SCY', time: '53.10' }],
    });
    const html = renderToStaticMarkup(createElement(ScoutReportView, { report, caveats: [], warnings: [] }));
    expect(html).toContain(`${THEM}: no entry`);
    expect(html).toContain('Dee 53.10');
    expect(html).not.toContain(`${THEM}: no time`);
  });
});
