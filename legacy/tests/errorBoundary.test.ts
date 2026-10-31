// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * X1: a render error shows a plain fallback instead of a blank app. Reload
 * re-renders, "Restore last backup" uses the host's calls, and a 403
 * ADMIN_REQUIRED shows a clear message while Reload stays available.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { elementWithChildren } from '../../tests/helpers/elementWithChildren';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary, type BackupRestoreActions } from '../packages/ui/src/components/ErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const flag = { fail: true, message: 'Render exploded' };

function Thrower(): ReactNode {
  if (flag.fail) throw new Error(flag.message);
  return createElement('p', null, 'Matrix content');
}

describe('ErrorBoundary', () => {
  let container: HTMLDivElement;
  let root: Root;
  let consoleError: MockInstance<typeof console.error>;
  let onPageReload: () => void;

  beforeEach(() => {
    flag.fail = true;
    flag.message = 'Render exploded';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    onPageReload = vi.fn();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function show(backup?: BackupRestoreActions, area = 'Matrix') {
    await act(async () => {
      root.render(
        elementWithChildren(ErrorBoundary, { area, backup, onPageReload }, createElement(Thrower))
      );
    });
  }

  function button(label: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label));
  }

  async function click(label: string) {
    const target = button(label);
    expect(target, `button "${label}"`).toBeTruthy();
    await act(async () => {
      target!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it('renders its children when nothing throws', async () => {
    flag.fail = false;
    await show();
    expect(container.textContent).toContain('Matrix content');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows a plain fallback with Reload when a child throws on render', async () => {
    await show();
    expect(container.textContent).toContain('Something went wrong in Matrix');
    expect(container.textContent).not.toContain('Matrix content');
    expect(button('Reload')).toBeTruthy();
  });

  it('logs the error and its component stack under the boundary prefix', async () => {
    await show();
    const call = consoleError.mock.calls.find(
      args => typeof args[0] === 'string' && args[0].startsWith('[ErrorBoundary] Matrix')
    );
    expect(call, 'a [ErrorBoundary] console.error call').toBeTruthy();
    expect((call![1] as Error).message).toBe('Render exploded');
    expect(String(call![2])).toContain('Thrower');
  });

  it('Reload re-renders the area when the cause is gone', async () => {
    await show();
    flag.fail = false;
    await click('Reload');
    expect(container.textContent).toContain('Matrix content');
    expect(container.textContent).not.toContain('Something went wrong');
    expect(onPageReload).not.toHaveBeenCalled();
  });

  it('Reload reloads the page when the area fails again after a re-render', async () => {
    await show();
    await click('Reload');
    expect(container.textContent).toContain('Something went wrong in Matrix');
    expect(onPageReload).not.toHaveBeenCalled();
    await click('Reload');
    expect(onPageReload).toHaveBeenCalledTimes(1);
  });

  it('Reload reloads the page at once for a failed code download', async () => {
    flag.message = 'Failed to fetch dynamically imported module: /assets/matrix.js';
    await show();
    await click('Reload');
    expect(onPageReload).toHaveBeenCalledTimes(1);
  });

  it('hides Restore last backup when the host passes no backup calls', async () => {
    await show();
    expect(button('Restore last backup')).toBeUndefined();
  });

  it('shows the administrator message on 403 ADMIN_REQUIRED and keeps Reload', async () => {
    const findLast = vi.fn().mockRejectedValue(
      Object.assign(new Error('Backups hold every user data.'), { status: 403, code: 'ADMIN_REQUIRED' })
    );
    const restore = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await show({ findLast, restore });
    await click('Restore last backup');
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Only an administrator can restore a backup');
    expect(button('Reload')).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('restores the newest backup after confirmation, then reloads the page', async () => {
    const findLast = vi
      .fn()
      .mockResolvedValue({ file: 'meets-manual-20261012T150000Z.json', writtenAt: null, label: 'manual' });
    const restore = vi.fn().mockResolvedValue(undefined);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await show({ findLast, restore });
    await click('Restore last backup');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0]![0])).toContain('meets-manual-20261012T150000Z.json');
    expect(restore).toHaveBeenCalledWith('meets-manual-20261012T150000Z.json');
    expect(onPageReload).toHaveBeenCalledTimes(1);
  });

  it('does not restore when the confirmation is declined', async () => {
    const findLast = vi.fn().mockResolvedValue({ file: 'meets-startup-x.json', writtenAt: null, label: null });
    const restore = vi.fn();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await show({ findLast, restore });
    await click('Restore last backup');
    expect(restore).not.toHaveBeenCalled();
    expect(onPageReload).not.toHaveBeenCalled();
  });

  it('says so when no backup exists', async () => {
    const findLast = vi.fn().mockResolvedValue(null);
    await show({ findLast, restore: vi.fn() });
    await click('Restore last backup');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('No backup was found');
  });

  it('shows the failure reason when the restore call fails', async () => {
    const findLast = vi.fn().mockResolvedValue({ file: 'meets-manual-a.json', writtenAt: null, label: null });
    const restore = vi.fn().mockRejectedValue(new Error('Restore failed'));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await show({ findLast, restore });
    await click('Restore last backup');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be restored');
    expect(onPageReload).not.toHaveBeenCalled();
  });
});

describe('shell wiring', () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'apps/shell/src/App.tsx'), 'utf8');

  it('wraps every route element except the redirect in an AppErrorBoundary', () => {
    const routes = [...source.matchAll(/<Route path="([^"]+)" element=\{(.+)\} \/>/g)];
    const real = routes.filter(([, path]) => path !== '*');
    expect(real.map(([, path]) => path).sort()).toEqual(
      ['/', '/analytics', '/login', '/manager', '/matrix', '/metrics', '/settings', '/share/:token'].sort()
    );
    for (const [, path, element] of real) {
      expect(element, `route ${path}`).toMatch(/^<AppErrorBoundary area="[^"]+">.*<\/AppErrorBoundary>$/);
    }
  });

  it('wraps the whole shell layout in one more boundary', () => {
    expect(source).toMatch(/<AppErrorBoundary>\s*<ShellLayout \/>\s*<\/AppErrorBoundary>/);
  });
});
