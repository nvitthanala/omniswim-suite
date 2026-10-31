import { describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';

const compared = { kind: 'compared' as const, matches: true, teams: [], events: [], differingEvents: [] };
function fixture(withAnchor = true) {
  const win = new HappyWindow();
  let closedRoot: unknown = null;
  const attach = win.HTMLElement.prototype.attachShadow;
  win.HTMLElement.prototype.attachShadow = function(init) { const root = attach.call(this, init); closedRoot = root; return root; };
  const sim = win.document.createElement('div'); sim.id = 'simulator'; win.document.body.append(sim);
  if (withAnchor) { const table = win.document.createElement('table'); table.dataset.results = ''; sim.append(table); }
  let parity: typeof compared | { kind: 'not_observed' } | null = { kind: 'not_observed' };
  let error: string | undefined;
  const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity, error }), '#simulator table');
  return { win, sim, panel, get root() { return closedRoot; }, set(next: typeof parity, message?: string) { parity = next; error = message; panel.refresh(); } };
}

describe('in-page extension panel', () => {
  it('mounts next to results, starts open, toggles, and distinguishes parity states', () => {
    const f = fixture();
    const host = f.win.document.querySelector('[data-osx-page-panel]')!;
    expect(host.shadowRoot).toBeNull();
    expect(host.previousElementSibling).toBe(f.sim.querySelector('table'));
    expect(host.getAttribute('data-osx-page-panel')).toBe('');
    const root = f.root as ShadowRoot;
    expect(root.querySelector('style')).not.toBeNull();
    expect(root.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    root.querySelector('button')?.click();
    expect(root.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.body')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('[data-osx-parity]')?.textContent).toBe('Not observed');
    f.set(compared);
    expect(root.querySelector('[data-osx-parity]')?.textContent).toBe('Matches SwimCloud');
    f.set({ kind: 'not_observed' });
    f.panel.disconnect();
  });
  it('mounts nothing without an anchor and adds one panel after React inserts it', () => {
    const f = fixture(false);
    expect(f.win.document.querySelector('[data-osx-page-panel]')).toBeNull();
    const table = f.win.document.createElement('table'); f.sim.append(table); f.panel.refresh();
    expect(f.win.document.querySelectorAll('[data-osx-page-panel]')).toHaveLength(1);
    f.panel.disconnect();
  });
  it('remounts exactly one panel when React replaces the anchor', () => {
    const f = fixture();
    f.sim.replaceChildren(f.win.document.createElement('table'));
    f.panel.refresh();
    expect(f.win.document.querySelectorAll('[data-osx-page-panel]')).toHaveLength(1);
    f.panel.disconnect();
  });
  it('surfaces compatibility errors in the closed shadow tree', () => {
    const f = fixture(); f.set(compared, 'Simulator rejected settings write');
    const host = f.win.document.querySelector('[data-osx-page-panel]')!;
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute('data-osx-page-panel')).toBe('');
    expect((f.root as ShadowRoot).querySelector('[data-osx-compatibility-error]')?.textContent).toBe('Simulator rejected settings write');
    f.panel.disconnect();
  });

  it('sets its own font inside the closed root, on the panel and not only on the host, so a page rule for the host cannot reach it', () => {
    const f = fixture();
    const css = (f.root as ShadowRoot).querySelector('style')?.textContent ?? '';
    // The dashboard's stack is --osx-font (shared/theme.ts). The panel element carries the font, so the host's own style cannot replace it.
    expect(css).toMatch(/\.panel\{font:14px\/1\.45 var\(--osx-font,/);
    expect(css).toMatch(/--osx-font:/);
    f.panel.disconnect();
  });
});

