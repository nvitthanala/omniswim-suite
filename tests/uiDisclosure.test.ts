// @vitest-environment happy-dom
/**
 * Disclosure primitive: a button with aria-expanded and aria-controls that
 * shows and hides one panel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Disclosure } from '../packages/ui/src/components/Disclosure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('Disclosure', () => {
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

  const render = async (props: Record<string, unknown> = {}) => {
    await act(async () => {
      root.render(createElement(Disclosure, { title: 'Copy meet', ...props }, createElement('p', null, 'Hidden body')));
    });
    return container.querySelector('button')!;
  };

  const panelOf = (trigger: Element) =>
    container.querySelector<HTMLElement>(`[id="${trigger.getAttribute('aria-controls')}"]`)!;

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('starts collapsed: aria-expanded is false and the panel is hidden', async () => {
    const trigger = await render();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const panel = panelOf(trigger);
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
  });

  it('toggles aria-expanded and the panel on click', async () => {
    const trigger = await render();
    const panel = panelOf(trigger);
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
  });

  it('honours defaultOpen and names the panel by its button', async () => {
    const trigger = await render({ defaultOpen: true });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const panel = panelOf(trigger);
    expect(panel.hidden).toBe(false);
    expect(panel.getAttribute('aria-labelledby')).toBe(trigger.id);
    expect(trigger.textContent).toContain('Copy meet');
  });

  it('reports changes in controlled mode and follows the open prop', async () => {
    const onOpenChange = vi.fn();
    const trigger = await render({ open: false, onOpenChange });
    await click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Controlled: the parent has not changed `open`, so nothing moved.
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await render({ open: true, onOpenChange });
    expect(container.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
  });
});
