import { describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import { createStorageRepo } from '../apps/extension/src/storage/repo';
import { openOmniDb } from '../apps/extension/src/storage/open';
import { createMemoryChangeBus, watchChanges } from '../apps/extension/src/storage/changeBus';
import { freshFactory, steppingClock, sequentialIds } from './helpers/extensionDb';
import type { ScorerTagStateMessage } from '../apps/extension/src/shared/panelProtocol';
import { readScorerOwnTeam, saveScorerOwnTeam, toSwimCloudId } from '../apps/extension/src/storage';
import { scoreScorerTags } from '../apps/extension/src/dashboard/scorerTagScoring';
import { buildSnapshot } from './helpers/simulatorFixtures';

function makeWindow(): { win: HappyWindow; root(): ShadowRoot } {
  const win = new HappyWindow(); let closed: unknown = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function(init) { const result = attach.call(this, init); closed = result; return result; };
  return { win, root: () => closed as ShadowRoot };
}

const state = (overrides: Partial<ScorerTagStateMessage> = {}): ScorerTagStateMessage => ({
  kind: 'scorer-tag-state', meetKey: 'meet:1', teams: [{ id: '1', name: 'Sharks' }],
  swimmers: [{ id: '10', teamId: '1', name: 'A Swimmer', gender: 'Men' }], tags: [], warnings: [], ...overrides,
});

describe('extension scorer tags', () => {
  it('asks for the coach team first and distinguishes untagged Auto from non-scorer', () => {
    const fixture = makeWindow(); const win = fixture.win; const sim = win.document.createElement('div'); sim.innerHTML = '<table></table>'; win.document.body.append(sim);
    let current = state(); const sent: unknown[] = [];
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    panel.onScorerAction(action => sent.push(action)); panel.setScorerState(current);
    let root = fixture.root();
    expect(root.textContent).toContain('Choose your team before tagging scorers');
    (root.querySelector('select') as HTMLSelectElement).value = '1';
    root.querySelector('select')?.dispatchEvent(new win.Event('change') as unknown as Event);
    expect(sent).toEqual([{ kind: 'scorer-tag-action', action: 'choose-team', teamId: '1' }]);
    current = state({ ownTeamId: '1', tags: [{ teamId: '1', swimmerId: '10', role: 'non-scorer' }] });
    panel.setScorerState(current); root = fixture.root();
    expect((root.querySelector('[aria-label="A Swimmer scorer role"]') as HTMLSelectElement).value).toBe('non-scorer');
    current = state({ ownTeamId: '1' }); panel.setScorerState(current);
    root = fixture.root();
    expect((root.querySelector('[aria-label="A Swimmer scorer role"]') as HTMLSelectElement).value).toBe('');
    panel.disconnect();
  });

  it('tags, retags, reloads, clears by deleting the record, and notifies a second tab', async () => {
    const factory = freshFactory(); const bus = createMemoryChangeBus();
    const dbA = await openOmniDb({ factory, now: steppingClock(), newId: sequentialIds() });
    const dbB = await openOmniDb({ factory }); const a = createStorageRepo(dbA, { bus }); const b = createStorageRepo(dbB, { bus });
    const changed: number[] = []; const target = { addEventListener() {}, removeEventListener() {} };
    const watch = await watchChanges(dbB, bus, event => changed.push(event.rev), { targets: [target] });
    const key: [string, string, string] = ['meet:1', '1', '10'];
    expect(await a.get('tags', key)).toEqual({ found: false });
    const created = await a.put('tags', { meetKey: key[0], teamId: key[1] as never, swimmerId: key[2] as never, role: 'scorer' }, 'new');
    expect((await b.get('tags', key)).found).toBe(true);
    const retagged = await a.put('tags', { meetKey: key[0], teamId: key[1] as never, swimmerId: key[2] as never, role: 'exhibition' }, created.rev);
    expect((await b.get('tags', key)).found && (await b.get('tags', key) as {found: true; value: {role: string}}).value.role).toBe('exhibition');
    expect(changed.length).toBeGreaterThanOrEqual(2);
    const reopened = await openOmniDb({ factory }); const reload = createStorageRepo(reopened);
    expect((await reload.get('tags', key)).found).toBe(true);
    await reload.delete('tags', key, retagged.rev);
    expect(await reload.get('tags', key)).toEqual({ found: false });
    watch.stop(); dbA.close(); dbB.close(); reopened.close();
  });

  it('reload restores the coach team and runs scoring warnings without choosing again', async () => {
    const factory = freshFactory(); const meetKey = 'simulator-meet-2026-01';
    const db = await openOmniDb({ factory, now: steppingClock(), newId: sequentialIds() });
    const repo = createStorageRepo(db);
    const snapshot = buildSnapshot('A').snapshot;
    const firstTeam = snapshot.teams[0];
    if (!firstTeam) throw new Error('fixture A has no teams');
    const chosenTeam = toSwimCloudId(String(firstTeam.id));
    await saveScorerOwnTeam(repo, meetKey, chosenTeam);
    db.close();

    const reloadedDb = await openOmniDb({ factory }); const reloadedRepo = createStorageRepo(reloadedDb);
    const restored = await readScorerOwnTeam(reloadedRepo, meetKey);
    expect(restored).toBe(chosenTeam);
    const scoring = scoreScorerTags(snapshot, meetKey, restored !== undefined, []);
    expect(scoring.scored).toBe(true);
    reloadedDb.close();
  });

  it('shows database failures and scorer warnings in the in-page panel', () => {
    const fixture = makeWindow(); const win = fixture.win; const table = win.document.createElement('table'); win.document.body.append(table);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    panel.setScorerState(state({ ownTeamId: '1', error: 'Database unavailable', warnings: ['Relay 1, leg 2 is outside the scoring roster', 'Scorer has no entry'] }));
    const root = fixture.root();
    expect(root.querySelector('[data-osx-tag-error]')?.textContent).toBe('Database unavailable');
    expect(root.querySelectorAll('.warning')).toHaveLength(2);
    panel.disconnect();
  });
});
