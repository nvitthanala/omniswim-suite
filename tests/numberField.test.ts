// @vitest-environment happy-dom
import { act, createElement } from 'react';
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
});
