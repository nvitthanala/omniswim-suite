// @vitest-environment happy-dom
/**
 * The Manager team bar is the single control that writes the selected team.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import ManagerTeamBar from '../packages/manager/src/components/ManagerTeamBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ManagerTeamBar', () => {
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

  it('renders exactly one select named Team with every team as an option', async () => {
    await act(async () => {
      root.render(createElement(ManagerTeamBar, { teams: ['Alpha', 'Beta'], selectedTeam: 'Beta', onSelectTeam: vi.fn() }));
    });
    const selects = container.querySelectorAll('select');
    expect(selects).toHaveLength(1);
    expect(container.querySelector('label')?.textContent).toMatch(/Team/);
    expect(selects[0].value).toBe('Beta');
    expect(Array.from(selects[0].options).map(o => o.value)).toEqual(['', 'Alpha', 'Beta']);
  });

  it('reports the chosen team through onSelectTeam', async () => {
    const onSelectTeam = vi.fn();
    await act(async () => {
      root.render(createElement(ManagerTeamBar, { teams: ['Alpha', 'Beta'], selectedTeam: '', onSelectTeam }));
    });
    const select = container.querySelector('select')!;
    await act(async () => {
      select.value = 'Alpha';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSelectTeam).toHaveBeenCalledWith('Alpha');
  });

  it('keeps the one select, disabled, when there is no scoreable team', async () => {
    await act(async () => {
      root.render(createElement(ManagerTeamBar, { teams: [], selectedTeam: '', onSelectTeam: vi.fn() }));
    });
    const selects = container.querySelectorAll('select');
    expect(selects).toHaveLength(1);
    expect(selects[0].disabled).toBe(true);
    expect(selects[0].options[0].textContent).toBe('No teams yet');
  });
});
