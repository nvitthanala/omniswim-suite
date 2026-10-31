import { describe, expect, it } from 'vitest';
import { Window as HappyWindow } from 'happy-dom';
import { builtinRulePreset, requireComplete } from '@omniswim/engine';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import type { ScorerTagStateMessage } from '../apps/extension/src/shared/panelProtocol';

describe('page rule Apply preview', () => {
  it('previews without writing and refuses a preset atomically when Apply is clicked', () => {
    const win = new HappyWindow(); let closed: unknown;
    const attach = win.HTMLElement.prototype.attachShadow;
    win.HTMLElement.prototype.attachShadow = function(init) { const root = attach.call(this, init); closed = root; return root; };
    win.document.body.innerHTML = '<table></table>';
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), 'table');
    let writes = 0; let received: unknown;
    panel.onApplyRule(settings => { writes += 1; received = settings; });
    const preset = requireComplete(builtinRulePreset('nsisc', 4)!);
    const state: ScorerTagStateMessage = { kind: 'scorer-tag-state', meetKey: 'test', teams: [], swimmers: [], tags: [], warnings: [], rulePresetRef: { kind: 'builtin', id: 'nsisc', version: 4 }, rulePreset: preset };
    panel.setScorerState(state);
    const root = closed as ShadowRoot;
    expect(root.querySelector('[data-osx-apply-preview]')?.textContent).toContain('Cannot apply: maxScorersPerTeam: SwimCloud uses the same cap for individual events and relays, but the preset caps differ or one is pending. scorers.relayOverCap: R67 relay exhibition behavior has no page setting.');
    expect(root.querySelector('[data-osx-apply-preview]')?.textContent).not.toContain('numeric limits only');
    expect(writes).toBe(0);
    (root.querySelector('[aria-label="Apply rule preset to SwimCloud"]') as HTMLButtonElement).click();
    expect(writes).toBe(1);
    expect(received).toBeNull();
    panel.disconnect();
  });
});
