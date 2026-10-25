// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F4: the "Scout a team" panel past its loading state. The capture list and the capture parse come from
 * the committed real fixtures (`tests/fixtures/theoretical-meet/`); our side is the real NSISC meet rows
 * of Henderson State, scored by the app's own engine. Written without JSX.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemSwimCloudCaptureStore } from '../../packages/swimcloud/src/captureStore';
import { parseSwimCloudCapture } from '../apps/shell/lib/swimcloudCaptureRoutes';
import { Gender } from '../../packages/core/src/types';
import type { SwimmerResult, Workspace } from '../../packages/core/src/types';
import { mergeScoringSettings } from '../../packages/core/src/lib/scoringDefaults';
import { buildScoringSnapshot } from '../../packages/core/src/lib/scoringEngine';
import ScoutOpponentPanel from '../packages/manager/src/components/ScoutOpponentPanel';
import type { CaptureApi } from '../packages/manager/src/components/theoreticalMeet/captureApi';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../../tests/fixtures');
const US = 'Henderson State University';

function captureApi(): CaptureApi {
  const store = new FileSystemSwimCloudCaptureStore(join(FIXTURES, 'theoretical-meet'));
  return {
    listCaptures: async () => store.listCaptures() as never,
    parseCapture: async captureId => {
      const record = await store.getCapture(captureId);
      if (record === undefined) throw new Error(`no capture ${captureId}`);
      return parseSwimCloudCapture(store, record);
    },
  };
}

function ourWorkspace(): Workspace {
  const file = JSON.parse(readFileSync(join(FIXTURES, 'nsisc-2026-relay-followups-r1.json'), 'utf8')) as {
    menResults: SwimmerResult[];
    womenResults: SwimmerResult[];
  };
  return { id: 'w', name: 'NSISC fixture', menResults: file.menResults, womenResults: file.womenResults, recruits: [], createdAt: 0, conference: 'NSISC' } as Workspace;
}

async function settle(until: () => boolean, container: HTMLElement): Promise<void> {
  for (let i = 0; i < 100 && !until(); i += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 25));
    });
  }
  expect(until(), container.textContent ?? '').toBe(true);
}

function choose(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('no select value setter');
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Scout a team panel, loaded', () => {
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

  it('lists the crawled teams, scouts Ouachita Baptist and shows where we lead and trail', async () => {
    const workspace = ourWorkspace();
    const scoredRows = buildScoringSnapshot(workspace, Gender.MEN, false).projected.allScored;
    const scoringSettings = mergeScoringSettings(workspace.scoringSettings, { conference: workspace.conference });

    await act(async () => {
      root.render(
        createElement(ScoutOpponentPanel, { workspace, gender: Gender.MEN, team: US, scoredRows, scoringSettings, captureApi: captureApi() })
      );
    });
    await settle(() => container.querySelector('select') !== null, container);

    // The fixture records carry no school name, so the picker says so for every team.
    const teamSelect = container.querySelector('select') as HTMLSelectElement;
    const labels = [...teamSelect.options].map(o => o.textContent);
    expect(labels).toContain('Team 412 (school name not recorded)');
    expect(labels).toContain('Team 58 (school name not recorded)');

    await act(async () => {
      choose(teamSelect, '412');
    });
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Scout this team');
    expect(button, 'the scout button').toBeDefined();
    expect((button as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      (button as HTMLButtonElement).click();
    });
    await settle(() => (container.textContent ?? '').includes('Where you lead'), container);

    const text = container.textContent ?? '';
    expect(text).toContain('Where you trail');
    expect(text).toContain('Swing events');
    expect(text).toContain('Ouachita Baptist University');
    expect(text).toContain('Relays are not scouted');
    expect(text).toContain('Relays and diving are not included.');
    expect(text).toContain('Seeds are all-time bests');
    expect(text).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('refuses your own crawl after the load, in plain words', async () => {
    const workspace = ourWorkspace();
    const scoredRows = buildScoringSnapshot(workspace, Gender.MEN, false).projected.allScored;
    const scoringSettings = mergeScoringSettings(workspace.scoringSettings, { conference: workspace.conference });
    await act(async () => {
      root.render(
        createElement(ScoutOpponentPanel, { workspace, gender: Gender.MEN, team: US, scoredRows, scoringSettings, captureApi: captureApi() })
      );
    });
    await settle(() => container.querySelector('select') !== null, container);
    await act(async () => {
      choose(container.querySelector('select') as HTMLSelectElement, '58');
    });
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Scout this team') as HTMLButtonElement;
    await act(async () => {
      button.click();
    });
    await settle(() => (container.textContent ?? '').includes('your own team'), container);
    expect(container.textContent ?? '').not.toContain('Where you lead');
  });
});
