import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { optimalColumns } from '../apps/extension/src/worker/optimizerResult';
import { suggestOpponentRosters, suggestedTags } from '../apps/extension/src/dashboard/suggestedRosters';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import type { ScorerTagStateMessage } from '../apps/extension/src/shared/panelProtocol';
import { Window as HappyWindow } from 'happy-dom';
import { builtinRulePreset } from '@omniswim/engine';
import { createStorageRepo, InvalidRecordError, openOmniDb, readScorerRulePreset, saveScorerRulePreset } from '../apps/extension/src/storage';
import { freshFactory } from './helpers/extensionDb';
import type { PresetRef } from '../apps/extension/src/storage/schema';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { scoreScorerTags } from '../apps/extension/src/dashboard/scorerTagScoring';
import loadHighs from 'highs';

describe('extension suggested rosters', () => {
  let highsPromise: ReturnType<typeof loadHighs> | undefined;
  let measuredSolveMs = 0;
  let measuredSolveCalls = 0;
  const realSolve = async (lp: string, options: Readonly<Record<string, string | number | boolean>>) => {
    highsPromise ??= loadHighs({});
    const highs = await highsPromise;
    const start = performance.now();
    const result = highs.solve(lp, options as Parameters<typeof highs.solve>[1]);
    measuredSolveMs += performance.now() - start;
    measuredSolveCalls += 1;
    const columns: Record<string, number> = {};
    if (result.Status === 'Optimal') for (const [name, col] of Object.entries(result.Columns)) columns[name] = col.Primal;
    return { status: result.Status, objective: result.ObjectiveValue, columns };
  };
  it('does not read HiGHS columns for infeasible or other non-optimal statuses', () => {
    const unread = () => { throw new Error('columns accessed'); };
    expect(optimalColumns('Infeasible', unread)).toEqual({});
    expect(optimalColumns('Time limit reached', unread)).toEqual({});
  });

  it('waits for own team selection; keeps a coach pin as input and recomputes from changed tags', async () => {
    const snapshot = buildSnapshot('A').snapshot;
    const own = String(snapshot.teams[0]!.id);
    const opponent = String(snapshot.teams.find(t => String(t.id) !== own)!.id);
    const rules = builtinRulePreset('nsisc', 4)!;
    const solve = realSolve;
    expect(await suggestOpponentRosters(snapshot, 'fixture-A', undefined, [], rules, solve)).toEqual([]);
    const swimmer = snapshot.swimmers!.find(s => String(s.teamId) === opponent)!;
    const pin = { teamId: opponent, swimmerId: String(swimmer.id), role: 'scorer' as const };
    const ownPins = snapshot.swimmers!.filter(s => String(s.teamId) === own).map(s => ({ teamId: own, swimmerId: String(s.id), role: 'scorer' as const }));
    measuredSolveMs = 0; measuredSolveCalls = 0;
    const first = await suggestOpponentRosters(snapshot, 'fixture-A', own, [...ownPins, pin], rules, solve);
    console.info(`fixture A optimizer solve time: ${measuredSolveMs.toFixed(2)} ms across ${measuredSolveCalls} HiGHS calls`);
    const second = await suggestOpponentRosters(snapshot, 'fixture-A', own, [...ownPins, { ...pin, role: 'non-scorer' }], rules, solve);
    expect(first.length).toBeGreaterThan(0);
    expect(first.map(x => x.teamId)).toContain(opponent);
    expect(first.every(x => x.result.kind === 'suggested' || (x.result.kind === 'absent' && x.result.reason === 'solver_not_optimal'))).toBe(true);
    const pinnedSuggestion = first.find(x => x.teamId === opponent)?.result;
    expect(pinnedSuggestion?.kind).toBe('suggested');
    if (pinnedSuggestion?.kind === 'suggested') {
      expect(pinnedSuggestion.swimmerIds.length).toBeGreaterThan(0);
      expect(pinnedSuggestion.swimmerIds).not.toContain(String(swimmer.id));
    }
    expect(second).not.toBe(first);
    expect(JSON.stringify(second.map(x => x.result))).not.toBe(JSON.stringify(first.map(x => x.result)));
  });

  it('persists the selected rule preset across a storage reload', async () => {
    const factory = freshFactory();
    const db = await openOmniDb({ factory });
    const repo = createStorageRepo(db);
    const ref: PresetRef = { kind: 'builtin', id: 'nsisc', version: 4 };
    await saveScorerRulePreset(repo, 'fixture-A', ref);
    db.close();
    const reopened = await openOmniDb({ factory });
    expect(await readScorerRulePreset(createStorageRepo(reopened), 'fixture-A')).toEqual(ref);
    reopened.close();
  });

  it('scores scorer tags under the selected rules and visibly refuses simulator points_pool suggestions', async () => {
    const snapshot = buildSnapshot('A').snapshot;
    const own = String(snapshot.teams[0]!.id);
    const selected = builtinRulePreset('nsisc', 4)!;
    const scored = scoreScorerTags(snapshot, 'fixture-A', true, snapshot.swimmers!.map(s => ({ teamId: String(s.teamId), swimmerId: String(s.id), role: 'scorer' as const })), selected);
    expect(scored.scored).toBe(true);
    const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'fixture-A', snapshotId: 'live-snapshot' });
    expect(adapted.kind).toBe('ready');
    if (adapted.kind !== 'ready') return;
    const ownPins = snapshot.swimmers!.filter(s => String(s.teamId) === own).map(s => ({ teamId: own, swimmerId: String(s.id), role: 'scorer' as const }));
    const refused = await suggestOpponentRosters(snapshot, 'fixture-A', own, ownPins, adapted.adapted.preset.preset, async () => ({ status: 'Optimal', objective: 0, columns: {} }));
    expect(refused.every(item => item.result.kind === 'error' && item.result.code === 'suggest_rule_unsupported')).toBe(true);
    expect(refused.some(item => item.result.kind === 'error' && item.result.subject === 'scorers.eligibility')).toBe(true);
    const win = new HappyWindow(); let shadow: unknown = null;
    const original = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const result = original.call(this, init); shadow = result; return result; };
    const table = win.document.createElement('table'); win.document.body.append(table);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    panel.setScorerState({ kind: 'scorer-tag-state', meetKey: 'fixture-A', teams: snapshot.teams.map(t => ({ id: String(t.id), name: t.name })),
      swimmers: snapshot.swimmers!.map(s => ({ id: String(s.id), teamId: String(s.teamId), name: String(s.name ?? s.id), gender: String(s.gender) })),
      tags: [], ownTeamId: own, rulePresetRef: { kind: 'builtin', id: 'nsisc', version: 4 }, warnings: [],
      suggestions: refused.map(s => ({ teamId: s.teamId, gender: s.gender, result: s.result })) });
    expect((shadow as ShadowRoot | null)?.textContent).toContain('suggest_rule_unsupported');
    panel.disconnect();
  });

  it('keeps suggested tags separate from stored coach tags', async () => {
    const ephemeral = suggestedTags([{ teamId: '2', gender: 'Men', result: { kind: 'suggested', swimmerIds: ['9'], points: 10,
      spots: { numerator: 1, denominator: 1 }, method: 'ilp' } }]);
    expect(ephemeral).toEqual([{ teamId: '2', swimmerId: '9', role: 'scorer', source: 'suggested' }]);
    const db = await openOmniDb({ factory: freshFactory() });
    const repo = createStorageRepo(db);
    await expect(repo.put('tags', { meetKey: 'm', teamId: '2' as never, swimmerId: '9' as never, role: 'scorer', source: 'suggested' } as never, 'new')).rejects.toBeInstanceOf(InvalidRecordError);
    db.close();
  });

  it('shows suggestions, absent reasons, errors, and unsupported rule codes visibly', () => {
    const win = new HappyWindow(); let shadow: unknown = null;
    const original = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const result = original.call(this, init); shadow = result; return result; };
    const table = win.document.createElement('table'); win.document.body.append(table);
    const state: ScorerTagStateMessage = { kind: 'scorer-tag-state', meetKey: 'm', teams: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
      swimmers: [{ id: '21', teamId: '2', name: 'Swimmer B', gender: 'Men' }], tags: [], ownTeamId: '1',
      rulePresetRef: { kind: 'builtin', id: 'nsisc', version: 4 }, rulePresetChoices: [{ ref: { kind: 'builtin', id: 'nsisc', version: 4 }, label: 'NSISC v4' }], warnings: [], suggestions: [
        { teamId: '2', gender: 'Men', result: { kind: 'suggested', swimmerIds: ['21'], points: 12, spots: { numerator: 1, denominator: 1 }, method: 'ilp' } },
        { teamId: '2', gender: 'Women', result: { kind: 'absent', reason: 'solver_not_optimal' } },
        { teamId: '2', gender: 'Open', result: { kind: 'error', code: 'suggest_rule_unsupported', subject: 'scoring.ties' } },
      ] };
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    panel.setScorerState(state);
    expect((shadow as ShadowRoot | null)?.textContent).toContain('Suggested: Swimmer B · 12 points · 1/1 spots · ilp');
    expect((shadow as ShadowRoot | null)?.textContent).toContain('solver_not_optimal');
    expect((shadow as ShadowRoot | null)?.textContent).toContain('suggest_rule_unsupported');
    panel.disconnect();
    const noPreset = new HappyWindow(); let noPresetShadow: unknown = null;
    const attachShadow = noPreset.HTMLElement.prototype.attachShadow;
    noPreset.HTMLElement.prototype.attachShadow = function(init) { const result = attachShadow.call(this, init); noPresetShadow = result; return result; };
    const secondTable = noPreset.document.createElement('table'); noPreset.document.body.append(secondTable);
    const waitingPanel = mountPagePanel(noPreset.document as unknown as Document, () => ({ parity: null }), 'table');
    waitingPanel.setScorerState({ ...state, rulePresetRef: undefined });
    expect((noPresetShadow as ShadowRoot | null)?.textContent).toContain('Choose an OmniSwim rule preset');
    waitingPanel.disconnect();
  });
});
