// @vitest-environment happy-dom
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A theoretical meet's relay leg time is a labelled estimate, never a split (improvement plan A7).
 *
 * Decision (architect and user, 2026-10-13): a saved theoretical relay row does not hold its estimated
 * leg time in `relayLegSplit`. `relayLegSplit` stays absent and the estimate sits in `relayLegEstimate`
 * `{ time, basis, startAdjustmentSec? }`. A reader that shows a leg time shows the estimate with the word
 * "Estimate". A reader that scores or credits a leg never reads the estimate as a measured split.
 *
 * CONSTRUCTED: three teams of four, each swimmer with only a 50 Free (so only the 200 Free Relay forms).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Gender } from '../../packages/core/src/types';
import type { SwimmerResult, Workspace } from '../../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../../packages/core/src/lib/scoringDefaults';
import { buildScoringSnapshot } from '../../packages/core/src/lib/scoringEngine';
import { simulateRoster } from '../../packages/core/src/lib/utils';
import {
  RELAY_LEG_ESTIMATE_LABEL,
  hasRelayLegTime,
  normalizeSwimmerResultRelayFields,
  normalizeTheoreticalRelayLegEstimate,
  relayLegEstimateOf,
  relayLegTimeView,
} from '../../packages/core/src/lib/relaySplits';
import { getAthleteCreditedSwims } from '../../packages/core/src/lib/scorerRoster';
import { compareRelayLegSplits } from '../../packages/core/src/lib/relayBuilder';
import { THEORETICAL_RELAY_LEG_ROW_ID_PREFIX, isTheoreticalRelayLegRowId } from '../../packages/core/src/lib/theoreticalMeetLabel';
import { createWorkspaceSchema } from '../../packages/core/src/schemas/workspace';
import { insertResultsRows } from '../packages/db/src/workspacePersistence';
import { buildTheoreticalMeetSeeds, type TheoreticalMeetInput, type TheoreticalMeetTeamInput } from '../packages/manager/src/lib/theoreticalMeetSeeds';
import {
  THEORETICAL_LEG_ESTIMATE_BASIS,
  buildTheoreticalMeetWorkspace,
} from '../packages/manager/src/lib/theoreticalMeetWorkspace';
import RelayGroupCard from '../packages/manager/src/components/RelayGroupCard';
import { buildRelayGroups } from '../packages/manager/src/components/indRelayGroupsView';
import { buildPrintCards } from '../packages/manager/src/components/printCardsView';
import { buildStaticReportHtml } from '../packages/manager/src/lib/staticReportHtml';
import { SwimTimeCell } from '../packages/matrix/src/components/matrixPresentation';
import { buildTeamRowCutlineTags } from '../packages/matrix/src/components/teamCardView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FREE50: Record<string, Record<string, string>> = {
  'Alpha University': { A1: '20.00', A2: '20.50', A3: '21.00', A4: '21.50' },
  'Beta University': { B1: '20.20', B2: '20.70', B3: '21.20', B4: '21.70' },
  'Gamma University': { G1: '20.40', G2: '20.90', G3: '21.40', G4: '21.90' },
};

const teams = (): TheoreticalMeetTeamInput[] =>
  Object.entries(FREE50).map(([teamName, swimmers]) => ({
    teamName,
    gender: Gender.MEN,
    rosterStatus: 'parsed' as const,
    athletes: Object.entries(swimmers).map(([name, time]) => ({
      athlete: { name, swimCloudSwimmerId: `${teamName}:${name}`, classYear: name === 'A2' ? 'SR' : 'JR', gender: 'Men' as const },
      swims: [{ name, team: teamName, gender: Gender.MEN, event: '50 Free SCY', time, timeType: 'SCY' as const, source: 'swimcloud' as const }],
    })),
  }));

function buildWorkspace(over: Partial<TheoreticalMeetInput> = {}): Workspace {
  const seeds = buildTheoreticalMeetSeeds({
    meetId: 'ws-a7',
    course: 'SCY',
    scoringSettings: NSISC_PRESET_SETTINGS,
    conference: 'NSISC',
    includeRelays: true,
    teams: teams(),
    ...over,
  });
  const built = buildTheoreticalMeetWorkspace({ workspaceId: 'ws-a7', createdAt: 1, seeds, scoringSettings: NSISC_PRESET_SETTINGS, conference: 'NSISC' });
  return built.payload as unknown as Workspace;
}

const relayLegs = (ws: Workspace): SwimmerResult[] => ws.menResults.filter(r => r.isRelay === true);

describe('the builder writes the estimate and leaves relayLegSplit absent', () => {
  const ws = buildWorkspace();
  const alpha = relayLegs(ws).filter(r => r.team === 'Alpha University');

  it('has no relayLegSplit key on any theoretical relay row', () => {
    const legs = relayLegs(ws);
    expect(legs).toHaveLength(12);
    for (const row of legs) {
      expect(row.relayLegSplit, row.id).toBeUndefined();
      expect('relayLegSplit' in row, row.id).toBe(false);
      expect(isTheoreticalRelayLegRowId(row.id)).toBe(true);
    }
  });

  it('holds the leg time in relayLegEstimate, with a plain basis', () => {
    expect(alpha.map(r => r.relayLegEstimate)).toEqual([
      { time: 20, basis: THEORETICAL_LEG_ESTIMATE_BASIS.flatStartBest },
      { time: 20.5, basis: THEORETICAL_LEG_ESTIMATE_BASIS.noAdjustment },
      { time: 21, basis: THEORETICAL_LEG_ESTIMATE_BASIS.noAdjustment },
      { time: 21.5, basis: THEORETICAL_LEG_ESTIMATE_BASIS.noAdjustment },
    ]);
  });

  it('records the start adjustment on legs 2 to 4 only when one was applied', () => {
    const adjusted = buildWorkspace({ relayFlyingStartAdjustmentSec: { 50: 0.4 } });
    const legs = relayLegs(adjusted).filter(r => r.team === 'Alpha University');
    expect(legs.map(r => r.relayLegEstimate)).toEqual([
      { time: 20, basis: THEORETICAL_LEG_ESTIMATE_BASIS.flatStartBest },
      { time: 20.1, basis: THEORETICAL_LEG_ESTIMATE_BASIS.startAdjusted, startAdjustmentSec: 0.4 },
      { time: 20.6, basis: THEORETICAL_LEG_ESTIMATE_BASIS.startAdjusted, startAdjustmentSec: 0.4 },
      { time: 21.1, basis: THEORETICAL_LEG_ESTIMATE_BASIS.startAdjusted, startAdjustmentSec: 0.4 },
    ]);
    expect(legs.every(r => r.relayLegSplit === undefined)).toBe(true);
  });

  it('never sets the field on an individual row', () => {
    expect(ws.menResults.filter(r => r.isRelay !== true).every(r => r.relayLegEstimate === undefined)).toBe(true);
  });

  it('survives the create schema and the row store (the field is not stripped on save)', () => {
    const body = createWorkspaceSchema.parse({ name: 'x', menResults: ws.menResults });
    const rows = insertResultsRows('ws-a7', (body.menResults ?? []) as unknown as SwimmerResult[], 'Men');
    const back = rows.map(r => JSON.parse(r.data) as SwimmerResult).filter(r => r.isRelay === true && r.team === 'Alpha University');
    expect(back.map(r => r.relayLegEstimate?.time)).toEqual([20, 20.5, 21, 21.5]);
    expect(back.every(r => r.relayLegSplit === undefined)).toBe(true);
  });
});

describe('scoring does not read the estimate', () => {
  const ws = buildWorkspace();

  it('totals and places are identical with the estimates removed from every row', () => {
    const stripped: Workspace = {
      ...ws,
      menResults: ws.menResults.map(r => {
        const { relayLegEstimate: _e, ...rest } = r;
        void _e;
        return rest;
      }),
    };
    const a = buildScoringSnapshot(ws, Gender.MEN, false).baseline;
    const b = buildScoringSnapshot(stripped, Gender.MEN, false).baseline;
    expect(a.sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual(b.sortedTeams.map(t => [t.teamName, t.totalPoints]));
    expect(a.allScored.map(r => [r.id, r.rank, r.points])).toEqual(b.allScored.map(r => [r.id, r.rank, r.points]));
    // The hand sum of tests/theoreticalMeetRelays.test.ts: 54 + 40, 48 + 34, 43 + 32.
    expect(a.sortedTeams.map(t => [t.teamName, t.totalPoints])).toEqual([
      ['Alpha University', 94],
      ['Beta University', 82],
      ['Gamma University', 75],
    ]);
  });

  it('a departed leg is taken off at its estimate: the vacated leg holds estimate + 3.0 s, as the split did', () => {
    // A2 (leg 2, estimate 20.50) leaves, and no replacement is named. simulateRoster's placeholder is the
    // departed leg time + 3.0. With the old stored split that was 23.50. The estimate keeps it so.
    const out = simulateRoster(ws.menResults, [], false, new Set(['a2']));
    const leg2 = out.find(r => r.isRelay === true && r.team === 'Alpha University' && r.relayLegIndex === 1) as SwimmerResult;
    expect(leg2.relayLegVacant).toBe(true);
    expect(leg2.relayLegSplit).toBe('23.50');
    // The vacant row does not keep the departed swimmer's estimate.
    expect(leg2.relayLegEstimate).toBeUndefined();
    // The three legs that did not change keep theirs, and the team clock is the old clock + 3.0.
    const kept = out.filter(r => r.isRelay === true && r.team === 'Alpha University' && r.relayLegIndex !== 1);
    expect(kept.map(r => r.relayLegEstimate?.time)).toEqual([20, 21, 21.5]);
    expect(kept.every(r => r.relayLegSplit === undefined || r.relayLegSplit === leg2.relayLegSplit)).toBe(true);
    expect(leg2.relayTeamTime).toBe('1:26.00');
  });
});

describe('a roster simulation of a theoretical relay shows no unlabelled leg time', () => {
  const ws = buildWorkspace();
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('has no team split summary after a swimmer leaves, and the card prints no bare leg time', () => {
    const out = simulateRoster(ws.menResults, [], false, new Set(['a2']));
    const alpha = out.filter(r => r.isRelay === true && r.team === 'Alpha University');
    expect(alpha).toHaveLength(4);
    // The summary would have read "L2 23.50 | team 1:26.00": a vacancy placeholder with no label.
    expect(alpha.every(r => r.relayTeamSplits === undefined)).toBe(true);
    const groups = buildRelayGroups({ allScored: alpha, originalResults: relayLegs(ws), gender: Gender.MEN, team: 'Alpha University' });
    expect(groups[0]!.teamSplits).toBeUndefined();
    const noop = () => undefined;
    act(() =>
      root.render(
        createElement(RelayGroupCard, {
          group: groups[0]!,
          isSelected: false,
          estimated: true,
          whatIfMode: false,
          dragOverLeg: null,
          manualTimes: {},
          overrides: [],
          onSelect: noop,
          onAutofillAllVacant: noop,
          onAutofillLeg: noop,
          onAssignDragPayload: noop,
          onSetDragOverLeg: noop,
          onManualTimeChange: noop,
          onSaveManualLeg: noop,
          onClearLegOverride: noop,
        })
      )
    );
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/\bteam \d|1st half|2nd half|L\d \d/);
    // The legs that stayed keep their time and the label.
    expect(text).toContain('20.00');
    expect((text.match(new RegExp(RELAY_LEG_ESTIMATE_LABEL, 'g')) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('a display reader labels the estimate', () => {
  const ws = buildWorkspace();
  const alpha = relayLegs(ws).filter(r => r.team === 'Alpha University');
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('relayLegTimeView says estimate for a theoretical leg and split for a swum one', () => {
    expect(relayLegTimeView(alpha[1] as SwimmerResult)).toEqual({ time: '20.50', kind: 'estimate', basis: THEORETICAL_LEG_ESTIMATE_BASIS.noAdjustment });
    const swum: SwimmerResult = {
      id: 'real-1', rank: 1, name: 'X', classYear: 'JR', team: 'T', time: '1:23.00', points: 0, event: '200 Free Relay SCY',
      isRelay: true, relayLegIndex: 1, relayLegSplit: '20.50',
    };
    expect(relayLegTimeView(swum)).toEqual({ time: '20.50', kind: 'split' });
    // A row of a real meet that somehow carries an estimate still shows a split first.
    expect(relayLegTimeView({ ...swum, relayLegEstimate: { time: 99, basis: 'x' } })?.kind).toBe('split');
    expect(relayLegTimeView({ ...swum, relayLegSplit: undefined })).toBeNull();
  });

  it('refuses an unusable estimate: absent stays absent, never zero', () => {
    for (const time of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(relayLegEstimateOf({ relayLegEstimate: { time, basis: 'x' } })).toBeUndefined();
    }
    expect(relayLegEstimateOf({})).toBeUndefined();
  });

  it('the Manager relay card shows "Estimate" next to each leg time', () => {
    const groups = buildRelayGroups({ allScored: relayLegs(ws), originalResults: relayLegs(ws), gender: Gender.MEN, team: 'Alpha University' });
    const noop = () => undefined;
    act(() =>
      root.render(
        createElement(RelayGroupCard, {
          group: groups[0]!,
          isSelected: false,
          estimated: true,
          whatIfMode: false,
          dragOverLeg: null,
          manualTimes: {},
          overrides: [],
          onSelect: noop,
          onAutofillAllVacant: noop,
          onAutofillLeg: noop,
          onAssignDragPayload: noop,
          onSetDragOverLeg: noop,
          onManualTimeChange: noop,
          onSaveManualLeg: noop,
          onClearLegOverride: noop,
        })
      )
    );
    const text = host.textContent ?? '';
    expect(text).toContain('20.50');
    expect((text.match(new RegExp(RELAY_LEG_ESTIMATE_LABEL, 'g')) ?? []).length).toBe(4);
    expect(text).not.toMatch(/Split/);
  });

  it('the Matrix time cell shows the estimate under "Estimate", not a split', () => {
    act(() => root.render(createElement(SwimTimeCell, { result: alpha[1] as SwimmerResult })));
    expect(host.textContent).toContain('20.50');
    expect(host.textContent).toContain(RELAY_LEG_ESTIMATE_LABEL);
    expect(hasRelayLegTime(alpha[1] as SwimmerResult)).toBe(true);
  });

  it('the athlete credits carry the estimate beside a dash, never in displayTime', () => {
    const credits = getAthleteCreditedSwims(relayLegs(ws), 'Alpha University', 'A2', Gender.MEN);
    expect(credits).toHaveLength(1);
    expect(credits[0]!.displayTime).toBe('—');
    expect(credits[0]!.legEstimate).toEqual({ time: '20.50', basis: THEORETICAL_LEG_ESTIMATE_BASIS.noAdjustment });
  });

  it('the printed relay card and the HTML report print each leg time with the word Estimate, never NT', () => {
    const bundle = buildScoringSnapshot(ws, Gender.MEN, false).baseline;
    const cards = buildPrintCards({ workspace: ws, scoringBundle: bundle, gender: Gender.MEN, team: 'Alpha University' });
    const relay = cards.relays.find(c => c.event === '200 Free Relay SCY')!;
    expect(relay.estimate).toBe(true);
    expect(relay.legs.map(l => l.time)).toEqual(['20.00', '20.50', '21.00', '21.50']);
    expect(relay.legs.every(l => l.estimate)).toBe(true);
    const report = buildStaticReportHtml({
      workspace: ws,
      scoringBundle: bundle,
      gender: Gender.MEN,
      team: 'Alpha University',
      generatedAt: new Date('2026-10-14T12:00:00Z'),
    });
    expect(report.content).toContain('<td class="mono">20.50 <span class="tag">Estimate</span></td>');
    expect(report.content).not.toContain('<td class="mono">NT');
  });

  it('the split inspector comparison marks the known time as an estimate', () => {
    const rows = compareRelayLegSplits(ws, Gender.MEN, alpha, '200 Free Relay SCY', 'Alpha University');
    expect(rows.map(r => r.knownSplit)).toEqual(['20.00', '20.50', '21.00', '21.50']);
    expect(rows.every(r => r.knownIsEstimate === true && r.source === 'estimate')).toBe(true);
  });

  it('leg 1 keeps its own cut verdict from the recorded flat-start best; legs 2 to 4 get none', () => {
    const lead = buildTeamRowCutlineTags(alpha[0] as SwimmerResult, Gender.MEN, 'Alpha University', alpha[0]!.time, true);
    const later = buildTeamRowCutlineTags(alpha[1] as SwimmerResult, Gender.MEN, 'Alpha University', alpha[1]!.time, true);
    expect(lead.kind).toBe('relay');
    expect(later.kind).toBe('relay');
    if (lead.kind !== 'relay' || later.kind !== 'relay') return;
    expect(lead.relayEstimate).toBe(true);
    expect(lead.tags.relay).toBeNull();
    expect(later.tags.legQualification).toBeNull();
  });
});

describe('rows saved before the field existed', () => {
  const legacy = (over: Partial<SwimmerResult>): SwimmerResult => ({
    id: `${THEORETICAL_RELAY_LEG_ROW_ID_PREFIX}ws-old|Men|Alpha|200%20Free%20Relay%20SCY|leg2`,
    rank: 1,
    name: 'A2',
    classYear: 'JR',
    team: 'Alpha University',
    time: '1:23.00',
    finalsTime: '1:23.00',
    relayTeamTime: '1:23.00',
    points: 0,
    event: '200 Free Relay SCY',
    isRelay: true,
    relayLegIndex: 1,
    relayLegStroke: 'free',
    relayLegSplit: '20.50',
    ...over,
  });

  it('moves the stored time into relayLegEstimate, recognised by the theoretical row id', () => {
    const out = normalizeTheoreticalRelayLegEstimate(legacy({}));
    expect(out.relayLegSplit).toBeUndefined();
    expect('relayLegSplit' in out).toBe(false);
    expect(out.relayLegEstimate).toEqual({ time: 20.5, basis: 'best time (start adjustment not recorded)' });
    expect(out.relayLegEstimate).not.toHaveProperty('startAdjustmentSec');
    expect(normalizeTheoreticalRelayLegEstimate(out)).toBe(out);
  });

  it('labels leg 1 as the recorded flat-start best', () => {
    expect(normalizeTheoreticalRelayLegEstimate(legacy({ relayLegIndex: 0, relayLegSplit: '20.00' })).relayLegEstimate).toEqual({
      time: 20,
      basis: 'flat-start best time',
    });
  });

  it('leaves a row of a real meet, a row with a split detail and a row whose time does not parse alone', () => {
    const real = legacy({ id: 'real-meet-row-1' });
    expect(normalizeTheoreticalRelayLegEstimate(real)).toBe(real);
    const detailed = legacy({ relayLegSplitDetail: { legIndex: 1, stroke: 'free', legDistanceYards: 50, segments: [] } });
    expect(normalizeTheoreticalRelayLegEstimate(detailed)).toBe(detailed);
    for (const bad of ['NT', '', 'abc']) {
      const row = legacy({ relayLegSplit: bad });
      expect(normalizeTheoreticalRelayLegEstimate(row)).toBe(row);
    }
  });

  it('keeps relayLegSplit absent when the row also holds team split totals (the display split must not rebuild it)', () => {
    const row = legacy({
      relayTeamSplits: { legTotals: ['44.32', '45.09', '49.05', '44.35'], teamTotal: '3:02.81' },
      relayLegSplit: '45.09',
    });
    const out = normalizeSwimmerResultRelayFields(row);
    expect(out.relayLegSplit).toBeUndefined();
    expect(out.relayLegEstimate?.time).toBe(45.09);
    // The totals were built from the estimates, so they go with the moved split.
    expect(out.relayTeamSplits).toBeUndefined();
    // And it is stable: a second pass changes nothing.
    expect(normalizeSwimmerResultRelayFields(out).relayLegSplit).toBeUndefined();
  });

  it('never writes a split onto a row that already holds an estimate and leftover team totals', () => {
    const row = legacy({
      relayLegSplit: undefined,
      relayLegEstimate: { time: 45.09, basis: 'best time' },
      relayTeamSplits: { legTotals: ['44.32', '45.09', '49.05', '44.35'], teamTotal: '3:02.81' },
    });
    expect(normalizeSwimmerResultRelayFields(row).relayLegSplit).toBeUndefined();
  });

  it('is applied by the read-time normaliser the shell runs on every workspace load', () => {
    const out = normalizeSwimmerResultRelayFields(legacy({}));
    expect(out.relayLegSplit).toBeUndefined();
    expect(out.relayLegEstimate?.time).toBe(20.5);
  });
});
