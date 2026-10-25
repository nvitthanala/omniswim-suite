// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The UI that lifts the "unconfirmed program swim" gate (2026-10-16).
 *
 * A SwimCloud swims-list row is stamped `programSwim: 'unconfirmed'`. It counts
 * toward no best time, cut tag or arbitrage until the coach confirms it. These
 * tests drive the real credited-swims panel against the real core editor
 * (`setCreditedSwimProgramStatus`) and check the badge, the buttons, the bulk
 * button, the reverse, the cut-tag wording and the import-notes line.
 *
 * Written without JSX, matching every other DOM-render test in this repo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender, type SwimmerResult, type Workspace } from '@omniswim/core/types';
import { buildHistoryFromWorkspace, categorizeBestEvents } from '@omniswim/core/lib/athleteHistory';
import { buildCutlineTagForTeam, cutlineSwimOfRecord } from '@omniswim/core/lib/cutlineTags';
import { getAthleteCreditedSwims, type AthleteCreditedSwim } from '@omniswim/core/lib/scorerRoster';
import { NSISC_PRESET_SETTINGS } from '@omniswim/core/lib/scoringDefaults';
import { CutlineTag } from '@omniswim/ui';
import AthleteCreditedSwimsPanel from '../packages/manager/src/components/AthleteCreditedSwimsPanel';
import AthleteHistorySection from '../packages/manager/src/components/AthleteHistorySection';
import { setCreditedSwimsProgramStatus } from '../packages/manager/src/lib/creditedSwimProgramStatus';
import { SwimCloudImportDiagnosticsPanel } from '../packages/matrix/src/components/SwimCloudImportDiagnosticsPanel';
import { applySwimCloudRows } from '../packages/matrix/src/lib/swimCloudMeetImportBridge';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import type { SwimCloudTeamMeetSwimsParse } from '../packages/swimcloud/src/parser';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HSU = 'Henderson State University';
const NAME = 'Avery Henke';
const NOT_CONFIRMED = 'Not confirmed as a program swim';
const CONFIRM = 'Confirm as program swim';
const MARK_NOT = 'Mark as not a program swim';

function row(over: Partial<SwimmerResult>): SwimmerResult {
  return {
    id: '999:swim:1',
    rank: 1,
    name: NAME,
    classYear: 'unknown',
    team: HSU,
    time: '54.09',
    points: 0,
    event: '100 Breaststroke',
    gender: Gender.MEN,
    timeType: 'SCY',
    ...over,
  } as SwimmerResult;
}

function workspaceOf(menResults: SwimmerResult[]): Workspace {
  return { id: 'ws', name: 'ws', menResults, womenResults: [], recruits: [], createdAt: 0 } as unknown as Workspace;
}

const TWO_UNCONFIRMED = () =>
  workspaceOf([
    row({ id: '999:swim:1', programSwim: 'unconfirmed' }),
    row({ id: '999:swim:2', event: '200 Breaststroke', time: '1:58.00', programSwim: 'unconfirmed' }),
  ]);

/** The panel wired the way the athlete drawer wires it: real core editor, held in component state. */
let latest: Workspace;
function Harness({ initial, editable }: { initial: Workspace; editable: boolean }) {
  const [ws, setWs] = useState(initial);
  latest = ws;
  const apply = (swims: AthleteCreditedSwim[], status: 'program' | 'unconfirmed') =>
    setWs(prev => ({
      ...prev,
      ...setCreditedSwimsProgramStatus(prev, Gender.MEN, swims.map(s => s.id), status).patch,
    }));
  const swims = getAthleteCreditedSwims(ws.menResults ?? [], HSU, NAME, Gender.MEN);
  return createElement(AthleteCreditedSwimsPanel, {
    athleteName: NAME,
    team: HSU,
    swims,
    totalPoints: 0,
    gender: Gender.MEN,
    deletable: editable,
    onSetProgramStatus: editable ? (swim, status) => apply([swim], status) : undefined,
    onConfirmAllProgramSwims: editable ? all => apply(all, 'program') : undefined,
  });
}

describe('credited swims panel: confirming program swims', () => {
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

  const render = (initial: Workspace, editable = true) =>
    act(() => {
      root.render(createElement(Harness, { initial, editable }));
    });
  const text = () => container.textContent ?? '';
  const buttons = (label: string) =>
    [...container.querySelectorAll('button')].filter(b => (b.textContent ?? '').includes(label));
  const count = (needle: string) => text().split(needle).length - 1;
  const tagState = () =>
    getAthleteCreditedSwims(latest.menResults ?? [], HSU, NAME, Gender.MEN).map(s =>
      buildCutlineTagForTeam({ team: HSU, gender: Gender.MEN, ...cutlineSwimOfRecord(s) }).state
    );

  it('shows the badge on each unconfirmed swim, with a Confirm button', () => {
    render(TWO_UNCONFIRMED());
    expect(count(NOT_CONFIRMED)).toBe(2);
    expect(buttons(CONFIRM)).toHaveLength(2);
    expect(buttons(MARK_NOT)).toHaveLength(0);
    expect(tagState()).toEqual(['program_unconfirmed', 'program_unconfirmed']);
  });

  it('Confirm clears the badge, and the swim then counts', () => {
    render(TWO_UNCONFIRMED());
    act(() => buttons(CONFIRM)[0]!.click());
    expect(count(NOT_CONFIRMED)).toBe(1);
    expect(buttons(CONFIRM)).toHaveLength(1);
    expect(buttons(MARK_NOT)).toHaveLength(1);
    expect(latest.menResults!.map(r => r.programSwim)).toEqual(['program', 'unconfirmed']);
    // The confirmed swim is judged against a table now; the other still is not.
    expect(tagState().filter(s => s === 'program_unconfirmed')).toHaveLength(1);
    // And it is evidence again: a best time exists only for the confirmed swim.
    const profile = categorizeBestEvents(
      buildHistoryFromWorkspace(latest),
      HSU,
      Gender.MEN,
      NAME,
      NSISC_PRESET_SETTINGS
    );
    expect(Object.keys(profile.bestByEvent)).toHaveLength(1);
  });

  it('bulk Confirm all N confirms every unconfirmed swim in one step', () => {
    render(TWO_UNCONFIRMED());
    const bulk = buttons('Confirm all 2 swims for this swimmer');
    expect(bulk).toHaveLength(1);
    act(() => bulk[0]!.click());
    expect(count(NOT_CONFIRMED)).toBe(0);
    expect(buttons(CONFIRM)).toHaveLength(0);
    expect(buttons('Confirm all')).toHaveLength(0);
    expect(buttons(MARK_NOT)).toHaveLength(2);
    expect(latest.menResults!.every(r => r.programSwim === 'program')).toBe(true);
    expect(tagState().includes('program_unconfirmed')).toBe(false);
  });

  it('Mark as not a program swim reverses a confirmation', () => {
    render(TWO_UNCONFIRMED());
    act(() => buttons('Confirm all')[0]!.click());
    act(() => buttons(MARK_NOT)[0]!.click());
    expect(count(NOT_CONFIRMED)).toBe(1);
    expect(buttons(CONFIRM)).toHaveLength(1);
    expect(latest.menResults!.map(r => r.programSwim)).toEqual(['unconfirmed', 'program']);
    expect(tagState().filter(s => s === 'program_unconfirmed')).toHaveLength(1);
  });

  it('shows no control on a swim with no stamp (a PDF or event-page row)', () => {
    render(workspaceOf([row({ id: 'pdf-1' })]));
    expect(count(NOT_CONFIRMED)).toBe(0);
    expect(buttons(CONFIRM)).toHaveLength(0);
    expect(buttons(MARK_NOT)).toHaveLength(0);
    expect(buttons('Confirm all')).toHaveLength(0);
  });

  it('read-only: keeps the badge and the count, offers no buttons', () => {
    render(TWO_UNCONFIRMED(), false);
    expect(count(NOT_CONFIRMED)).toBe(2);
    expect(buttons(CONFIRM)).toHaveLength(0);
    expect(buttons('Confirm all')).toHaveLength(0);
    expect(text()).toContain('Turn on What-if to confirm them');
  });
});

describe('setCreditedSwimsProgramStatus', () => {
  it('is one patch with one exact inverse for the whole set', () => {
    const ws = TWO_UNCONFIRMED();
    const { patch, inverse } = setCreditedSwimsProgramStatus(ws, Gender.MEN, ['999:swim:1', '999:swim:2'], 'program');
    expect(patch.menResults!.map(r => r.programSwim)).toEqual(['program', 'program']);
    expect({ ...ws, ...patch, ...inverse }.menResults).toEqual(ws.menResults);
  });

  it('raises on an empty set and on an id the workspace does not hold', () => {
    const ws = TWO_UNCONFIRMED();
    expect(() => setCreditedSwimsProgramStatus(ws, Gender.MEN, [], 'program')).toThrow(/no swims/);
    expect(() => setCreditedSwimsProgramStatus(ws, Gender.MEN, ['nope'], 'program')).toThrow(/no result row/);
  });
});

describe('an unconfirmed cut tag', () => {
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

  it('reads "Unconfirmed program swim" with the reason as its title, even compact', () => {
    const result = buildCutlineTagForTeam({
      team: HSU,
      gender: Gender.MEN,
      ...cutlineSwimOfRecord(row({ programSwim: 'unconfirmed' })),
    });
    expect(result.state).toBe('program_unconfirmed');
    act(() => {
      root.render(createElement(CutlineTag, { result, compact: true }));
    });
    const badge = container.querySelector('span') as HTMLElement;
    expect(badge.textContent).toBe('Unconfirmed program swim');
    expect(badge.title).toMatch(/not confirmed as a program swim/);
    expect(badge.title).toMatch(/post-meet time trial/);
    expect(badge.textContent).not.toMatch(/no cut/i);
  });

  it('the athlete history list passes the flag on, so a flagged row is not judged', async () => {
    const athlete = { key: 'k', name: NAME, team: HSU } as unknown as ScorerRosterRow;
    const rows = [
      { id: 'a', name: NAME, team: HSU, gender: Gender.MEN, event: '100 Breaststroke', time: '54.09', timeType: 'SCY', source: 'paste', meetLabel: 'flagged', programUnconfirmed: true as const },
      { id: 'b', name: NAME, team: HSU, gender: Gender.MEN, event: '100 Breaststroke', time: '54.09', timeType: 'SCY', source: 'paste', meetLabel: 'plain' },
    ];
    await act(async () => {
      root.render(
        createElement(AthleteHistorySection, {
          rows,
          athlete,
          gender: Gender.MEN,
          editable: false,
          applyPatch: () => undefined,
        } as never)
      );
    });
    const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    const items = [...container.querySelectorAll('li')];
    const textOf = (meet: string) => items.find(el => el.textContent?.includes(meet))?.textContent ?? '';
    expect(textOf('flagged')).toContain('Unconfirmed program swim');
    expect(textOf('flagged')).not.toContain('CUT');
    expect(textOf('plain')).toContain('D2 B CUT');
  });
});

describe('import notes: swims awaiting confirmation', () => {
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

  const show = (unconfirmedSwimCount?: number) =>
    act(() => {
      root.render(
        createElement(SwimCloudImportDiagnosticsPanel, { skipped: [], unconfirmedSwimCount, onDismiss: () => undefined })
      );
    });

  it('says how many swims await confirmation, even with no skips or warnings', () => {
    show(3);
    expect(container.querySelector('[data-testid="unconfirmed-swims-note"]')?.textContent).toContain(
      '3 swims await confirmation as program swims.'
    );
    expect(container.textContent).not.toContain('Nothing here needs a look');
  });

  it('uses the singular for one swim, and renders nothing for none', () => {
    show(1);
    expect(container.textContent).toContain('1 swim awaits confirmation as a program swim.');
    show(0);
    expect(container.textContent).toBe('');
  });

  it('applySwimCloudRows reports the count for the whole meet', async () => {
    const swim = (id: string) => ({
      swimKey: `999:swim:${id}`,
      swimCloudSwimId: id,
      event: {
        eventId: `evt-${id}`,
        swimCloudMeetId: '999',
        label: '100 Y Breast',
        kind: 'individual',
        course: 'SCY',
        gender: 'Men',
        distance: 100,
        stroke: 'Breaststroke',
      },
      entry: { entryId: `entry-${id}`, eventId: `evt-${id}`, athleteName: `Test Swimmer ${id}`, teamName: HSU },
      result: { resultId: `result-${id}`, entryId: `entry-${id}`, eventId: `evt-${id}`, place: 1, finalTime: '58.00' },
      relayLeadoff: false,
      cutStandards: [],
    });
    const parse = {
      swimCloudMeetId: '999',
      meetName: 'Test Championships',
      meet: { swimCloudMeetId: '999', name: 'Test Championships', format: 'unknown', ruleset: 'unknown', course: 'unknown' },
      gender: 'Men',
      swims: [swim('1'), swim('2')],
      events: [],
      rowCount: 2,
    } as unknown as SwimCloudTeamMeetSwimsParse;
    const result = await applySwimCloudRows([parse], workspaceOf([]), () => undefined, {
      resolveKeepRecruits: () => true,
    });
    expect(result.unconfirmedProgramSwimCount).toBe(2);
    const empty = await applySwimCloudRows([], workspaceOf([]), () => undefined);
    expect(empty.unconfirmedProgramSwimCount).toBe(0);
  });
});
