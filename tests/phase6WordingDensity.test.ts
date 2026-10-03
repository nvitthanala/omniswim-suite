// @vitest-environment happy-dom
/**
 * Phase 6: wording, case and density sweep.
 *
 * - Lineup (roster mode) carries at most 45 buttons, and no action is lost:
 *   removing an athlete moved from 38 row buttons to the drawer and the Delete key.
 * - The default "Swimmer" tag is hidden when every row has it.
 * - The checklist renders once, one Jump per row, and long groups sit behind "Show more".
 * - Labels: Cross-course, Point opportunities, Link psych sheet, no scorer cap,
 *   "projected vs prelims", Scoring rules.
 * - Metrics has one "Open video" call to action, and it is a real button.
 * - The sidebar collapses below lg without writing the stored choice.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@omniswim/ui';
import { ClassYear, Gender, type SwimmerResult, type Workspace } from '@omniswim/core/types';
import type { LineupChecklistItem, TeamLineupAudit } from '@omniswim/core/lib/rosterLineupAudit';
import RosterLineupStep from '../packages/manager/src/components/RosterLineupStep';
import RosterOptimizeStep from '../packages/manager/src/components/RosterOptimizeStep';
import LineupComplianceChecklist from '../packages/manager/src/components/LineupComplianceChecklist';
import AthleteRoleTag from '../packages/manager/src/components/AthleteRoleTag';
import {
  isUniformSwimmerRoster,
  scorerCapPhrase,
} from '../packages/manager/src/components/teamRosterView';
import {
  buildChecklistRows,
  CHECKLIST_GROUP_ROW_LIMIT,
  visibleChecklistRows,
} from '../packages/manager/src/components/lineupChecklistView';
import MatrixProjectedActualScore from '../packages/matrix/src/components/ProjectedActualScore';
import { MetricsHeader } from '../packages/metrics/src/components/MetricsHeader';
import { SetupStepPanel } from '../packages/metrics/src/components/MetricsStepPanels';
import {
  readSidebarPreference,
  resolveSidebarCollapsed,
  SIDEBAR_STORAGE_KEY,
  useSidebarCollapse,
} from '../apps/shell/src/lib/sidebarCollapse';
import {
  HOME_TEAM,
  buildMeetWorkspace,
  resolvedScoringSettings,
  scoringBundleFor,
} from './optimizerStepFixtures';

vi.mock('motion/react', async () => (await import('./motionStub')).motionStub);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The meet fixture plus `extra` more home swimmers in one event: a roster of about 40. */
function largeRosterWorkspace(extra = 32, divers = 0): Workspace {
  const ws = buildMeetWorkspace();
  const added: SwimmerResult[] = [];
  for (let i = 0; i < extra; i++) {
    const isDiver = i < divers;
    added.push({
      id: `extra-${i}`,
      rank: 20 + i,
      name: `Extra Swimmer ${String(i).padStart(2, '0')}`,
      classYear: ClassYear.SO,
      team: HOME_TEAM,
      time: isDiver ? '250.00' : `${(30 + i * 0.1).toFixed(2)}`,
      finalsTime: isDiver ? '250.00' : `${(30 + i * 0.1).toFixed(2)}`,
      roundSwam: 'A Final',
      points: 0,
      event: isDiver ? '1M Diving' : '50 Freestyle',
      gender: Gender.MEN,
    } as SwimmerResult);
  }
  return { ...ws, menResults: [...(ws.menResults ?? []), ...added] };
}

describe('Lineup density and the Swimmer tag', () => {
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

  const buttons = () => Array.from(container.querySelectorAll('button'));
  const names = () => buttons().map(b => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim());

  async function renderLineup(
    ws: Workspace,
    handlers: { onRequestDeleteSwimmer?: (name: string) => void } = {}
  ) {
    const bundle = scoringBundleFor(ws, false);
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(RosterLineupStep, {
            workspace: ws,
            gender: Gender.MEN,
            scoringBundle: bundle,
            scoringSettings: resolvedScoringSettings(ws),
            baselineByTeam: new Map(),
            projectedByTeam: new Map(bundle.sortedTeams.map(t => [t.teamName, t.totalPoints])),
            whatIfMode: true,
            removeSeniors: false,
            selectedTeam: HOME_TEAM,
            onUpdate: () => undefined,
            onOpenOptimize: () => undefined,
            onRequestDeleteSwimmer: handlers.onRequestDeleteSwimmer ?? (() => undefined),
          })
        )
      );
    });
  }

  it('keeps a 40-athlete roster at 45 buttons or fewer', async () => {
    await renderLineup(largeRosterWorkspace());
    const rows = container.querySelectorAll('tr[role="option"]');
    expect(rows.length).toBeGreaterThanOrEqual(36);
    expect(buttons().length, names().join(' | ')).toBeLessThanOrEqual(45);
  });

  it('has no per-row Remove button', async () => {
    await renderLineup(largeRosterWorkspace());
    expect(names().filter(name => /^Remove /.test(name))).toEqual([]);
  });

  it('removes the selected athlete with the Delete key on the roster list', async () => {
    const onRequestDeleteSwimmer = vi.fn();
    await renderLineup(largeRosterWorkspace(), { onRequestDeleteSwimmer });
    const list = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toContain('Delete or Backspace to remove');
    // No selection yet: Delete does nothing.
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(onRequestDeleteSwimmer).not.toHaveBeenCalled();
    // ArrowDown selects the first row, Delete then asks to remove that athlete.
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const selectedName = container.querySelector('tr[role="option"][aria-selected="true"] td span')?.textContent;
    expect(selectedName).toBeTruthy();
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    expect(onRequestDeleteSwimmer).toHaveBeenCalledTimes(1);
    expect(onRequestDeleteSwimmer).toHaveBeenCalledWith(selectedName);
  });

  it('removes the selected athlete with Backspace on the roster list, and only when the list itself has focus', async () => {
    const onRequestDeleteSwimmer = vi.fn();
    await renderLineup(largeRosterWorkspace(), { onRequestDeleteSwimmer });
    const list = container.querySelector('[role="listbox"]') as HTMLElement;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    // A Backspace that starts inside a child (target is not the list) never removes anyone.
    const row = container.querySelector('tr[role="option"]') as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(onRequestDeleteSwimmer).not.toHaveBeenCalled();
    const selectedName = container.querySelector('tr[role="option"][aria-selected="true"] td span')?.textContent;
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(onRequestDeleteSwimmer).toHaveBeenCalledTimes(1);
    expect(onRequestDeleteSwimmer).toHaveBeenCalledWith(selectedName);
    expect(container.textContent).toMatch(/Delete\s*or\s*Backspace\s*to remove/);
  });

  it('points aria-activedescendant at the selected row, with a valid id that exists in the list', async () => {
    await renderLineup(largeRosterWorkspace());
    const list = container.querySelector('[role="listbox"]') as HTMLElement;
    expect(list.hasAttribute('aria-activedescendant')).toBe(false);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const activeId = list.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    expect(activeId).not.toMatch(/\s/);
    const target = container.querySelector(`[id="${activeId}"]`);
    expect(target?.getAttribute('role')).toBe('option');
    expect(target?.getAttribute('aria-selected')).toBe('true');
    // Row ids are unique.
    const ids = Array.from(container.querySelectorAll('tr[role="option"]')).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(id => !/\s/.test(id))).toBe(true);
    await act(async () => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(list.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('offers Remove from roster in the athlete drawer', async () => {
    const onRequestDeleteSwimmer = vi.fn();
    await renderLineup(largeRosterWorkspace(), { onRequestDeleteSwimmer });
    const row = container.querySelector('tr[role="option"]') as HTMLElement;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const remove = buttons().find(b => /^Remove .* from roster$/.test(b.getAttribute('aria-label') ?? ''));
    expect(remove, names().join(' | ')).toBeTruthy();
    await act(async () => {
      remove!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onRequestDeleteSwimmer).toHaveBeenCalledTimes(1);
  });

  it('hides the Swimmer tag when every row would show it', async () => {
    await renderLineup(largeRosterWorkspace());
    const rowText = Array.from(container.querySelectorAll('tr[role="option"]')).map(r => r.textContent ?? '');
    expect(rowText.length).toBeGreaterThan(0);
    expect(rowText.filter(text => text.includes('Swimmer') && !/Swimmer \d|Swimmer$/.test(text))).toEqual([]);
    // The tag is the text "Swimmer" on its own, not part of a name like "Extra Swimmer 03".
    const tags = Array.from(container.querySelectorAll('tr[role="option"] td:first-child *'))
      .filter(el => el.children.length === 0 && el.textContent === 'Swimmer');
    expect(tags).toHaveLength(0);
  });

  it('shows the tags again when a diver makes the roster mixed', async () => {
    await renderLineup(largeRosterWorkspace(34, 2));
    const tags = Array.from(container.querySelectorAll('tr[role="option"] td:first-child *'))
      .filter(el => el.children.length === 0 && (el.textContent === 'Swimmer' || el.textContent === 'Diver'));
    expect(tags.some(el => el.textContent === 'Diver')).toBe(true);
    expect(tags.some(el => el.textContent === 'Swimmer')).toBe(true);
  });
});

describe('roster view helpers', () => {
  it('isUniformSwimmerRoster is true only when no row is a recruit or diver', () => {
    const swimmer = { isRecruit: false, athleteRole: 'swimmer' as const };
    expect(isUniformSwimmerRoster([swimmer, swimmer])).toBe(true);
    expect(isUniformSwimmerRoster([swimmer, { isRecruit: true, athleteRole: 'swimmer' }])).toBe(false);
    expect(isUniformSwimmerRoster([swimmer, { isRecruit: false, athleteRole: 'diver' }])).toBe(false);
    expect(isUniformSwimmerRoster([])).toBe(false);
  });

  it('AthleteRoleTag can skip the Swimmer tag but never the Diver or Recruit tag', () => {
    const render = (props: Record<string, unknown>) => {
      const el = document.createElement('div');
      const r = createRoot(el);
      act(() => r.render(createElement(AthleteRoleTag, props as never)));
      const text = el.textContent;
      act(() => r.unmount());
      return text;
    };
    expect(render({ role: 'swimmer', hideSwimmer: true })).toBe('');
    expect(render({ role: 'swimmer' })).toBe('Swimmer');
    expect(render({ role: 'diver', hideSwimmer: true })).toBe('Diver');
    expect(render({ role: 'swimmer', isRecruit: true, hideSwimmer: true })).toBe('Recruit');
  });

  it('says "no scorer cap" for the 999 sentinel and names a real cap otherwise', () => {
    expect(scorerCapPhrase(999)).toBe('There is no scorer cap.');
    expect(scorerCapPhrase(1000)).toBe('There is no scorer cap.');
    expect(scorerCapPhrase(18)).toBe('Toggle scorers for the 18-scorer cap.');
  });
});

function checklistItem(partial: Partial<LineupChecklistItem> & { id: string }): LineupChecklistItem {
  return { type: 'entry_over_limit', group: 'entries', message: `Problem ${partial.id}`, ...partial } as LineupChecklistItem;
}

function auditOf(items: LineupChecklistItem[]): TeamLineupAudit {
  return { athleteIssues: new Map(), checklistItems: items, vacantRelayLegCount: 0 };
}

describe('Lineup checklist rows', () => {
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
  const jumps = () => Array.from(container.querySelectorAll('button')).filter(b => b.textContent === 'Jump');

  it('merges one athlete’s problems into one row with one Jump', () => {
    const rows = buildChecklistRows([
      checklistItem({ id: 'a1', athleteName: 'Ann', athleteKey: 'k-ann' }),
      checklistItem({ id: 'a2', athleteName: 'Ann', athleteKey: 'k-ann' }),
      checklistItem({ id: 'b1', athleteName: 'Bo', athleteKey: 'k-bo' }),
      checklistItem({ id: 'n1' }),
      checklistItem({ id: 'n2' }),
    ]);
    expect(rows.map(r => r.items.map(i => i.id))).toEqual([['a1', 'a2'], ['b1'], ['n1'], ['n2']]);
  });

  it('keeps relay-leg and duplicate items on their own rows', () => {
    const rows = buildChecklistRows([
      checklistItem({ id: 'r1', athleteName: 'Ann', athleteKey: 'k', relayEntryKey: 'rk', legIndex: 0 }),
      checklistItem({ id: 'r2', athleteName: 'Ann', athleteKey: 'k', relayEntryKey: 'rk', legIndex: 1 }),
      checklistItem({ id: 'e1', athleteName: 'Ann', athleteKey: 'k' }),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('holds rows past the limit behind Show more', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, items: [checklistItem({ id: `r${i}` })] }));
    expect(visibleChecklistRows(rows, false)).toMatchObject({ hidden: 12 - CHECKLIST_GROUP_ROW_LIMIT });
    expect(visibleChecklistRows(rows, false).shown).toHaveLength(CHECKLIST_GROUP_ROW_LIMIT);
    expect(visibleChecklistRows(rows, true)).toMatchObject({ hidden: 0 });
    expect(visibleChecklistRows(rows.slice(0, CHECKLIST_GROUP_ROW_LIMIT), false).hidden).toBe(0);
  });

  it('renders the body once, one Jump per athlete, and reveals the rest on request', async () => {
    const items = [
      // Ann has three problems: one row, one Jump.
      ...[1, 2, 3].map(n => checklistItem({ id: `ann-${n}`, athleteName: 'Ann', athleteKey: 'k-ann' })),
      // Twenty more athletes with one problem each.
      ...Array.from({ length: 20 }, (_, i) => checklistItem({ id: `s-${i}`, athleteName: `Swimmer ${i}`, athleteKey: `k-${i}` })),
    ];
    await act(async () => {
      root.render(
        createElement(LineupComplianceChecklist, { audit: auditOf(items), onJumpAthlete: () => undefined })
      );
    });
    // Ann plus four others shown; fifteen held back.
    expect(jumps()).toHaveLength(CHECKLIST_GROUP_ROW_LIMIT);
    const more = Array.from(container.querySelectorAll('button')).find(b => /^Show 16 more$/.test(b.textContent ?? ''));
    expect(more, Array.from(container.querySelectorAll('button')).map(b => b.textContent).join('|')).toBeTruthy();
    expect(more!.getAttribute('aria-expanded')).toBe('false');
    // Total buttons stay small even with 23 problems.
    expect(container.querySelectorAll('button').length).toBeLessThanOrEqual(8);
    // Ann's three messages sit under one Jump.
    expect(container.textContent).toContain('Problem ann-1');
    expect(container.textContent).toContain('Problem ann-3');

    await act(async () => {
      more!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(jumps()).toHaveLength(21);
    expect(more!.getAttribute('aria-expanded')).toBe('true');
    expect(more!.textContent).toBe('Show fewer');
  });

  it('jumps with the athlete key', async () => {
    const onJump = vi.fn();
    await act(async () => {
      root.render(
        createElement(LineupComplianceChecklist, {
          audit: auditOf([checklistItem({ id: 'x', athleteName: 'Ann', athleteKey: 'k-ann' })]),
          onJumpAthlete: onJump,
        })
      );
    });
    await act(async () => {
      jumps()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onJump).toHaveBeenCalledWith('Ann', 'k-ann');
  });
});

describe('Labels', () => {
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

  it('names the Lineup side tab Cross-course, not Arbitrage', async () => {
    const ws = buildMeetWorkspace();
    const bundle = scoringBundleFor(ws, false);
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(RosterLineupStep, {
            workspace: ws,
            gender: Gender.MEN,
            scoringBundle: bundle,
            scoringSettings: resolvedScoringSettings(ws),
            baselineByTeam: new Map(),
            projectedByTeam: new Map(),
            whatIfMode: true,
            removeSeniors: false,
            selectedTeam: HOME_TEAM,
            onUpdate: () => undefined,
          })
        )
      );
    });
    const tabLabels = Array.from(container.querySelectorAll('button')).map(b => (b.textContent ?? '').trim());
    expect(tabLabels).toContain('Cross-course');
    expect(tabLabels).not.toContain('Arbitrage');
  });

  it('titles the Optimize section Point opportunities', async () => {
    const ws = buildMeetWorkspace();
    await act(async () => {
      root.render(
        createElement(
          ToastProvider,
          null,
          createElement(RosterOptimizeStep, {
            workspace: ws,
            gender: Gender.MEN,
            scoringSettings: resolvedScoringSettings(ws),
            whatIfMode: true,
            removeSeniors: false,
            selectedTeam: HOME_TEAM,
            teams: [HOME_TEAM],
            onUpdate: () => undefined,
          })
        )
      );
    });
    const headings = Array.from(container.querySelectorAll('h4')).map(h => h.textContent ?? '');
    expect(headings.some(text => text.startsWith('Point opportunities'))).toBe(true);
    expect(container.textContent).not.toContain('Point arbitrage');
  });

  it('reads "projected vs prelims" beside "vs prelims", never a bare "Proj +x"', async () => {
    await act(async () => {
      root.render(
        createElement(MatrixProjectedActualScore, {
          compact: true,
          projected: 120,
          prelimsProjected: 100,
          baselineOverUnder: 5,
          projectedOverUnder: 20,
        })
      );
    });
    const text = container.textContent ?? '';
    expect(text).toContain('vs prelims +5.0');
    expect(text).toContain('projected vs prelims +20.0');
    expect(text).not.toMatch(/Proj \+/);
  });
});

describe('Metrics has one Open video call to action', () => {
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

  it('shows the header button once, as a real button, and an empty state without a second CTA', async () => {
    const noop = () => undefined;
    await act(async () => {
      root.render(
        createElement('div', null,
          createElement(MetricsHeader, {
            sessionCount: 0, showSessions: false, onToggleSessions: noop, canSave: false, onSaveSession: noop,
            canExport: false, onExportReport: noop, canReconfigure: false, onReconfigure: noop, onFileChange: noop,
          }),
          createElement(SetupStepPanel, {
            videoUrl: null,
            config: {} as never,
            swimmerName: '',
            rosterNames: [],
            onSwimmerNameChange: noop,
            onChange: noop,
            onConfirm: noop,
          })
        )
      );
    });
    const cta = Array.from(container.querySelectorAll('button, label, a')).filter(el => /open video/i.test(el.textContent ?? ''));
    // The empty-state description mentions "Open video", but only one control carries the label.
    const controls = cta.filter(el => el.tagName === 'BUTTON');
    expect(controls).toHaveLength(1);
    expect(container.querySelectorAll('label[for="metrics-file-input"]')).toHaveLength(0);
    expect(container.querySelectorAll('input#metrics-file-input')).toHaveLength(1);
    // The button opens the file picker through the hidden input.
    const input = container.querySelector('input#metrics-file-input') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);
    await act(async () => {
      controls[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar auto-collapse', () => {
  it('collapses below lg whatever the saved choice is, and follows the choice at lg and up', () => {
    expect(resolveSidebarCollapsed({ preference: false, narrow: true, narrowOpen: false })).toBe(true);
    expect(resolveSidebarCollapsed({ preference: true, narrow: true, narrowOpen: false })).toBe(true);
    expect(resolveSidebarCollapsed({ preference: false, narrow: true, narrowOpen: true })).toBe(false);
    expect(resolveSidebarCollapsed({ preference: false, narrow: false, narrowOpen: false })).toBe(false);
    expect(resolveSidebarCollapsed({ preference: true, narrow: false, narrowOpen: false })).toBe(true);
  });

  it('reads only the string "true" as collapsed', () => {
    expect(readSidebarPreference({ getItem: () => 'true' })).toBe(true);
    expect(readSidebarPreference({ getItem: () => 'false' })).toBe(false);
    expect(readSidebarPreference({ getItem: () => null })).toBe(false);
    expect(readSidebarPreference(null)).toBe(false);
  });

  describe('useSidebarCollapse', () => {
    let container: HTMLDivElement;
    let root: Root;
    let narrow = false;
    let listeners: Array<() => void> = [];
    let latest: ReturnType<typeof useSidebarCollapse>;
    const original = window.matchMedia;

    function Probe() {
      latest = useSidebarCollapse();
      return null;
    }

    beforeEach(() => {
      window.localStorage.clear();
      listeners = [];
      window.matchMedia = ((query: string) => ({
        get matches() {
          return narrow;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: (_: string, fn: () => void) => {
          listeners = listeners.filter(l => l !== fn);
        },
      })) as unknown as typeof window.matchMedia;
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
    });
    afterEach(() => {
      act(() => root.unmount());
      container.remove();
      window.matchMedia = original;
    });

    const setWidth = async (isNarrow: boolean) => {
      narrow = isNarrow;
      await act(async () => {
        listeners.forEach(fn => fn());
      });
    };

    it('starts collapsed at 800px and does not write the stored choice', async () => {
      narrow = true;
      await act(async () => {
        root.render(createElement(Probe));
      });
      expect(latest.collapsed).toBe(true);
      expect(latest.narrow).toBe(true);
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
    });

    it('opening it on a narrow screen is temporary and is not saved', async () => {
      narrow = true;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'false');
      await act(async () => {
        root.render(createElement(Probe));
      });
      await act(async () => {
        latest.toggle();
      });
      expect(latest.collapsed).toBe(false);
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('false');
      // Widening and narrowing again starts collapsed once more.
      await setWidth(false);
      await setWidth(true);
      expect(latest.collapsed).toBe(true);
    });

    it('returns to the saved choice when the window widens', async () => {
      narrow = true;
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, 'false');
      await act(async () => {
        root.render(createElement(Probe));
      });
      expect(latest.collapsed).toBe(true);
      await setWidth(false);
      expect(latest.collapsed).toBe(false);
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('false');
    });

    it('still saves the choice at lg and up', async () => {
      narrow = false;
      await act(async () => {
        root.render(createElement(Probe));
      });
      await act(async () => {
        latest.toggle();
      });
      expect(latest.collapsed).toBe(true);
      expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('true');
    });
  });
});
