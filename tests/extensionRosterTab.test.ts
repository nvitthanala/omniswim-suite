// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Rosters tab (F1.1a), rendered in happy-dom against a real store (fake-indexeddb) and the real run flow. The fake "overlay" is the test:
 * it reads the `fetch-run` the tab posts and answers with `fetch-item` and `fetch-end` messages.
 *
 * SYNTHETIC data: the meet is the recorded config B with its sanitized swimmer ids turned numeric by the D7 rule (`T58-S04` -> `95804`), so
 * ids pass the SwimCloud id check. The season list is the synthetic ten-season list of the wiring tests. The pages are the committed REAL
 * roster captures (2025-2026). The stored 2026-2027 roster used for the class-year rows is SYNTHETIC, built from those numeric ids.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { simSnapshotSchema, parseSeasonChoices } from '../apps/extension/src/shared/bridgeSchema';
import type { SimSnapshot } from '../apps/extension/src/shared/bridgeSchema';
import { parseFetchEnd, parseFetchItem } from '../apps/extension/src/shared/panelProtocol';
import { fetchPathFor } from '../apps/extension/src/shared/fetchProtocol';
import type { RosterTarget } from '../apps/extension/src/shared/fetchProtocol';
import { RosterTab } from '../apps/extension/src/dashboard/rosterTab';
import { createRosterFlow } from '../apps/extension/src/dashboard/rosterFlow';
import type { RosterFlow } from '../apps/extension/src/dashboard/rosterFlow';
import { createStorageRepo, openOmniDb, toSwimCloudId } from '../apps/extension/src/storage';
import type { StorageRepo } from '../apps/extension/src/storage';
import { saveFetchPosture } from '../apps/extension/src/dashboard/settingsStore';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { freshFactory, sequentialIds, steppingClock } from './helpers/extensionDb';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AT = '2026-11-06T00:00:00.000Z';
const M58 = readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'swimcloud-real-team-roster-58-gender-m.html'), 'utf8');
const SEASON_ROWS = Array.from({ length: 10 }, (_, i) => {
  const y = 2017 + i;
  return { seasonId: 21 + i, label: `${y}-${y + 1}`, startDate: `${y}-09-01`, endDate: `${y + 1}-08-31`, isCurrent: i === 9 };
});
const seasons = (() => { const p = parseSeasonChoices(SEASON_ROWS); if (!p.ok) throw new Error(p.reason); return p; })();

const numeric = (): SimSnapshot => simSnapshotSchema.parse(JSON.parse(JSON.stringify(buildSnapshot('B').snapshot).replace(/T(\d+)-S(\d+)/g, '9$1$2')));
const snapshot = numeric();
const ids58 = (snapshot.swimmers ?? []).filter((s) => String(s.teamId) === '58').map((s) => String(s.id));

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(() => { if (root) act(() => root!.unmount()); root = null; container?.remove(); container = null; });

async function mount(opts: { posture?: 'on-click'; withSeasons?: boolean; seed?: (repo: StorageRepo) => Promise<void> } = {}) {
  const db = await openOmniDb({ factory: freshFactory(), now: steppingClock(), newId: sequentialIds('install') });
  const repo = createStorageRepo(db, { now: steppingClock() });
  if (opts.posture) await saveFetchPosture(repo, opts.posture);
  await opts.seed?.(repo);
  const posted: { kind: string; runId: string; targets?: readonly RosterTarget[] }[] = [];
  let n = 0;
  const flow: RosterFlow = createRosterFlow({ post: (m) => void posted.push(m as never), newRunId: () => `run-${++n}`, repo: async () => repo });
  if (opts.withSeasons !== false) flow.setSeasons(seasons);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(React.createElement(RosterTab, { snapshot, flow, repoForMeet: async () => repo, active: true })); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const q = <T extends Element = HTMLElement>(id: string): T | null => container!.querySelector<T>(`[data-testid="${id}"]`);
  const settle = async (): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, 40)); }); };
  /** Wait, inside act, until the check passes: the store answers on its own schedule. */
  const until = (check: () => void): Promise<void> => vi.waitFor(async () => { await act(async () => { await new Promise((r) => setTimeout(r, 15)); }); check(); }, { timeout: 4000, interval: 10 });
  return { repo, flow, posted, q, settle, until };
}

describe('the Rosters tab', () => {
  it('posture off: Fetch is disabled, a reason is shown, and a click posts nothing', async () => {
    const t = await mount();
    const button = t.q<HTMLButtonElement>('roster-fetch')!;
    expect(button.disabled).toBe(true);
    expect(t.q('roster-posture-off')?.textContent).toMatch(/Fetching is off/);
    await act(async () => { button.click(); });
    expect(t.posted).toEqual([]);
    expect(t.flow.client.state()).toEqual({ phase: 'idle' });
  });

  it('the tab says plainly that roster membership is applied to Score, Build, Plan and scorer tags nowhere', async () => {
    const t = await mount({ posture: 'on-click' });
    const text = t.q('roster-not-applied')!.textContent ?? '';
    for (const word of ['preview', 'not applied', 'Score', 'Build', 'Plan', 'scorer tags']) expect(text, word).toContain(word);
    expect(container!.textContent).not.toContain('Score tab is not changed');
  });

  it('turning fetching off while a run is going cancels that run (fetch-cancel for its run id)', async () => {
    const t = await mount({ posture: 'on-click' });
    await act(async () => { t.q<HTMLButtonElement>('roster-fetch')!.click(); });
    const runId = t.posted[0]!.runId;
    expect(t.posted.map((m) => m.kind)).toEqual(['fetch-run']);
    const box = t.q<HTMLInputElement>('roster-posture')!;
    await act(async () => { box.click(); });
    await t.settle();
    expect(t.posted).toEqual([expect.objectContaining({ kind: 'fetch-run' }), { kind: 'fetch-cancel', runId }]);
    expect(t.q<HTMLInputElement>('roster-posture')!.checked).toBe(false);
  });

  it('nothing is posted on load even with posture on; the button names the cost; one click posts one run', async () => {
    const t = await mount({ posture: 'on-click' });
    expect(t.posted).toEqual([]);
    const button = t.q<HTMLButtonElement>('roster-fetch')!;
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Fetch rosters (3 requests, about 6 s)');
    await act(async () => { button.click(); });
    expect(t.posted).toHaveLength(1);
    expect(t.posted[0]!.kind).toBe('fetch-run');
    expect(t.posted[0]!.targets!.map((x) => fetchPathFor(x))).toEqual(['/team/58/roster/?gender=M', '/team/48/roster/?gender=M', '/team/412/roster/?gender=M']);
    expect(t.q<HTMLButtonElement>('roster-fetch')!.disabled).toBe(true); // a run is going
    await act(async () => { t.q<HTMLButtonElement>('roster-fetch')!.click(); });
    expect(t.posted).toHaveLength(1);
  });

  it('the season select lists "Simulator (current)" and the page\'s seasons; without the list it says so and offers only the default', async () => {
    const withList = await mount({ posture: 'on-click' });
    const options = [...withList.q<HTMLSelectElement>('roster-season')!.options].map((o) => o.textContent);
    expect(options[0]).toBe('Simulator (current)');
    expect(options).toContain('2025-2026');
    expect(options).toContain('2026-2027 (current)');
    expect(options).toHaveLength(11);
    expect(withList.q('roster-no-seasons')).toBeNull();
    act(() => root!.unmount()); container!.remove(); root = null;
    const without = await mount({ posture: 'on-click', withSeasons: false });
    expect([...without.q<HTMLSelectElement>('roster-season')!.options].map((o) => o.textContent)).toEqual(['Simulator (current)']);
    expect(without.q('roster-no-seasons')).not.toBeNull();
    expect(without.q('roster-no-label')).not.toBeNull();
  });

  it('a finished run is saved: the team shows its count; a refused page shows its reason and "the earlier roster is kept"', async () => {
    const t = await mount({ posture: 'on-click' });
    await act(async () => { t.q<HTMLButtonElement>('roster-fetch')!.click(); });
    const { runId, targets } = { runId: t.posted[0]!.runId, targets: t.posted[0]!.targets! };
    // The current page of team 58 is answered with the real 2025-2026 page. The list says the current season is 2026-2027, so it must be refused.
    for (const [i, target] of targets.entries()) {
      const p = fetchPathFor(target);
      t.flow.handle(parseFetchItem({ kind: 'fetch-item', runId, index: i, path: p, finalPath: p, contentType: 'text/html', body: M58, fetchedAt: AT })!);
    }
    t.flow.handle(parseFetchEnd({ kind: 'fetch-end', runId, delivered: 3, stopped: null })!);
    await t.settle();
    const row = t.q('roster-team-58')!;
    expect(row.textContent).toContain('Refused (season-mismatch)');
    expect(row.textContent).toContain('The earlier roster, if any, is kept.');
    expect(row.textContent).toContain('Not loaded');
    expect(t.q('roster-run')!.getAttribute('data-phase')).toBe('finished');
  });

  it('a stopped run shows "Not saved" with the reason, and nothing is stored', async () => {
    const t = await mount({ posture: 'on-click' });
    await act(async () => { t.q<HTMLButtonElement>('roster-fetch')!.click(); });
    const runId = t.posted[0]!.runId;
    t.flow.handle(parseFetchEnd({ kind: 'fetch-end', runId, delivered: 0, stopped: { reason: 'challenge', index: 0, status: 200, detail: 'Just a moment' } })!);
    await t.settle();
    expect(t.q('roster-run')!.textContent).toMatch(/Not saved: .*challenge/);
    expect(await t.repo.list('rosters')).toEqual([]);
  });

  it('class years: SwimCloud\'s value shows with its source, "?" for an absent one, and an override shows as "you" (SYNTHETIC stored 2026-2027 roster)', async () => {
    const [a, b, c] = ids58;
    const t = await mount({
      posture: 'on-click',
      seed: async (repo) => {
        await repo.putCache('rosters', {
          teamId: toSwimCloudId('58'), seasonId: '2026-2027', gender: 'Men', memberIds: ids58.map(toSwimCloudId), classYears: { [a!]: 'SR', [b!]: 'FR' },
          sourceUrl: 'https://www.swimcloud.com/team/58/roster/?gender=M', fetchedAt: AT, parser: { name: 'readRosterFetch', confidence: 'real-capture-verified' },
        });
      },
    });
    const text = (id: string): string[] => [...t.q(`roster-row-${id}`)!.querySelectorAll('td')].map((td) => td.textContent ?? '');
    expect(text(a!).slice(1, 3)).toEqual(['SR', 'SwimCloud']);
    expect(text(b!).slice(1, 3)).toEqual(['FR', 'SwimCloud']);
    expect(text(c!).slice(1, 3)).toEqual(['?', '?']);
    expect(t.q('roster-team-58')!.textContent).toContain(`${ids58.length} swimmers`);
    // The coach sets the third swimmer's class year. It is stored for the season, and an override beats SwimCloud's value.
    const select = t.q<HTMLSelectElement>(`roster-override-${c}`)!;
    expect(select.disabled).toBe(false);
    await act(async () => { select.value = 'GR'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await t.until(() => expect(text(c!).slice(1, 3)).toEqual(['GR', 'you']));
    const stored = await t.repo.get('classYearOverrides', [toSwimCloudId(c!), '2026-2027']);
    expect(stored.found && stored.value.classYear).toBe('GR');
    const sel2 = t.q<HTMLSelectElement>(`roster-override-${a}`)!;
    await act(async () => { sel2.value = 'JR'; sel2.dispatchEvent(new Event('change', { bubbles: true })); });
    await t.until(() => expect(text(a!).slice(1, 3)).toEqual(['JR', 'you'])); // the override beats SwimCloud's SR
    await act(async () => { sel2.value = ''; sel2.dispatchEvent(new Event('change', { bubbles: true })); });
    await t.until(() => expect(text(a!).slice(1, 3)).toEqual(['SR', 'SwimCloud'])); // clearing it brings SwimCloud's value back
  });

  it('with no season label known, the override dropdown is disabled with a reason and no class year is guessed', async () => {
    const t = await mount({ posture: 'on-click', withSeasons: false });
    expect(t.q('roster-no-label')).not.toBeNull();
    const select = t.q<HTMLSelectElement>(`roster-override-${ids58[0]}`)!;
    expect(select.disabled).toBe(true);
    expect(select.title).toMatch(/not known/);
    expect(t.q(`roster-row-${ids58[0]}`)!.textContent).toContain('?');
  });

  it('membership "?" badge for a season whose roster is not loaded', async () => {
    const t = await mount({ posture: 'on-click' });
    const select = t.q<HTMLSelectElement>('roster-season')!;
    await act(async () => { select.value = '2025-2026'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await t.settle();
    expect(t.q('roster-fetch')!.textContent).toBe('Fetch rosters (6 requests, about 15 s)');
    const row = t.q(`roster-row-${ids58[0]}`)!;
    expect(row.querySelector('[aria-label="roster membership unknown"]')).not.toBeNull();
  });
});
