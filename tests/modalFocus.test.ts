// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modal focus handling: on open move focus into the dialog, trap Tab /
 * Shift+Tab, restore focus on close. Escape and aria-modal stay intact.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Modal } from '../packages/ui/src/components/Modal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('Modal focus handling', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onClose: () => void;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onClose = vi.fn();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('exposes dialog semantics and moves focus to the first focusable child on open', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    await act(async () => {
      root.render(
        createElement(
          Modal,
          { onClose, ariaLabel: 'Example dialog' },
          createElement('button', { type: 'button' }, 'First'),
          createElement('button', { type: 'button' }, 'Second')
        )
      );
    });
    await flush();

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe('Example dialog');
    expect(document.activeElement?.textContent).toBe('First');

    opener.remove();
  });

  it('traps Tab and Shift+Tab inside the dialog', async () => {
    await act(async () => {
      root.render(
        createElement(
          Modal,
          { onClose, ariaLabel: 'Trap dialog' },
          createElement('button', { type: 'button' }, 'First'),
          createElement('button', { type: 'button' }, 'Last')
        )
      );
    });
    await flush();

    const buttons = [...container.querySelectorAll('button')] as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(document.activeElement).toBe(buttons[0]);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    // Native Tab still advances; trap only fires at the ends. Move to last then Tab.
    buttons[1].focus();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[0]);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      );
    });
    expect(document.activeElement).toBe(buttons[1]);
  });

  it('keeps focus on the dialog when there are no focusable children', async () => {
    await act(async () => {
      root.render(createElement(Modal, { onClose, ariaLabel: 'Empty dialog' }, createElement('p', null, 'No controls')));
    });
    await flush();

    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(document.activeElement).toBe(dialog);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });
    expect(document.activeElement).toBe(dialog);
  });

  it('sends Escape to the topmost nested dialog only', async () => {
    const innerClose = vi.fn();
    await act(async () => {
      root.render(
        createElement(
          Modal,
          { onClose, ariaLabel: 'Parent dialog' },
          createElement(
            Modal,
            { onClose: innerClose, ariaLabel: 'Nested dialog' },
            createElement('button', { type: 'button' }, 'Nested action')
          )
        )
      );
    });
    await flush();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape and restores focus to the opener', async () => {
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.textContent = 'Open';
    document.body.appendChild(opener);
    opener.focus();

    await act(async () => {
      root.render(
        createElement(
          Modal,
          { onClose, ariaLabel: 'Restore dialog' },
          createElement('button', { type: 'button' }, 'Inside')
        )
      );
    });
    await flush();
    expect(document.activeElement?.textContent).toBe('Inside');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(null);
    });
    await flush();
    expect(document.activeElement).toBe(opener);

    opener.remove();
  });
});
