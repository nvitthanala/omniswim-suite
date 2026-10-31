// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The dashboard shell (U-a): plans/2026-10-25/D6-DASHBOARD.md sections 1 and 5.
 * Pinned: a docked tab renders only when it is first opened and then stays mounted; the tab list answers the arrow, Home and End keys and
 * names the open tab with `aria-selected`; the size button asks for the expanded size; the host shell shows the open section only.
 * The `theme-state` and `panel-size` messages are checked at the port; the page panel mirrors the resolved theme on its host; a user accent
 * is lightened in the dark theme and follows a theme switch.
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { Window as HappyWindow } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { DockedShell, HostShell } from '../apps/extension/src/dashboard/Shell';
import type { ShellTab, TabContext } from '../apps/extension/src/dashboard/Shell';
import { isPanelSize, isThemeState } from '../apps/extension/src/shared/panelProtocol';
import { mountPagePanel } from '../apps/extension/src/overlay/pagePanel';
import { applyAccent, createAccentSync } from '../apps/extension/src/shared/theme';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

interface Calls {
  readonly rendered: string[];
  readonly contexts: Map<string, TabContext>;
}

function tabsOf(ids: readonly string[], calls: Calls): readonly ShellTab[] {
  return ids.map((id) => ({
    id,
    label: id.toUpperCase(),
    render: (context: TabContext) => {
      calls.rendered.push(id);
      calls.contexts.set(id, context);
      return React.createElement('p', { 'data-testid': `body-${id}` }, `body ${id}`);
    },
  }));
}

async function mountNode(element: React.ReactElement): Promise<(testId: string) => HTMLElement | null> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return (id) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;
}

const press = async (el: HTMLElement | null, key: string): Promise<void> => {
  await act(async () => { el?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
};

describe('DockedShell', () => {
  it('renders a tab for the first time when it is opened, and keeps it mounted and hidden after', async () => {
    const calls: Calls = { rendered: [], contexts: new Map() };
    const q = await mountNode(React.createElement(DockedShell, { tabs: tabsOf(['a', 'b', 'c'], calls), hostLabel: 'host: docked' }));
    expect(calls.rendered).toStrictEqual(['a']);
    expect(q('panel-b')).toBeNull();
    await act(async () => q('tab-b')?.click());
    expect(q('body-b')).not.toBeNull();
    expect(q('panel-b')?.hidden).toBe(false);
    expect(q('panel-a')?.hidden).toBe(true);
    expect(q('body-a'), 'the first tab stays mounted while hidden').not.toBeNull();
    expect(calls.rendered.includes('c'), 'a tab nobody opened never rendered').toBe(false);
    expect(calls.contexts.get('a')?.active).toBe(false);
    expect(calls.contexts.get('b')?.active).toBe(true);
    expect(q('host')?.textContent).toBe('host: docked');
  });

  it('names the open tab with aria-selected and moves with the arrow, Home and End keys', async () => {
    const calls: Calls = { rendered: [], contexts: new Map() };
    const q = await mountNode(React.createElement(DockedShell, { tabs: tabsOf(['a', 'b', 'c'], calls), hostLabel: 'h' }));
    const selected = (): string[] => ['a', 'b', 'c'].filter((id) => q(`tab-${id}`)?.getAttribute('aria-selected') === 'true');
    expect(selected()).toStrictEqual(['a']);
    await press(q('tab-a'), 'ArrowRight');
    expect(selected()).toStrictEqual(['b']);
    await press(q('tab-b'), 'End');
    expect(selected()).toStrictEqual(['c']);
    await press(q('tab-c'), 'ArrowRight');
    expect(selected(), 'the arrow wraps').toStrictEqual(['a']);
    await press(q('tab-a'), 'ArrowLeft');
    expect(selected()).toStrictEqual(['c']);
    await press(q('tab-c'), 'Home');
    expect(selected()).toStrictEqual(['a']);
    // Only the open tab is in the tab order.
    expect(['a', 'b', 'c'].map((id) => (q(`tab-${id}`) as HTMLButtonElement).tabIndex)).toStrictEqual([0, -1, -1]);
    expect(q('panel-a')?.getAttribute('aria-labelledby')).toBe(q('tab-a')?.id);
  });

  it('asks for the expanded size, tells the tabs, and asks for the compact size again', async () => {
    const calls: Calls = { rendered: [], contexts: new Map() };
    const sizes: string[] = [];
    const onSize = (s: 'compact' | 'expanded'): void => { sizes.push(s); };
    const q = await mountNode(React.createElement(DockedShell, { tabs: tabsOf(['a'], calls), hostLabel: 'h', onSize }));
    expect(sizes).toStrictEqual(['compact']);
    expect(q('size-toggle')?.textContent).toBe('Larger');
    await act(async () => q('size-toggle')?.click());
    expect(sizes).toStrictEqual(['compact', 'expanded']);
    expect(q('docked-shell')?.getAttribute('data-size')).toBe('expanded');
    expect(calls.contexts.get('a')?.expanded).toBe(true);
    expect(q('size-toggle')?.textContent).toBe('Smaller');
    await act(async () => q('size-toggle')?.click());
    expect(sizes).toStrictEqual(['compact', 'expanded', 'compact']);
  });
});

describe('HostShell', () => {
  it('shows the open section only and moves with the vertical arrows', async () => {
    const calls: Calls = { rendered: [], contexts: new Map() };
    const q = await mountNode(React.createElement(HostShell, { tabs: tabsOf(['meets', 'presets', 'settings'], calls), hostLabel: 'host: tab' }));
    expect(q('body-meets')).not.toBeNull();
    expect(q('body-presets')).toBeNull();
    await press(q('tab-meets'), 'ArrowDown');
    expect(q('body-presets')).not.toBeNull();
    expect(q('body-meets')).toBeNull();
    expect(q('tab-presets')?.getAttribute('aria-selected')).toBe('true');
    // The horizontal keys do nothing in a vertical list.
    await press(q('tab-presets'), 'ArrowRight');
    expect(q('tab-presets')?.getAttribute('aria-selected')).toBe('true');
    expect(q('host')?.textContent).toBe('host: tab');
  });
});

describe('theme-state and panel-size messages', () => {
  it('accepts a preference with an optional #rrggbb accent, and nothing else', () => {
    expect(isThemeState({ kind: 'theme-state', preference: 'dark' })).toBe(true);
    expect(isThemeState({ kind: 'theme-state', preference: 'system', accent: '#12ab34' })).toBe(true);
    expect(isThemeState({ kind: 'theme-state', preference: 'blue' })).toBe(false);
    expect(isThemeState({ kind: 'theme-state', preference: 'dark', accent: 'red' })).toBe(false);
    expect(isThemeState({ kind: 'theme-state', preference: 'dark', accent: '#fff' })).toBe(false);
    expect(isThemeState({ kind: 'theme-state', preference: 'dark', accent: 'url(x)' })).toBe(false);
    expect(isThemeState({ kind: 'other', preference: 'dark' })).toBe(false);
    expect(isThemeState(null)).toBe(false);
  });
  it('accepts the two sizes only', () => {
    expect(isPanelSize({ kind: 'panel-size', size: 'compact' })).toBe(true);
    expect(isPanelSize({ kind: 'panel-size', size: 'expanded' })).toBe(true);
    expect(isPanelSize({ kind: 'panel-size', size: 'huge' })).toBe(false);
    expect(isPanelSize({ kind: 'panel-size', size: 'expanded', extra: 1 })).toBe(true);
    expect(isPanelSize({ kind: 'size', size: 'expanded' })).toBe(false);
    expect(isPanelSize(undefined)).toBe(false);
  });
});

describe('the page panel follows the theme state', () => {
  const mount = () => {
    const win = new HappyWindow();
    const sim = win.document.createElement('div');
    sim.id = 'simulator';
    sim.append(win.document.createElement('table'));
    win.document.body.append(sim);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), '#simulator table');
    const hostEl = win.document.querySelector('[data-osx-page-panel]') as unknown as HTMLElement;
    return { panel, hostEl };
  };

  it('mirrors the resolved theme on its host, and goes back to light for null', () => {
    const { panel, hostEl } = mount();
    expect(hostEl.dataset.osxTheme).toBe('light');
    panel.setThemeState({ kind: 'theme-state', preference: 'dark' });
    expect(hostEl.dataset.osxTheme).toBe('dark');
    panel.setThemeState({ kind: 'theme-state', preference: 'light', accent: '#aa0000' });
    expect(hostEl.dataset.osxTheme).toBe('light');
    panel.setThemeState(null);
    expect(hostEl.dataset.osxTheme).toBe('light');
    panel.disconnect();
  });

  it('applies a theme state that arrived before the panel was mounted', () => {
    const win = new HappyWindow();
    const sim = win.document.createElement('div');
    sim.id = 'simulator';
    win.document.body.append(sim);
    const panel = mountPagePanel(win.document as unknown as Document, () => ({ parity: null }), '#simulator table');
    panel.setThemeState({ kind: 'theme-state', preference: 'dark' });
    sim.append(win.document.createElement('table'));
    panel.refresh();
    const hostEl = win.document.querySelector('[data-osx-page-panel]') as unknown as HTMLElement;
    expect(hostEl.dataset.osxTheme).toBe('dark');
    panel.disconnect();
  });
});

describe('a user accent per theme', () => {
  const el = (): HTMLElement => document.createElement('div');

  it('is used as it is in the light theme', () => {
    const e = el();
    expect(applyAccent(e, '#aa0000')).toBe(true);
    expect(e.style.getPropertyValue('--osx-accent')).toBe('#aa0000');
  });

  it('is lightened toward the dark text colour in the dark theme, and the text on it follows the lightened colour', () => {
    const e = el();
    expect(applyAccent(e, '#000080', 'dark')).toBe(true);
    expect(e.style.getPropertyValue('--osx-accent')).toBe('color-mix(in srgb, #000080 65%, CanvasText)');
    const light = el();
    applyAccent(light, '#000080', 'light');
    expect(light.style.getPropertyValue('--osx-accent-fg')).toBe('white');
  });

  it('refuses anything that is not #rrggbb and changes nothing', () => {
    const e = el();
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', '']) expect(applyAccent(e, bad)).toBe(false);
    expect(e.style.getPropertyValue('--osx-accent')).toBe('');
  });

  it('follows a change of the element theme attribute, and clears when unset', async () => {
    const e = el();
    const sync = createAccentSync(e);
    sync.set('#aa0000');
    expect(e.style.getPropertyValue('--osx-accent')).toBe('#aa0000');
    e.setAttribute('data-osx-theme', 'dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(e.style.getPropertyValue('--osx-accent')).toBe('color-mix(in srgb, #aa0000 65%, CanvasText)');
    e.setAttribute('data-osx-theme', 'light');
    await new Promise((r) => setTimeout(r, 0));
    expect(e.style.getPropertyValue('--osx-accent')).toBe('#aa0000');
    sync.set(undefined);
    expect(e.style.getPropertyValue('--osx-accent')).toBe('');
    sync.set('not a colour');
    expect(e.style.getPropertyValue('--osx-accent'), 'a bad value clears and never applies').toBe('');
    sync.dispose();
  });
});
