/**
 * Setup file (see vitest.config.ts `setupFiles`).
 *
 * happy-dom ships no `window.confirm`, `alert` or `prompt`. Vitest 3 let a test
 * call `vi.spyOn(window, 'confirm')` on that missing property. Vitest 4 and 5
 * throw "can only spy on a function" instead. This file defines the three dialogs
 * as functions that throw, so a test can spy on them and an unmocked call still
 * fails loudly, as the missing property did. Only a DOM environment is touched:
 * the Node environment has no `window`.
 */
type Dialogs = Record<'confirm' | 'alert' | 'prompt', unknown>;

const target = globalThis as unknown as Partial<Dialogs> & { window?: Partial<Dialogs> };

if (typeof target.window !== 'undefined') {
  for (const name of ['confirm', 'alert', 'prompt'] as const) {
    if (typeof target.window[name] === 'function') continue;
    const unmocked = function unmockedDialog(): never {
      throw new Error(`window.${name} is not implemented by happy-dom. Mock it with vi.spyOn(window, '${name}').`);
    };
    target.window[name] = unmocked;
    // `window` is the global object in a happy-dom Vitest environment. Keep the bare global in step.
    if (target[name] !== unmocked) target[name] = unmocked;
  }
}
