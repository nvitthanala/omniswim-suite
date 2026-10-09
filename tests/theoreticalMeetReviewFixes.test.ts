// @vitest-environment happy-dom
/**
 * Review fixes on the theoretical-meet dialog:
 * - the division tag reads the capture's season (`divisionForTeamInSeason`), and unknown stays unknown;
 * - a removal that no longer matches a swimmer is said out loud, with the restore control;
 * - the removals of a team that a list reload drops are dropped with it;
 * - two fast Create clicks start one create.
 *
 * Provenance: the divisions come from the app's own table (`packages/core/src/data/teamDivisions.ts`). Lindenwood
 * is the one school there with a recorded division history (D2 through 2021-2022, D1 2022-2023 to 2023-2024, then
 * discontinued). The capture list and the team reads come from the committed fixtures
 * (`tests/theoreticalMeetUiFixtures.ts`). No competition value is typed here.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Gender, type Workspace } from '../packages/core/src/types';
import { divisionForTeamInSeason } from '../packages/core/src/data/teamDivisions';
import { PreviewStep } from '../packages/manager/src/components/theoreticalMeet/PreviewStep';
import { useTheoreticalMeetFlow, type TheoreticalMeetFlow } from '../packages/manager/src/components/theoreticalMeet/useTheoreticalMeetFlow';
import type { CaptureApi } from '../packages/manager/src/components/theoreticalMeet/captureApi';
import {
  DIVISION_VARIES_TEXT,
  describeUnmatchedRemovals,
  dropRemovalsForTeams,
  groupCaptures,
  removalFor,
  teamDivisionTag,
  type CaptureListRecord,
  type CaptureRow,
} from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import type { TheoreticalEventExclusion } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import { CAPTURE_IDS, fakeCaptureApi, fixtureRecords } from './theoreticalMeetUiFixtures';

// The shared stub builds a new component type on every property read; a cache keeps one per tag, as the real library does.
vi.mock('motion/react', async () => {
  const { motionStub } = await import('./motionStub');
  const cache = new Map<string, unknown>();
  const motion = new Proxy({}, { get: (_t, tag: string) => cache.get(tag) ?? (cache.set(tag, (motionStub.motion as Record<string, unknown>)[tag]), cache.get(tag)) });
  return { ...motionStub, motion };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = CAPTURE_IDS[0];
const B = CAPTURE_IDS[1];
const NOW = Date.parse('2026-10-20T12:00:00Z');

/* -------------------------------------------------------------------------- */
/* 5: the division tag reads the season                                        */
/* -------------------------------------------------------------------------- */

describe('teamDivisionTag with a capture season', () => {
  it('names the division the school held in that season, from the table history', () => {
    // The table is the source: the test reads it back through the core lookup, then pins the shape of the history.
    expect(divisionForTeamInSeason('Lindenwood University', '2021-2022')).toBe('D2');
    expect(divisionForTeamInSeason('Lindenwood University', '2022-2023')).toBe('D1');
    expect(teamDivisionTag('Lindenwood University', '2021-2022')).toMatchObject({ text: 'NCAA D2', division: 'D2' });
    expect(teamDivisionTag('Lindenwood University', '2022-2023')).toMatchObject({ text: 'NCAA D1', division: 'D1' });
  });

  it('says unknown, never D1, for a discontinued program in a season it did not compete', () => {
    expect(divisionForTeamInSeason('Lindenwood University', '2024-2025')).toBeNull();
    expect(teamDivisionTag('Lindenwood University', '2024-2025')).toMatchObject({ text: 'unknown division', division: null });
    // With no season, the table's current division is null for a discontinued program: unknown too.
    expect(teamDivisionTag('Lindenwood University')).toMatchObject({ text: 'unknown division', division: null });
    expect(teamDivisionTag('Lindenwood University', null)).toMatchObject({ text: 'unknown division', division: null });
  });

  it('says unknown for a season label that does not parse, and keeps no-season behaviour for a school without history', () => {
    expect(teamDivisionTag('Henderson State University', 'last year')).toMatchObject({ text: 'unknown division', division: null });
    expect(teamDivisionTag('Henderson State University', '2026-2027')).toMatchObject({ division: 'D2' });
    expect(teamDivisionTag('Henderson State University', null)).toEqual(teamDivisionTag('Henderson State University'));
    expect(teamDivisionTag('Nowhere Community College', '2026-2027')).toMatchObject({ text: 'unknown division', division: null });
    expect(teamDivisionTag(null, '2026-2027')).toMatchObject({ text: 'unknown division', division: null });
  });
});

describe('groupCaptures tags each capture by its season', () => {
  const rec = (season: string): CaptureListRecord => ({
    captureId: `team-9-${season}`,
    subject: { kind: 'team', teamId: '9', season },
    completeness: 'every-planned-page-fetched',
    plannedPageCount: 1,
    pages: [],
    updatedAt: '2026-10-19T00:00:00.000Z',
    teamName: 'Lindenwood University',
  });

  it('gives each row its own tag and flags a team whose seasons sit in different divisions', () => {
    const [g] = groupCaptures([rec('2021-2022'), rec('2022-2023')], NOW);
    expect(g.divisionVaries).toBe(true);
    expect(g.divisionTag).toMatchObject({ text: DIVISION_VARIES_TEXT, division: null });
    const bySeason = new Map(g.rows.map(r => [r.season, r.divisionTag.division]));
    expect(bySeason.get('2021-2022')).toBe('D2');
    expect(bySeason.get('2022-2023')).toBe('D1');
  });

  it('uses the one division when the seasons agree, and unknown for a season after the cut', () => {
    const [same] = groupCaptures([rec('2022-2023'), rec('2023-2024')], NOW);
    expect(same.divisionVaries).toBe(false);
    expect(same.divisionTag).toMatchObject({ text: 'NCAA D1', division: 'D1' });
    const [cut] = groupCaptures([rec('2025-2026')], NOW);
    expect(cut.divisionTag).toMatchObject({ text: 'unknown division', division: null });
  });
});

/* -------------------------------------------------------------------------- */
/* 2: unmatched removals                                                       */
/* -------------------------------------------------------------------------- */

describe('unmatched removals', () => {
  it('says nothing for none, and one plain sentence for some', () => {
    expect(describeUnmatchedRemovals(0)).toBeNull();
    expect(describeUnmatchedRemovals(1)).toMatch(/^1 removal no longer matches a swimmer and was not applied/);
    expect(describeUnmatchedRemovals(3)).toMatch(/^3 removals no longer match a swimmer and were not applied/);
  });

  const r = (teamName: string, event: string): TheoreticalEventExclusion => ({ teamName, gender: Gender.MEN, swimmerKey: 'sc:1', event });
  const all = { a1: r('Team A', '50 Free SCY'), a2: r(' team  a ', '100 Free SCY'), b1: r('Team B', '50 Free SCY') };

  it('drops the removals of a dropped team, compared by normalized name, and keeps the rest', () => {
    expect(Object.keys(dropRemovalsForTeams(all, ['Team A'], ['Team B']))).toEqual(['b1']);
  });

  it('keeps the removals of a team that another kept capture still carries', () => {
    expect(dropRemovalsForTeams(all, ['Team A'], ['Team A', 'Team B'])).toBe(all);
  });

  it('returns the same object when nothing is dropped', () => {
    expect(dropRemovalsForTeams(all, [], ['Team A'])).toBe(all);
    expect(dropRemovalsForTeams(all, ['Team C'], [])).toBe(all);
  });
});

/* -------------------------------------------------------------------------- */
/* The flow hook, driven through a probe                                       */
/* -------------------------------------------------------------------------- */

describe('the flow hook', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: TheoreticalMeetFlow;
  const NO_WORKSPACES: readonly Workspace[] = [];

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

  function mount(api: CaptureApi, restore: (w: Workspace) => Promise<Workspace> = async w => w) {
    const restoreWorkspace = vi.fn(restore);
    const onCreated = vi.fn();
    function Probe() {
      const flow = useTheoreticalMeetFlow({ api, workspaces: NO_WORKSPACES, restoreWorkspace, onCreated, now: () => Date.parse('2026-10-05T00:00:00Z') });
      latest = flow;
      const rows = new Map<string, CaptureRow>();
      for (const group of flow.groups) for (const row of group.rows) rows.set(row.captureId, row);
      return flow.step === 'preview' ? createElement(PreviewStep, { flow, captureRows: rows }) : null;
    }
    act(() => root.render(createElement(Probe)));
    return { restoreWorkspace, onCreated };
  }

  /** Pick the captures, choose NSISC scoring, open the preview and wait for it to be built. */
  async function openPreview(ids: readonly string[]) {
    await waitFor(() => latest.list.status === 'ready');
    for (const id of ids) await act(async () => latest.toggleCapture(id));
    await act(async () => latest.setScoringChoiceId('nsisc'));
    await act(async () => latest.setStep('preview'));
    await waitFor(() => latest.preview.status === 'ready');
  }

  it('6: two synchronous Create calls start one create', async () => {
    const { restoreWorkspace, onCreated } = mount(fakeCaptureApi());
    await openPreview([A]);
    await act(async () => {
      void latest.create();
      void latest.create();
    });
    await waitFor(() => onCreated.mock.calls.length > 0);
    await tick(50);
    expect(restoreWorkspace).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(latest.creating).toBe(false);
  });

  it('6: a second Create after the first finished is allowed (the guard is not stuck)', async () => {
    const { restoreWorkspace, onCreated } = mount(fakeCaptureApi());
    await openPreview([A]);
    await act(async () => {
      await latest.create();
    });
    await act(async () => {
      await latest.create();
    });
    expect(onCreated).toHaveBeenCalledTimes(2);
    expect(restoreWorkspace).toHaveBeenCalledTimes(2);
  });

  it('6: a failed create releases the guard', async () => {
    let calls = 0;
    const { onCreated } = mount(fakeCaptureApi(), async w => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return w;
    });
    await openPreview([A]);
    await act(async () => {
      await latest.create();
    });
    expect(latest.createProblem).not.toBeNull();
    await act(async () => {
      await latest.create();
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('2: a removal that matches no swimmer is shown as a status line, with the restore control', async () => {
    mount(fakeCaptureApi());
    await openPreview([A]);
    expect(document.querySelector('[data-testid="tmeet-unmatched-removals"]')).toBeNull();
    const built = latest.preview.status === 'ready' ? latest.preview.built : null;
    const team = built!.model.teams[0];
    // The key a swimmer had before a re-read changed it: same team, same event, a key no swimmer carries.
    const stale: TheoreticalEventExclusion = { teamName: team.teamName, gender: team.gender, swimmerKey: 'sc:99999999', event: team.swimmers[0].chosen[0].event };
    await act(async () => latest.toggleEventRemoval(stale));
    const line = await waitFor(() => document.querySelector('[data-testid="tmeet-unmatched-removals"]'));
    expect(line.textContent).toBe(describeUnmatchedRemovals(1));
    const restore = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Restore all removed events');
    expect(restore).toBeDefined();
    await act(async () => (restore as HTMLButtonElement).click());
    await waitFor(() => document.querySelector('[data-testid="tmeet-unmatched-removals"]') === null);
    expect(Object.keys(latest.removals)).toEqual([]);
  });

  it('2: a reload that drops a capture also drops the removals of its teams', async () => {
    const records = await fixtureRecords();
    let current: readonly CaptureListRecord[] = records;
    const base = fakeCaptureApi();
    const api: CaptureApi = { listCaptures: async () => current, parseCapture: id => base.parseCapture(id) };
    mount(api);
    await openPreview([A, B]);

    const model = latest.preview.status === 'ready' ? latest.preview.built.model : null;
    const teamA = model!.teams.find(t => t.swimmers.length > 0 && t.key.length > 0)!;
    const namesA = new Set(model!.teams.filter(t => t.teamName === teamA.teamName).map(t => t.teamName));
    const teamB = model!.teams.find(t => !namesA.has(t.teamName) && t.swimmers.some(s => s.chosen.length > 0))!;
    expect(teamB).toBeDefined();
    const swimmerA = teamA.swimmers.find(s => s.chosen.length > 0)!;
    const swimmerB = teamB.swimmers.find(s => s.chosen.length > 0)!;
    await act(async () => latest.toggleEventRemoval(removalFor(teamA, swimmerA, swimmerA.chosen[0].event)));
    await act(async () => latest.toggleEventRemoval(removalFor(teamB, swimmerB, swimmerB.chosen[0].event)));
    expect(Object.keys(latest.removals)).toHaveLength(2);

    // The crawl of capture A is no longer finished. A reload drops it from the selection.
    current = records.map(r => (r.captureId === A ? { ...r, completeness: 'in-progress' as const } : r));
    await act(async () => latest.reloadList());
    await waitFor(() => !latest.selected.includes(A));
    expect(latest.selected).toEqual([B]);
    await waitFor(() => Object.keys(latest.removals).length === 1);
    expect(Object.values(latest.removals).map(r => r.teamName)).toEqual([teamB.teamName]);
  });
});
