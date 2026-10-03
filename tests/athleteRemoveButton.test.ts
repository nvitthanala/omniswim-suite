// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The athlete drawer's Remove action: a real, focusable <button> that says what
 * it does and activates once per Enter or Space (the browser turns those keys
 * into a click on a button; a second key handler would double-fire).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AthleteRemoveButton, { ATHLETE_REMOVE_HINT } from '../packages/manager/src/components/AthleteRemoveButton';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('AthleteRemoveButton', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onRequestRemove = vi.fn();

  beforeEach(() => {
    onRequestRemove.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(AthleteRemoveButton, { athleteName: 'Ada Lane', onRequestRemove }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const button = () => container.querySelector('button') as HTMLButtonElement;

  it('is a real, enabled, tabbable button', () => {
    expect(button().tagName).toBe('BUTTON');
    expect(button().type).toBe('button');
    expect(button().disabled).toBe(false);
    expect(button().getAttribute('tabindex')).not.toBe('-1');
    expect(button().getAttribute('aria-label')).toBe('Remove Ada Lane from roster');
  });

  it('says what Remove does, in the tooltip and for screen readers', () => {
    expect(ATHLETE_REMOVE_HINT).toMatch(/roster/);
    expect(ATHLETE_REMOVE_HINT).toMatch(/Enter or Space/);
    expect(button().title).toBe(ATHLETE_REMOVE_HINT);
    const describedBy = button().getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(container.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(ATHLETE_REMOVE_HINT);
  });

  it('activates once per click and does not swallow Enter or Space', () => {
    act(() => button().click());
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
    for (const key of ['Enter', ' ']) {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      act(() => {
        button().dispatchEvent(ev);
      });
      expect(ev.defaultPrevented, `key ${JSON.stringify(key)} keeps its default (the click)`).toBe(false);
    }
    // No second handler: a keydown alone never calls the action. The browser's click does.
    expect(onRequestRemove).toHaveBeenCalledTimes(1);
  });

  it('is what the athlete editor panel renders for Remove', () => {
    const src = readFileSync(
      join(import.meta.dirname, '../packages/manager/src/components/AthleteLineupEditorPanel.tsx'),
      'utf8'
    );
    expect(src).toContain('<AthleteRemoveButton');
  });
});
