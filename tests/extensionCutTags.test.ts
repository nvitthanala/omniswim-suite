import { describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { swimmerLabel, teamLabel } from '../apps/extension/src/shared/names';
import { panelCutTags, panelCutTagsForModel } from '../apps/extension/src/dashboard/scorerTagScoring';
import { builtinLcmToScy, scyStatementFor } from '@omniswim/engine';
import type { MeetModel } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import type { ScorerTagStateMessage } from '../apps/extension/src/shared/panelProtocol';
import { buildSnapshot } from './helpers/simulatorFixtures';

function panelFixture() {
  const win = new HappyWindow(); let closed: unknown = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function(init) { const result = attach.call(this, init); closed = result; return result; };
  const table = win.document.createElement('table'); win.document.body.append(table);
  const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
  return { win, panel, root: () => closed as ShadowRoot };
}

const state = (cutTags: NonNullable<ScorerTagStateMessage['cutTags']>): ScorerTagStateMessage => ({
  kind: 'scorer-tag-state', meetKey: 'cut-test', teams: [{ id: '1', name: 'Sharks' }],
  swimmers: [{ id: 's1', teamId: '1', name: 'Swimmer', gender: 'Men' }], tags: [], warnings: [], cutTags,
});

describe('extension cut tags', () => {
  it('shows real and estimated tags side by side with an est. badge and tool-derived label', () => {
    const fixture = panelFixture();
    fixture.panel.setScorerState(state([{ teamId: '1', teamName: 'Sharks', swimmerId: 's1', swimmerName: 'Swimmer', eventKey: '100 Freestyle',
      real: 'B achieved', estimated: '48.12 · A achieved', estimatedIsEstimate: true, estimatedProvenance: 'Tool-derived: SwimSwam conversion tool' }]));
    const cuts = fixture.root().querySelector('[data-osx-cut-tags]')!;
    expect(cuts.textContent).toContain('B achieved');
    expect(cuts.textContent).toContain('A achieved');
    expect(cuts.textContent).toContain('est.');
    expect(cuts.textContent).toContain('Tool-derived: SwimSwam conversion tool');
    expect(cuts.textContent).not.toContain('published');
    expect(cuts.querySelector('img')).toBeNull();
    fixture.panel.disconnect();
  });

  it('renders unknown reasons, genuine no-cut results, and missing conversions distinctly', () => {
    const fixture = panelFixture();
    fixture.panel.setScorerState(state([
      { teamId: '1', teamName: 'Sharks', swimmerId: 's1', swimmerName: 'Unknown division', eventKey: '50 Freestyle', real: 'Unknown: division is unmapped', estimated: 'No converted LCM swim', estimatedIsEstimate: false },
      { teamId: '1', teamName: 'Sharks', swimmerId: 's1', swimmerName: 'Unsponsored', eventKey: '100 Freestyle', real: 'Unknown: gender is not sponsored', estimated: 'No converted LCM swim', estimatedIsEstimate: false },
      { teamId: '1', teamName: 'Sharks', swimmerId: 's1', swimmerName: 'Discontinued', eventKey: '200 Freestyle', real: 'Unknown: program discontinued', estimated: 'No converted LCM swim', estimatedIsEstimate: false },
      { teamId: '1', teamName: 'Sharks', swimmerId: 's1', swimmerName: 'No cut', eventKey: '500 Freestyle', real: 'No cut achieved', estimated: 'No converted LCM swim', estimatedIsEstimate: false },
    ]));
    const cuts = fixture.root().querySelector('[data-osx-cut-tags]')!;
    expect(cuts.textContent).toContain('Unknown: division is unmapped');
    expect(cuts.textContent).toContain('Unknown: gender is not sponsored');
    expect(cuts.textContent).toContain('Unknown: program discontinued');
    expect(cuts.textContent).toContain('No cut achieved');
    expect(cuts.textContent).toContain('No converted LCM swim');
    fixture.panel.disconnect();
  });

  it('does not invent an estimate for SCY-only simulator swims', () => {
    const { snapshot } = buildSnapshot('A');
    const rows = panelCutTags(snapshot, 'cut-test', 1);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.estimated === 'No converted LCM swim')).toBe(true);
  });

  it('folds separate recorded SCY and tool-converted LCM tags side by side', () => {
    const { snapshot } = buildSnapshot('A');
    const outcome = adaptSimulatorSnapshot(snapshot, { meetKey: 'cut-test', snapshotId: 'fixture' });
    if (outcome.kind !== 'ready') throw new Error('not ready');
    const source = outcome.adapted.model.swims.find((swim) => swim.eventKey === '100 Freestyle');
    if (!source) throw new Error('fixture has no 100 Freestyle swim');
    const swimmer = outcome.adapted.model.swimmers.find((s) => s.swimmerId === source.swimmerId)!;
    const team = outcome.adapted.model.teams.find((t) => t.teamId === swimmer.teamId)!;
    const division = { state: 'known' as const, division: 'D1' as const, season: '2026-2027' };
    const realSwim = { ...source, recordedTime: { text: '43.00', hundredths: 4300 } };
    const lcmSwim = { ...source, swimId: `${source.swimId}:lcm`, recordedCourse: 'LCM' as const,
      recordedTime: { text: '40.00', hundredths: 4000 } };
    const lcmPreset = builtinLcmToScy('lcm-scy-swimswam', 1);
    if (!lcmPreset) throw new Error('built-in LCM converter is missing');
    const converted = scyStatementFor(lcmSwim, null, division, swimmer.gender, { includeConvertedSwims: true, lcmToScy: lcmPreset });
    const model = { ...outcome.adapted.model, teams: outcome.adapted.model.teams.map((t) => t.teamId === team.teamId ? { ...t, division } : t),
      swims: [...outcome.adapted.model.swims.filter((swim) => swim.swimId !== source.swimId), realSwim, { ...lcmSwim, scy: converted }] } as MeetModel;
    const row = panelCutTagsForModel(model, undefined, 1).find((item) => item.swimmerId === source.swimmerId && item.eventKey === source.eventKey);
    expect(row?.real).toBe('No cut achieved');
    expect(row?.estimatedIsEstimate).toBe(true);
    expect(row?.estimated).toContain('achieved');
    expect(row?.estimatedProvenance).toContain('Tool-derived');
    expect(row?.estimatedProvenance).not.toContain('published');
  });

  it('keeps an LCM time with no converter row unknown and does not badge it as an estimate', () => {
    const { snapshot } = buildSnapshot('A');
    const outcome = adaptSimulatorSnapshot(snapshot, { meetKey: 'cut-test', snapshotId: 'fixture' });
    if (outcome.kind !== 'ready') throw new Error('not ready');
    const source = outcome.adapted.model.swims.find((swim) => swim.eventKey === '100 Freestyle');
    if (!source) throw new Error('fixture has no swim');
    const swimmer = outcome.adapted.model.swimmers.find((s) => s.swimmerId === source.swimmerId)!;
    const team = outcome.adapted.model.teams.find((t) => t.teamId === swimmer.teamId)!;
    const division = { state: 'known' as const, division: 'D1' as const, season: '2026-2027' };
    const lcmSwim = { ...source, swimId: `${source.swimId}:lcm-no-row`, eventKey: '100 Individual Medley', recordedCourse: 'LCM' as const,
      recordedTime: { text: '40.00', hundredths: 4000 } };
    const lcmPreset = builtinLcmToScy('lcm-scy-swimswam', 1);
    if (!lcmPreset) throw new Error('built-in LCM converter is missing');
    const statement = scyStatementFor(lcmSwim, null, division, swimmer.gender, { includeConvertedSwims: true, lcmToScy: lcmPreset });
    const model = { ...outcome.adapted.model, teams: outcome.adapted.model.teams.map((t) => t.teamId === team.teamId ? { ...t, division } : t),
      swims: [...outcome.adapted.model.swims.filter((swim) => swim.swimId !== source.swimId), { ...lcmSwim, scy: statement }] } as MeetModel;
    const row = panelCutTagsForModel(model, undefined, 1).find((item) => item.swimmerId === source.swimmerId && item.eventKey === lcmSwim.eventKey);
    expect(statement).toMatchObject({ kind: 'not-convertible', reason: 'no_conversion_available' });
    expect(row?.estimated).toContain('Unknown:');
    expect(row?.estimated).toContain('no_conversion_available');
    expect(row?.estimatedIsEstimate).toBe(false);
  });

  it('says a name is not loaded instead of showing a bare id as the name', () => {
    const { snapshot } = buildSnapshot('A');
    const outcome = adaptSimulatorSnapshot(snapshot, { meetKey: 'cut-test', snapshotId: 'fixture' });
    if (outcome.kind !== 'ready') throw new Error('not ready');
    const model = outcome.adapted.model;
    const named = panelCutTagsForModel(model, undefined, 1);
    expect(named.length).toBeGreaterThan(0);
    // With the names present the rows carry them, unchanged.
    expect(named.every((r) => !/name not loaded/.test(r.swimmerName) && !/name not loaded/.test(r.teamName))).toBe(true);
    // With the display data gone, each row says the name is absent and keeps the id.
    const { display: _display, ...bare } = model;
    const rows = panelCutTagsForModel(bare as MeetModel, undefined, 1);
    expect(rows.length).toBe(named.length);
    for (const row of rows) {
      expect(row.swimmerName).toBe(`Swimmer ${row.swimmerId} (name not loaded)`);
      expect(row.teamName).toBe(`Team ${row.teamId} (name not loaded)`);
    }
    // A blank name counts as absent.
    expect(swimmerLabel('148001', '  ')).toBe('Swimmer 148001 (name not loaded)');
    expect(teamLabel('58', undefined)).toBe('Team 58 (name not loaded)');
    expect(teamLabel('58', 'Henderson State University')).toBe('Henderson State University');
  });
});

