// @vitest-environment happy-dom
/**
 * One "Export entries" menu replaces the separate CSV and HyTek buttons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ExportEntriesMenu from '../packages/manager/src/components/ExportEntriesMenu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ExportEntriesMenu', () => {
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

  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  };

  it('shows one trigger and hides both formats until opened', async () => {
    await act(async () => {
      root.render(createElement(ExportEntriesMenu, { onExport: vi.fn() }));
    });
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0].getAttribute('aria-label')).toBe('Export entries');
    expect(buttons[0].getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });

  it('exports CSV and HyTek from the open menu', async () => {
    const onExport = vi.fn();
    await act(async () => {
      root.render(createElement(ExportEntriesMenu, { onExport }));
    });
    await click(container.querySelector('button')!);
    const items = Array.from(container.querySelectorAll('[role="menuitem"]'));
    expect(items.map(i => i.textContent)).toEqual(['CSV (spreadsheet)', 'HyTek entry list']);
    await click(items[0]);
    expect(onExport).toHaveBeenLastCalledWith('csv');
    await click(container.querySelector('button')!);
    await click(container.querySelectorAll('[role="menuitem"]')[1]);
    expect(onExport).toHaveBeenLastCalledWith('hytek');
  });
});
