// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import MeetDiffTable from '../packages/matrix/src/components/MeetDiffTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('MeetDiffTable', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
  afterEach(() => { act(() => root.unmount()); container.remove(); });

  it('aligns headers with numeric cells and omits a plus sign for zero delta', async () => {
    const baseline = [{ teamName: 'Alpha', totalPoints: 10, swimmers: {} }];
    const projected = [{ teamName: 'Alpha', totalPoints: 12, swimmers: {} }];
    await act(async () => root.render(createElement(MeetDiffTable, { baselineTeams: baseline, projectedTeams: projected, searchQuery: '' })));
    const table = container.querySelector('table')!;
    expect([...table.querySelectorAll('thead th')].slice(1).every(th => th.classList.contains('text-right'))).toBe(true);
    expect([...table.querySelectorAll('tbody td')].slice(1).every(td => td.classList.contains('text-right'))).toBe(true);
    expect(table.querySelectorAll('tbody td')[1].textContent).toBe('10.0');
    expect(table.querySelectorAll('tbody td')[2].textContent).toBe('12.0');
  });
});
