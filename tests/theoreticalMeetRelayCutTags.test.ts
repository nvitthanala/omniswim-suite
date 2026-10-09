// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * An estimated relay is not judged against a relay cut.
 *
 * CONSTRUCTED. Henderson State (Division II) men, four swimmers whose 50 Free bests are 19.50, 19.60, 19.70
 * and 19.80. The 200 Free Relay estimate is their sum: 1:18.60. Judged as a real relay time it reaches
 * "D2 PROVISIONAL". Nobody swam it, so a theoretical meet must not show that tag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Gender } from '../packages/core/src/types';
import type { SwimmerResult } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { isEstimatedRelayRow, isTheoreticalMeet } from '../packages/core/src/lib/theoreticalMeetLabel';
import { buildTheoreticalMeetSeeds } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { buildTheoreticalMeetWorkspace } from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import { RELAY_ESTIMATE_NOT_JUDGED_LABEL, buildTeamRowCutlineTags } from '../packages/matrix/src/components/teamCardView';
import { RelayVerdict } from '../packages/matrix/src/components/TeamCardParts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HSU = 'Henderson State';
const BESTS: Record<string, string> = { H1: '19.50', H2: '19.60', H3: '19.70', H4: '19.80' };

const seeds = buildTheoreticalMeetSeeds({
  meetId: 'ws-cut',
  course: 'SCY',
  scoringSettings: NSISC_PRESET_SETTINGS,
  conference: 'NSISC',
  includeRelays: true,
  teams: [
    {
      teamName: HSU,
      gender: Gender.MEN,
      rosterStatus: 'parsed',
      athletes: Object.entries(BESTS).map(([name, time]) => ({
        athlete: { name, swimCloudSwimmerId: name, classYear: 'JR', gender: 'Men' },
        swims: [{ name, team: HSU, gender: Gender.MEN, event: '50 Free SCY', time, timeType: 'SCY', source: 'swimcloud' }],
      })),
    },
  ],
});
const built = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-cut', createdAt: 1, seeds, scoringSettings: NSISC_PRESET_SETTINGS, conference: 'NSISC' });
const workspace = built.payload;
const legs = workspace.menResults.filter(r => r.isRelay === true) as SwimmerResult[];

describe('estimated relay and its cut tag', () => {
  it('has the Henderson State estimate of 1:18.60 (sum of 19.50, 19.60, 19.70, 19.80)', () => {
    expect(legs).toHaveLength(4);
    expect(legs.every(r => r.event === '200 Free Relay SCY' && r.relayTeamTime === '1:18.60')).toBe(true);
    expect(isTheoreticalMeet(workspace)).toBe(true);
    expect(legs.every(r => isEstimatedRelayRow(workspace, r))).toBe(true);
  });

  it('a real relay row at the same time still gets the real D2 PROVISIONAL tag (the control)', () => {
    const view = buildTeamRowCutlineTags(legs[0], Gender.MEN, HSU, legs[0].time);
    if (view.kind !== 'relay') throw new Error('expected a relay view');
    expect(view.relayEstimate).toBe(false);
    expect(view.tags.relay?.state).toBe('tagged');
    expect((view.tags.relay as { tag: { label: string } }).tag.label).toBe('D2 PROVISIONAL');
  });

  it('withholds the relay verdict on every leg when the row is an estimated relay (not absent, not no_cut)', () => {
    for (const row of legs) {
      const view = buildTeamRowCutlineTags(row, Gender.MEN, HSU, row.time, isEstimatedRelayRow(workspace, row));
      if (view.kind !== 'relay') throw new Error('expected a relay view');
      expect(view.relayEstimate).toBe(true);
      expect(view.tags.relay).toBeNull();
    }
  });

  it('keeps leg 1 own verdict slot and gives legs 2 to 4 none', () => {
    const leg1 = buildTeamRowCutlineTags(legs[0], Gender.MEN, HSU, legs[0].time, true);
    const real = buildTeamRowCutlineTags(legs[0], Gender.MEN, HSU, legs[0].time, false);
    if (leg1.kind !== 'relay' || real.kind !== 'relay') throw new Error('expected relay views');
    expect(leg1.tags.legQualification).toEqual(real.tags.legQualification);
    for (const row of legs.slice(1)) {
      const view = buildTeamRowCutlineTags(row, Gender.MEN, HSU, row.time, true);
      if (view.kind !== 'relay') throw new Error('expected a relay view');
      expect(view.tags.legQualification).toBeNull();
    }
  });

  it('does not change an individual row', () => {
    const individual = { ...legs[0], isRelay: false, event: '50 Free SCY', time: '19.50' } as SwimmerResult;
    const view = buildTeamRowCutlineTags(individual, Gender.MEN, HSU, '19.50', true);
    expect(view.kind).toBe('single');
  });

  it('renders "Estimate, not judged" for the withheld verdict, and no cut tag', () => {
    const view = buildTeamRowCutlineTags(legs[1], Gender.MEN, HSU, legs[1].time, true);
    if (view.kind !== 'relay') throw new Error('expected a relay view');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(createElement(RelayVerdict, { tags: view }));
    });
    expect(container.textContent).toBe(RELAY_ESTIMATE_NOT_JUDGED_LABEL);
    expect(container.textContent).not.toMatch(/PROVISIONAL|CUT/i);
    act(() => root.unmount());
    container.remove();
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});
