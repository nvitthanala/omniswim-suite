// @vitest-environment happy-dom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NumberField } from '../packages/ui/src/components/NumberField';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('NumberField', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onValueChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onValueChange = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('allows clear-and-type to commit the new integer instead of appending to the old value', async () => {
    await act(async () => {
      root.render(createElement(NumberField, {
        'aria-label': 'Max scorers', value: 999, onValueChange,
      }));
    });
    const input = container.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(input, '4');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith(4);
  });

  it('keeps the last committed value while empty and accepts zero when the minimum allows it', async () => {
    await act(async () => root.render(createElement(NumberField, {
      'aria-label': 'Weight', value: 1, min: 0, step: 0.01, onValueChange,
    })));
    const input = container.querySelector('input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(onValueChange).not.toHaveBeenCalled();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '0');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenLastCalledWith(0);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
  /** Controlled wrapper: the parent stores whatever the field publishes, as the real settings forms do. */
  function Controlled({ initial, min, step, max, log }: { initial: number; min?: number; step?: number; max?: number; log: number[] }) {
    const [value, setValue] = useState(initial);
    return createElement(NumberField, {
      'aria-label': 'Controlled', value, min, max, step,
      onValueChange: (next: number) => { log.push(next); setValue(next); },
    });
  }

  async function typeText(input: HTMLInputElement, text: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('types ".05" after an existing "2" without the draft snapping back (relay multiplier 2 -> 2.05)', async () => {
    const log: number[] = [];
    await act(async () => root.render(createElement(Controlled, { initial: 2, min: 0, step: 0.01, log })));
    const input = container.querySelector('input')!;
    await typeText(input, '2.');
    expect(input.value).toBe('2.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await typeText(input, '2.0');
    expect(input.value).toBe('2.0');
    await typeText(input, '2.05');
    expect(input.value).toBe('2.05');
    expect(log.at(-1)).toBe(2.05);
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });

  it('types "0.05" for the diver weight stepwise and publishes 0.05', async () => {
    const log: number[] = [];
    await act(async () => root.render(createElement(Controlled, { initial: 1, min: 0, max: 1, step: 0.01, log })));
    const input = container.querySelector('input')!;
    for (const text of ['0', '0.', '0.0', '0.05']) await typeText(input, text);
    expect(input.value).toBe('0.05');
    expect(log.at(-1)).toBe(0.05);
    // Select-all then type ".05" directly.
    await typeText(input, '.');
    await typeText(input, '.0');
    await typeText(input, '.05');
    expect(input.value).toBe('.05');
    expect(log.at(-1)).toBe(0.05);
  });

  it('clear-and-type-4 through a controlled parent still ends at 4', async () => {
    const log: number[] = [];
    await act(async () => root.render(createElement(Controlled, { initial: 999, min: 0, log })));
    const input = container.querySelector('input')!;
    await typeText(input, '');
    await typeText(input, '4');
    expect(input.value).toBe('4');
    expect(log.at(-1)).toBe(4);
  });

  it('still adopts an external value change, including while the draft is invalid', async () => {
    const render = (value: number) => act(async () => root.render(createElement(NumberField, { 'aria-label': 'X', value, min: 0, onValueChange })));
    await render(5);
    const input = container.querySelector('input')!;
    await typeText(input, '');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await render(9);
    expect(input.value).toBe('9');
    expect(input.hasAttribute('aria-invalid')).toBe(false);
  });
});
