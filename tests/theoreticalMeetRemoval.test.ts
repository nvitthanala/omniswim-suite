// @vitest-environment happy-dom
/**
 * T2, the view and the dialog half: removing and restoring a chosen event in the Preview step.
 *
 * - The view model (`buildPreviewModel`) reads the builder's `excludedEvents` result: removed events, the
 *   event that fills the slot, a freed slot nothing fills, a swimmer whose every event was removed.
 * - `createMeet` keeps the removals when it rebuilds under a fresh workspace id.
 * - The no-seed text: an exhibition-only swimmer is told so.
 * - The dialog: a visible Remove button on every chosen event, Restore on a removed one, focus moves to
 *   the opposite button, a status line says what changed, and a removal is dropped when the field changes.
 *
 * The capture API is faked over the committed fixtures (tests/theoreticalMeetUiFixtures.ts).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../packages/core/src/types';
import { TheoreticalMeetDialogContent } from '../packages/manager/src/components/theoreticalMeet/TheoreticalMeetDialog';
import { buildMeet, createMeet, readTeamCapture, type BuildMeetArgs } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetFlow';
import {
  NO_SEED_TEXT,
  describeNoSeedReason,
  removalFor,
  removalKey,
  toggleRemoval,
  type PreviewSwimmer,
  type PreviewTeamRow,
} from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import type { TheoreticalNoSeedAthlete } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { fakeCaptureApi, CAPTURE_IDS } from './theoreticalMeetUiFixtures';

// The shared stub builds a new component type on every property read, so every render of the dialog would
// remount the Preview step and drop its focus. A cache keeps one component per tag, as the real library does.
vi.mock('motion/react', async () => {
  const { motionStub } = await import('./motionStub');
  const cache = new Map<string, unknown>();
  const motion = new Proxy({}, { get: (_t, tag: string) => cache.get(tag) ?? (cache.set(tag, (motionStub.motion as Record<string, unknown>)[tag]), cache.get(tag)) });
  return { ...motionStub, motion };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = CAPTURE_IDS[0];
const api = fakeCaptureApi();
const results: Record<string, Awaited<ReturnType<typeof readTeamCapture>>> = {};
const records = await api.listCaptures();
for (const id of CAPTURE_IDS) results[id] = await readTeamCapture(api, id, records);

const args: BuildMeetArgs = { captureIds: [A], resultsByCaptureId: results, scoringChoiceId: 'nsisc' };
const base = buildMeet(args, 'ws-removal-1', 1);

/** A swimmer with at least 8 offered events, so a removal has an event to refill it. */
function pickSwimmer(): { team: PreviewTeamRow; swimmer: PreviewSwimmer; offered: number } {
  for (const team of base.model.teams) {
    for (const swimmer of team.swimmers) {
      const source = base.seeds.report.teams
        .flatMap(t => t.eventsChosenPerSwimmer)
        .find(s => s.swimmerKey === swimmer.swimmerKey && s.name === swimmer.name)!;
      if (source.events.length > swimmer.chosen.length && swimmer.chosen.length >= 2) return { team, swimmer, offered: source.events.length };
    }
  }
  throw new Error('no fixture swimmer has an event left out by the cap');
}
const picked = pickSwimmer();

describe('the no-seed text', () => {
  it('has a sentence for every reason the builder can give', () => {
    const reasons: TheoreticalNoSeedAthlete['reason'][] = [
      'no_usable_swim',
      'diving_not_supported',
      'no_swim_in_meet_course',
      'no_event_in_program',
      'all_seeds_exhibition_excluded',
    ];
    expect(Object.keys(NO_SEED_TEXT).sort()).toEqual([...reasons].sort());
  });

  it('tells an exhibition-only swimmer so, and names the dropped events', () => {
    const text = describeNoSeedReason({ name: 'X', reason: 'all_seeds_exhibition_excluded', excludedExhibitionEvents: ['100 IM SCY', '50 Free SCY'] });
    expect(text).toMatch(/exhibition/);
    expect(text).toContain('100 IM SCY, 50 Free SCY');
    expect(text).not.toMatch(/no swim in an event/);
  });

  it('does not call any other reason exhibition', () => {
    for (const reason of ['no_usable_swim', 'diving_not_supported', 'no_swim_in_meet_course', 'no_event_in_program'] as const) {
      expect(describeNoSeedReason({ name: 'X', reason })).not.toMatch(/exhibition/);
      // An exhibition list beside another reason does not change that reason's words.
      expect(describeNoSeedReason({ name: 'X', reason, excludedExhibitionEvents: ['100 IM SCY'] })).toBe(NO_SEED_TEXT[reason]);
    }
  });

  it('keeps no sentence that says the exhibition flag is missing or read-only', () => {
    const dir = join(import.meta.dirname, '..', 'packages', 'manager', 'src', 'components', 'theoreticalMeet');
    for (const file of ['PreviewStep.tsx', 'ScoringStep.tsx', 'TheoreticalMeetBanner.tsx', 'theoreticalMeetView.ts']) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source, file).not.toMatch(/read-only in this version/);
      expect(source, file).not.toMatch(/EXHIBITION_CAVEAT/);
      expect(source, file).not.toMatch(/flag (does not|is not|has not)/i);
    }
  });
});

describe('the preview model with a removal', () => {
  const removal = removalFor(picked.team, picked.swimmer, picked.swimmer.chosen[0].event);
  const built = buildMeet({ ...args, excludedEvents: [removal] }, 'ws-removal-1', 1);
  const team = built.model.teams.find(t => t.key === picked.team.key)!;
  const swimmer = team.swimmers.find(s => s.swimmerKey === picked.swimmer.swimmerKey)!;

  it('lists the removed event for restoring, and no longer lists it as chosen', () => {
    expect(swimmer.removedByUser.map(e => e.event)).toEqual([removal.event]);
    expect(swimmer.removedByUser[0].freedSlot).toBe(true);
    expect(swimmer.chosen.map(e => e.event)).not.toContain(removal.event);
    expect(swimmer.chosen.length).toBe(picked.swimmer.chosen.length);
  });

  it('shows the replacement event, once, and nothing else as a replacement', () => {
    const fills = swimmer.chosen.filter(e => e.fillsRemovedSlot);
    expect(fills.length).toBe(1);
    expect(picked.swimmer.chosen.map(e => e.event)).not.toContain(fills[0].event);
    expect(swimmer.unfilledSlots).toBe(0);
    expect(swimmer.leftOutByCap).toBe(picked.swimmer.leftOutByCap - 1);
  });

  it('counts the removal per team and over the meet, and states it in the caveats', () => {
    expect(team.eventsRemovedByUser).toBe(1);
    expect(built.model.eventsRemovedByUser).toBe(1);
    expect(built.model.unmatchedRemovals).toBe(0);
    expect(built.model.caveats.some(c => /removed by you/.test(c))).toBe(true);
    expect(base.model.caveats.some(c => /removed by you/.test(c))).toBe(false);
    expect(built.model.totalRows).toBe(base.model.totalRows);
  });

  it('keeps a swimmer whose every event was removed, so the events can be restored', () => {
    const all = base.seeds.report.teams
      .flatMap(t => t.eventsChosenPerSwimmer)
      .find(s => s.swimmerKey === picked.swimmer.swimmerKey && s.name === picked.swimmer.name)!;
    const removals = all.events.map(e => removalFor(picked.team, picked.swimmer, e.event));
    const none = buildMeet({ ...args, excludedEvents: removals }, 'ws-removal-1', 1);
    const row = none.model.teams.find(t => t.key === picked.team.key)!.swimmers.find(s => s.swimmerKey === picked.swimmer.swimmerKey)!;
    expect(row.chosen).toEqual([]);
    expect(row.removedByUser.length).toBe(all.events.length);
    expect(row.unfilledSlots).toBe(picked.swimmer.chosen.length);
    expect(none.model.totalRows).toBe(base.model.totalRows - picked.swimmer.chosen.length);
  });

  it('toggles a removal on and off by one key', () => {
    const on = toggleRemoval({}, removal);
    expect(Object.keys(on)).toEqual([removalKey(removal)]);
    expect(toggleRemoval(on, removal)).toEqual({});
    expect(toggleRemoval(on, { ...removal, event: 'other event' })).toHaveProperty([removalKey({ ...removal, event: 'other event' })]);
  });
});

describe('createMeet keeps the removals when the id is taken', () => {
  it('rebuilds under a fresh id with the same events removed', async () => {
    const removal = removalFor(picked.team, picked.swimmer, picked.swimmer.chosen[0].event);
    const withRemoval: BuildMeetArgs = { ...args, excludedEvents: [removal] };
    const preview = buildMeet(withRemoval, 'taken-id', 1);
    const restore = vi.fn(async (w: Workspace) => w);
    const { workspace } = await createMeet({ restoreWorkspace: restore, existingWorkspaceIds: () => ['taken-id'], newId: () => 'fresh-id' }, withRemoval, preview);
    expect(workspace.id).toBe('fresh-id');
    const rows = [...workspace.menResults, ...workspace.womenResults].filter(r => r.name === picked.swimmer.name);
    expect(rows.some(r => r.event === removal.event)).toBe(false);
    expect(rows.length).toBe(picked.swimmer.chosen.length);
  });
});

describe('the dialog', () => {
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

  const tick = (ms = 20) =>
    act(async () => {
      await new Promise(resolve => setTimeout(resolve, ms));
    });
  async function waitFor<T>(read: () => T | null | undefined | false, timeout = 15_000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const value = read();
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(`waitFor timed out. Text: ${document.body.textContent?.slice(0, 500)}`);
      await tick();
    }
  }
  const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
  const byLabel = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  const button = (name: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === name) as HTMLButtonElement | undefined;
  const click = (el: Element) =>
    act(async () => {
      (el as HTMLElement).click();
    });
  const choose = (select: HTMLSelectElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

  async function openPreview() {
    act(() => {
      root.render(
        createElement(TheoreticalMeetDialogContent, {
          api: fakeCaptureApi(),
          workspaces: [{ id: 'existing', name: 'existing', menResults: [], womenResults: [] }] as unknown as Workspace[],
          restoreWorkspace: async (w: Workspace) => w,
          onCreated: () => undefined,
          onClose: () => undefined,
          now: () => Date.parse('2026-10-05T00:00:00Z'),
        })
      );
    });
    await waitFor(() => q(`input[id="tmeet-capture-${A}"]`));
    await click(q(`input[id="tmeet-capture-${A}"]`)!);
    await click(button('Next')!);
    await choose(q<HTMLSelectElement>('#tmeet-scoring-select')!, 'nsisc');
    // These tests are about individual events. Relays are on by default and take entry capacity, so switch them off.
    await click(q<HTMLInputElement>('#tmeet-relays')!);
    await click(button('Next')!);
    await waitFor(() => {
      const b = button('Create theoretical meet');
      return b && !b.disabled ? b : null;
    });
    // Open every team so the chips are in the document.
    for (const summary of document.body.querySelectorAll('button[aria-expanded="false"]')) await click(summary);
  }

  const removeLabel = `Remove ${picked.swimmer.chosen[0].event} for ${picked.swimmer.name}`;
  const restoreLabel = `Restore ${picked.swimmer.chosen[0].event} for ${picked.swimmer.name}`;

  it('shows a visible, named Remove button on every chosen event, and no read-only note', async () => {
    await openPreview();
    const removeButtons = [...document.body.querySelectorAll<HTMLButtonElement>('button[data-tmeet-toggle$="|remove"]')];
    expect(removeButtons.length).toBe(base.model.totalRows);
    for (const b of removeButtons) {
      expect(b.textContent).toContain('Remove');
      expect(b.getAttribute('aria-label')).toMatch(/^Remove .+ for .+/);
      expect(b.disabled).toBe(false);
    }
    expect(byLabel(removeLabel)).not.toBeNull();
    expect(document.body.textContent).not.toContain('read-only');
  });

  it('removes an event, shows the replacement and "removed by you", moves focus, and restores it', async () => {
    await openPreview();
    const before = document.body.querySelectorAll('button[data-tmeet-toggle$="|remove"]').length;
    await click(byLabel(removeLabel)!);

    const restore = await waitFor(() => byLabel(restoreLabel));
    expect(byLabel(removeLabel)).toBeNull();
    expect(document.activeElement).toBe(restore);
    expect(document.body.textContent).toContain('removed by you');
    expect(document.body.textContent).toContain('in place of a removed event');
    expect(q('[role="status"]')?.textContent).toBe(`Removed ${picked.swimmer.chosen[0].event} for ${picked.swimmer.name}.`);
    expect(document.body.textContent).toContain('You removed 1 event.');
    // The slot was refilled, so the number of entries does not change.
    expect(document.body.querySelectorAll('button[data-tmeet-toggle$="|remove"]').length).toBe(before);
    expect(document.body.textContent).toContain(`${base.model.totalRows} entries`);

    await click(restore);
    const remove = await waitFor(() => byLabel(removeLabel));
    expect(byLabel(restoreLabel)).toBeNull();
    expect(document.activeElement).toBe(remove);
    expect(document.body.textContent).not.toContain('removed by you');
    expect(document.body.textContent).not.toContain('in place of a removed event');
    expect(q('[role="status"]')?.textContent).toBe(`Restored ${picked.swimmer.chosen[0].event} for ${picked.swimmer.name}.`);
  });

  it('works from the keyboard: the buttons are real buttons in the tab order', async () => {
    await openPreview();
    const remove = byLabel(removeLabel)!;
    expect(remove.tagName).toBe('BUTTON');
    expect(remove.tabIndex).toBe(0);
    expect(remove.type).toBe('button');
  });

  it('offers "Restore all removed events" and clears every removal', async () => {
    await openPreview();
    expect(button('Restore all removed events')).toBeUndefined();
    await click(byLabel(removeLabel)!);
    await waitFor(() => byLabel(restoreLabel));
    await click(button('Restore all removed events')!);
    await waitFor(() => byLabel(removeLabel));
    expect(document.body.textContent).not.toContain('removed by you');
    expect(button('Restore all removed events')).toBeUndefined();
  });

  it('drops the removals when the exhibition switch changes', async () => {
    await openPreview();
    await click(byLabel(removeLabel)!);
    await waitFor(() => byLabel(restoreLabel));
    await click(button('Back')!);
    await click(q<HTMLInputElement>('#tmeet-exhibition')!);
    await click(button('Next')!);
    await waitFor(() => {
      const b = button('Create theoretical meet');
      return b && !b.disabled ? b : null;
    });
    expect(document.body.textContent).not.toContain('removed by you');
    expect(document.body.textContent).not.toContain('You removed');
  });
});
