// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rename in `WorkspaceSidebar` (`apps/shell/src/components/WorkspaceSidebar.tsx`).
 *
 * `setEditingWorkspaceId` was never given a workspace id, so the rename input
 * could not be reached. These tests drive the whole flow through the rendered
 * sidebar: the button, Enter, Escape, trim, blank, unchanged, and blur.
 *
 * The provider, the snapshot API and the toast are mocked. The sidebar, its
 * list rows and the shared `Button` are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const saveWorkspace = vi.fn(async (_patch: { name?: string }) => ({ ok: true as const }));
const setActiveWorkspaceId = vi.fn();
const toastPush = vi.fn();

const workspaces = [
  { id: 'w1', name: 'Conference prep', createdAt: '2026-09-01T00:00:00Z', loadedMeet: null },
  { id: 'w2', name: 'Dual meet', createdAt: '2026-09-02T00:00:00Z', loadedMeet: null },
];

vi.mock('@omniswim/core/store/SuiteWorkspaceProvider', () => ({
  useSuiteWorkspace: () => ({
    workspaces,
    activeWorkspaceId: 'w1',
    setActiveWorkspaceId,
    createWorkspace: vi.fn(),
    deleteWorkspace: vi.fn(),
    restoreWorkspace: vi.fn(),
    saveWorkspace,
    refreshWorkspaces: vi.fn(),
  }),
}));

vi.mock('@omniswim/core/api/snapshots', () => ({
  createSnapshot: vi.fn(),
  listSnapshots: vi.fn(async () => []),
  restoreSnapshot: vi.fn(),
}));

vi.mock('@omniswim/ui', async importOriginal => {
  const actual = await importOriginal<typeof import('@omniswim/ui')>();
  return { ...actual, useToast: () => ({ push: toastPush }), useOpenTheoreticalMeet: () => null };
});

vi.mock('@omniswim/matrix/components/DeleteConfirmationModal', () => ({ default: () => null }));

const { default: WorkspaceSidebar } = await import('../apps/shell/src/components/WorkspaceSidebar');

describe('WorkspaceSidebar rename', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    saveWorkspace.mockClear();
    toastPush.mockClear();
    setActiveWorkspaceId.mockClear();
    try {
      window.localStorage.setItem('omni-sidebar-collapsed', 'false');
    } catch {
      // Storage can be blocked. The default is expanded.
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(WorkspaceSidebar));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renameButton = (name: string) =>
    container.querySelector<HTMLButtonElement>(`button[aria-label="Rename workspace ${name}"]`);
  const nameInput = () => container.querySelector<HTMLInputElement>('input[aria-label="Workspace name"]');

  async function startRename(name = 'Conference prep'): Promise<void> {
    const button = renameButton(name);
    if (button === null) throw new Error('rename button not rendered');
    await act(async () => {
      button.click();
    });
  }

  async function typeName(value: string): Promise<void> {
    const input = nameInput();
    if (input === null) throw new Error('rename input not rendered');
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setValue === undefined) throw new Error('no native value setter');
    await act(async () => {
      setValue.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function press(key: string): Promise<void> {
    const input = nameInput();
    if (input === null) throw new Error('rename input not rendered');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
  }

  it('offers a named, focusable rename button on the active workspace only', () => {
    const button = renameButton('Conference prep');
    expect(button).not.toBeNull();
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.tabIndex).not.toBe(-1);
    // `saveWorkspace` writes to the open workspace, so no button on another row.
    expect(renameButton('Dual meet')).toBeNull();
  });

  it('opens the input with the current name, outside any button', async () => {
    await startRename();
    const input = nameInput();
    expect(input).not.toBeNull();
    expect(input?.value).toBe('Conference prep');
    expect(input?.closest('button')).toBeNull();
  });

  it('Enter saves the trimmed name through saveWorkspace and says so', async () => {
    await startRename();
    await typeName('  Conference finals  ');
    await press('Enter');

    expect(saveWorkspace).toHaveBeenCalledTimes(1);
    expect(saveWorkspace).toHaveBeenCalledWith({ name: 'Conference finals' });
    expect(toastPush).toHaveBeenCalledWith('success', 'Workspace renamed to "Conference finals"');
    expect(nameInput()).toBeNull();
  });

  it('Escape cancels without saving', async () => {
    await startRename();
    await typeName('Something else');
    await press('Escape');

    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(nameInput()).toBeNull();
    expect(container.textContent).toContain('Conference prep');
  });

  it('refuses a blank name and keeps the old one', async () => {
    await startRename();
    await typeName('    ');
    await press('Enter');

    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(nameInput()).toBeNull();
    expect(container.textContent).toContain('Conference prep');
  });

  it('does not save an unchanged name', async () => {
    await startRename();
    await typeName(' Conference prep ');
    await press('Enter');

    expect(saveWorkspace).not.toHaveBeenCalled();
    expect(toastPush).not.toHaveBeenCalled();
    expect(nameInput()).toBeNull();
  });

  it('saves once when Enter is followed by a blur', async () => {
    await startRename();
    await typeName('Finals');
    const input = nameInput();
    await press('Enter');
    await act(async () => {
      input?.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      input?.dispatchEvent(new FocusEvent('blur'));
    });

    expect(saveWorkspace).toHaveBeenCalledTimes(1);
  });

  it('saves when focus leaves the field', async () => {
    await startRename();
    await typeName('Finals');
    const input = nameInput();
    await act(async () => {
      input?.focus();
      input?.blur();
    });

    expect(saveWorkspace).toHaveBeenCalledWith({ name: 'Finals' });
  });
});
