// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import type { ScorerTagStateMessage } from '../apps/extension/src/shared/panelProtocol';

type CutTag = NonNullable<ScorerTagStateMessage['cutTags']>[number];

function panelFixture() {
  const win = new HappyWindow(); let closed: unknown = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function(init) { const result = attach.call(this, init); closed = result; return result; };
  const table = win.document.createElement('table'); win.document.body.append(table);
  const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
  return { panel, root: () => closed as ShadowRoot };
}

const state = (cutTags: CutTag[]): ScorerTagStateMessage => ({
  kind: 'scorer-tag-state', meetKey: 'cut-layout', teams: [{ id: '1', name: 'Sharks' }],
  swimmers: [{ id: 's1', teamId: '1', name: 'Swimmer', gender: 'Men' }], tags: [], warnings: [], cutTags,
});

const lineOf = (row: Element, label: string): Element | undefined =>
  [...row.querySelectorAll('.cut-line')].find((line) => line.querySelector('.cut-label')?.textContent === `${label}: `);

describe('page panel cut-tag cards', () => {
  it('shows each swimmer as a card with a name line and labelled Real SCY and Estimated LCM lines', () => {
    const fixture = panelFixture();
    fixture.panel.setScorerState(state([
      { teamId: '1', teamName: 'Sharks', swimmerId: 's1', swimmerName: 'Swimmer 148001 (name not loaded)', eventKey: '100 Freestyle',
        real: 'Unknown: No published qualifying table is held for NCAA D2 2025-2026.', estimated: 'No converted LCM swim', estimatedIsEstimate: false },
      { teamId: '1', teamName: 'Sharks', swimmerId: 's2', swimmerName: 'Ada', eventKey: '100 Freestyle',
        real: 'B achieved', estimated: '48.12 · A achieved', estimatedIsEstimate: true, estimatedProvenance: 'Tool-derived: SwimSwam conversion tool' },
    ]));
    const cuts = fixture.root().querySelector('[data-osx-cut-tags]')!;
    const rows = [...cuts.querySelectorAll('[data-osx-cut-row]')];
    expect(rows).toHaveLength(2);
    // The old three-column header is gone: the labels sit on each row, so no value is squeezed into a third of the panel.
    expect(cuts.querySelector('.cut-head')).toBeNull();
    for (const row of rows) {
      expect(row.querySelector('.cut-name')?.textContent).not.toBe('');
      expect(lineOf(row, 'Real SCY'), 'Real SCY line').toBeDefined();
      expect(lineOf(row, 'Estimated LCM'), 'Estimated LCM line').toBeDefined();
    }
    const [bare, estimated] = rows as [Element, Element];
    expect(bare.querySelector('.cut-name')?.textContent).toBe('Swimmer 148001 (name not loaded)');
    expect(lineOf(bare, 'Real SCY')?.querySelector('.cut-tag')?.textContent).toBe('Unknown: No published qualifying table is held for NCAA D2 2025-2026.');
    expect(lineOf(bare, 'Estimated LCM')?.querySelector('.cut-tag')?.textContent).toBe('No converted LCM swim');
    expect(bare.querySelector('.cut-badge'), 'no est. badge without an estimate').toBeNull();
    expect(lineOf(estimated, 'Real SCY')?.querySelector('.cut-tag')?.textContent).toBe('B achieved');
    const estimatedLine = lineOf(estimated, 'Estimated LCM')!;
    expect(estimatedLine.querySelector('.cut-tag')?.textContent).toBe('48.12 · A achieved');
    expect(estimatedLine.querySelector('.cut-badge')?.textContent).toBe('est.');
    expect(estimatedLine.querySelector('.cut-note')?.textContent).toBe('Tool-derived: SwimSwam conversion tool');
    fixture.panel.disconnect();
  });

  it('keeps the card styles on the panel tokens, with no hard-coded colour', () => {
    const fixture = panelFixture();
    const css = [...fixture.root().querySelectorAll('style')].map((s) => s.textContent ?? '').join('');
    const cutRules = css.slice(css.indexOf('.cut-row'));
    expect(cutRules).toContain('.cut-badge');
    expect(cutRules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    fixture.panel.disconnect();
  });
});
