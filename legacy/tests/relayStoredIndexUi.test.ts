// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Two manager guards for stored relay data (user decisions E20 and E5):
 *
 *  - A stored relay leg index that names no leg (`isValidRelayLegIndex`) made
 *    `relayLegRequirements` throw at render and would blank the lineup. The relay
 *    card now shows a problem row ("Invalid relay leg on this entry") with a
 *    Remove action that deletes the stored override.
 *  - A saved leg choice keyed by the plain key of a tied pair of relays is
 *    ambiguous. `IndRelayManagementView` lists it and Remove deletes it, so the
 *    lineup audit item "Tied relay" can clear. Nothing is assigned to either relay.
 *
 * Written without JSX, like `tests/indRelayManagementViewR1.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  Gender,
  type RelayLegOverride,
  type SwimmerResult,
  type TeamScore,
  type Workspace,
} from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { migrateTiedRelayOverridesDetailed } from '@omniswim/core/lib/relayLegMatching';
import IndRelayManagementView from '../packages/manager/src/components/IndRelayManagementView';
import { buildRelayGroups } from '../packages/manager/src/components/indRelayGroupsView';
import { workspaceFixture } from '../../tests/helpers/typedFixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM = 'Home';
const EVENT = 'Event 31 Men 4x50 Yard Freestyle Relay';
const MEDLEY = 'Event 32 Men 4x50 Yard Medley Relay';
const CLOCK = '1:21.00';
const INVALID_LABEL = 'Invalid relay leg on this entry';

const relayLegs = (names: string[], event = EVENT, clock = CLOCK): SwimmerResult[] =>
  names.map(
    (name, i) =>
      ({
        id: `${event}-${names[0]}-${i}`,
        rank: 2,
        name,
        classYear: 'FR',
        team: TEAM,
        time: clock,
        finalsTime: clock,
        relayTeamTime: clock,
        roundSwam: 'A Final',
        points: 0,
        event,
        gender: Gender.MEN,
        isRelay: true,
        relayLegIndex: i,
        relayLegStroke: 'free',
        relayLegSplit: '20.00',
        relayNames: names.map(n => ({ name: n, year: 'FR' })),
      }) as SwimmerResult
  );

function bundle(allScored: SwimmerResult[]): ScoringBundle {
  const team: TeamScore = { teamName: TEAM, totalPoints: 0, swimmers: [], color: '#38bdf8' };
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

describe('IndRelayManagementView stored relay data guards', () => {
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

  async function render(
    results: SwimmerResult[],
    overrides: RelayLegOverride[],
    onUpdate: (patch: Partial<Workspace>) => void,
    whatIfMode = false
  ) {
    const workspace = workspaceFixture({ menResults: results, relayLegOverrides: overrides });
    await act(async () => {
      root.render(
        createElement(IndRelayManagementView, {
          workspace,
          gender: Gender.MEN,
          scoringBundle: bundle(results),
          whatIfMode,
          removeSeniors: false,
          onUpdate,
          selectedTeam: TEAM,
          hideTeamPicker: true,
          onSelectTeam: () => undefined,
        })
      );
    });
  }

  const removeButtons = (scope: ParentNode = container) =>
    Array.from(scope.querySelectorAll('button')).filter(b => b.textContent?.trim() === 'Remove');

  describe('a stored leg index that names no leg', () => {
    const legs = relayLegs(['C1', 'C2', 'C3', 'C4']);
    const groupKey = buildRelayGroups({
      allScored: legs,
      originalResults: legs,
      gender: Gender.MEN,
      team: TEAM,
    })[0]!.key;

    it('renders a labelled problem row instead of throwing, and Remove deletes the override', async () => {
      const good: RelayLegOverride = { relayEntryKey: groupKey, legIndex: 1, assigneeName: 'C2', source: 'drag' };
      const bad: RelayLegOverride = { relayEntryKey: groupKey, legIndex: -1, assigneeName: 'Z', source: 'drag' };
      const onUpdate = vi.fn();
      await render(legs, [good, bad], onUpdate);

      expect(container.textContent).toContain(INVALID_LABEL);
      expect(container.querySelectorAll('[data-invalid-relay-leg]')).toHaveLength(1);
      // The four readable legs still render.
      expect(container.textContent).toContain('C1');
      expect(container.textContent).toContain('C4');

      const buttons = removeButtons();
      expect(buttons).toHaveLength(1);
      await act(async () => {
        buttons[0]!.click();
      });
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith({ relayLegOverrides: [good] });
    });

    it('names a medley index past the fourth leg as invalid, and a free relay index as valid', async () => {
      const medley = relayLegs(['M1', 'M2', 'M3', 'M4'], MEDLEY);
      const medleyKey = buildRelayGroups({
        allScored: medley,
        originalResults: medley,
        gender: Gender.MEN,
        team: TEAM,
      })[0]!.key;
      const stray: RelayLegOverride = { relayEntryKey: medleyKey, legIndex: 4, assigneeName: 'Z', source: 'drag' };
      const onUpdate = vi.fn();
      await render(medley, [stray], onUpdate);
      expect(container.textContent).toContain(INVALID_LABEL);

      const free: RelayLegOverride = { relayEntryKey: groupKey, legIndex: 4, assigneeName: 'Z', source: 'drag' };
      await render(legs, [free], onUpdate);
      expect(container.textContent).not.toContain(INVALID_LABEL);
    });

    it('shows a bad index on a scored leg row without a crash, and offers no Remove when no override is stored', async () => {
      const rows = relayLegs(['D1', 'D2', 'D3', 'D4'], MEDLEY).map((r, i) =>
        i === 2 ? ({ ...r, relayLegIndex: 7 } as SwimmerResult) : r
      );
      await render(rows, [], vi.fn());
      expect(container.textContent).toContain(INVALID_LABEL);
      expect(removeButtons()).toHaveLength(0);
      expect(container.textContent).toContain('Re-import the meet');
    });
  });

  describe('a saved leg choice that matches two tied relays', () => {
    const tied = [...relayLegs(['A1', 'A2', 'A3', 'A4']), ...relayLegs(['B1', 'B2', 'B3', 'B4'])];
    const plainKey = `${TEAM}|${EVENT}|A Final|2|${CLOCK}`;
    const stored: RelayLegOverride = { relayEntryKey: plainKey, legIndex: 1, assigneeName: 'X1', source: 'drag' };

    it('core reports the key as ambiguous (the premise of the notice)', () => {
      const migration = migrateTiedRelayOverridesDetailed([stored], tied);
      expect(migration.ambiguous.map(a => a.relayEntryKey)).toEqual([plainKey]);
    });

    it('shows the notice, and Remove deletes the override without assigning it to a relay', async () => {
      const onUpdate = vi.fn();
      await render(tied, [stored], onUpdate);

      const notice = container.querySelector('[data-testid="ambiguous-relay-overrides"]');
      expect(notice).not.toBeNull();
      expect(notice!.textContent).toContain(
        'This saved leg choice matches two tied relays. Pick which relay it belongs to, or remove it.'
      );
      expect(onUpdate).not.toHaveBeenCalled();

      const buttons = removeButtons(notice!);
      expect(buttons).toHaveLength(1);
      await act(async () => {
        buttons[0]!.click();
      });
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith({ relayLegOverrides: [] });
    });

    it('drops the notice once the override is gone', async () => {
      await render(tied, [], vi.fn());
      expect(container.querySelector('[data-testid="ambiguous-relay-overrides"]')).toBeNull();
    });
  });
});
