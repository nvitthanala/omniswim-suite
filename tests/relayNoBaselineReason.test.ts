/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A filled relay leg whose replacement cannot be priced says why. `simulateRoster` writes the relay's team
 * time `NT` when the departed leg has no baseline (no usable swim, no readable split or estimate); the row
 * of that leg now carries `relayMissingLeg.reason === 'no_baseline'`, the lineup audit names it
 * (`relay_time_unknown`), and no reader counts it as a vacant leg (`relayLegIsVacant`).
 *
 * REAL data: the Henderson State 4x100 Free Relay (place 1) of the 2026 NSISC Championships, from
 * tests/fixtures/nsisc-2026-relay-followups-r1.json. Scott Doll (leg 3, index 2) has his leg split removed
 * and his 100 Free flagged a time trial, and is not a scorer: the departed leg has no baseline. No
 * competition standard is typed in.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Gender } from '../packages/core/src/types';
import type { RelayLegOverride, SwimmerResult, Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { relayLegIsVacant } from '../packages/core/src/lib/relayLegMatching';
import { buildTeamLineupAudit, issueBadgeLabel } from '../packages/core/src/lib/rosterLineupAudit';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import { simulateRoster } from '../packages/core/src/lib/relaySimulation';
import { normalizeSwimmerName } from '../packages/core/src/lib/swimmerNames';
import { workspaceFixture } from './helpers/typedFixtures';

const TEAM = 'Henderson State University';
const EVENT = 'Event 42 Men 4x100 Yard Freestyle Relay';
const OUT = 'Scott Doll';
const DOLL_100 = '0b7ddcce-6648-4295-8c49-98a3c1fc3860';
const LEG = 2;
const IN = 'Gavin Kock';

type Row = SwimmerResult & Record<string, unknown>;
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: Row[]; womenResults: Row[] };

const isDollLeg = (r: Row): boolean =>
  r.isRelay === true && r.team === TEAM && r.event === EVENT && r.rank === 1 && r.relayLegIndex === LEG;

/** The fixture with Doll's leg split removed and his 100 Free flagged a time trial. */
function noBaselineRows(): Row[] {
  return fixture.menResults.map(r => {
    if (r.id === DOLL_100) return { ...r, isTimeTrial: true } as Row;
    if (isDollLeg(r)) {
      const { relayLegSplit: _s, relayLegSplitDetail: _d, relayTeamSplits: _t, ...rest } = r;
      void _s;
      void _d;
      void _t;
      return rest as Row;
    }
    return r;
  });
}

const target = (rows: SwimmerResult[]): SwimmerResult[] =>
  rows.filter(r => r.isRelay === true && r.team === TEAM && r.event === EVENT && r.rank === 1);

function overrideOn(rows: SwimmerResult[], extra: Partial<RelayLegOverride>): RelayLegOverride {
  const anchor = target(rows)[0];
  expect(anchor).toBeDefined();
  return { relayEntryKey: relayEntryKey(anchor as SwimmerResult), legIndex: LEG, source: 'manual', ...extra };
}

const run = (rows: Row[], override: RelayLegOverride) =>
  simulateRoster(rows, [], false, new Set(), [override], new Set([normalizeSwimmerName(OUT)]));

describe('simulateRoster names the leg whose replacement cannot be priced', () => {
  it('a manual leg time on a leg with no baseline: NT, and the leg row says no_baseline', () => {
    const rows = noBaselineRows();
    const out = target(run(rows, overrideOn(rows, { manualLegTime: '45.00' })));
    expect(out.map(r => r.relayTeamTime)).toStrictEqual(['NT', 'NT', 'NT', 'NT']);
    const legRow = out.find(r => r.relayLegIndex === LEG);
    expect(legRow?.relayMissingLeg).toStrictEqual({ legIndex: LEG, stroke: 'free', reason: 'no_baseline' });
    // The other legs do not carry it.
    expect(out.filter(r => r.relayLegIndex !== LEG).every(r => r.relayMissingLeg === undefined)).toBe(true);
    // A filled (held) leg is not vacant.
    expect(legRow?.relayLegVacant).toBe(false);
    expect(relayLegIsVacant(legRow as SwimmerResult)).toBe(false);
  });

  it('a named swimmer on that leg: the same reason, and the swimmer is on the leg', () => {
    const rows = noBaselineRows();
    const out = target(run(rows, overrideOn(rows, { assigneeName: IN })));
    const legRow = out.find(r => r.relayLegIndex === LEG);
    expect(legRow?.name).toBe(IN);
    expect(legRow?.relayMissingLeg?.reason).toBe('no_baseline');
    expect(legRow?.relayTeamTime).toBe('NT');
  });

  it('a relay with a baseline shows no reason and a real time', () => {
    const rows = fixture.menResults;
    const out = target(run(rows, overrideOn(rows, { manualLegTime: '49.05' })));
    expect(out.every(r => r.relayMissingLeg === undefined)).toBe(true);
    expect(out.every(r => r.relayTeamTime !== 'NT')).toBe(true);
  });

  it('a vacated non-scorer leg keeps its own reason, and counts as vacant', () => {
    const rows = noBaselineRows();
    const out = target(simulateRoster(rows, [], false, new Set(), [], new Set([normalizeSwimmerName(OUT)])));
    const legRow = out.find(r => r.relayLegIndex === LEG);
    expect(legRow?.relayMissingLeg?.reason).toBe('no_replacement');
    expect(relayLegIsVacant(legRow as SwimmerResult)).toBe(true);
  });
});

describe('relayLegIsVacant', () => {
  const missing = (reason: 'vacant' | 'no_replacement' | 'stroke_mismatch' | 'time_trial_only' | 'no_baseline') => ({
    relayMissingLeg: { legIndex: 0, stroke: 'free' as const, reason },
  });
  it('is true for every reason that means nobody swims the leg, false for no_baseline', () => {
    expect(relayLegIsVacant({})).toBe(false);
    expect(relayLegIsVacant({ relayLegVacant: true })).toBe(true);
    for (const reason of ['vacant', 'no_replacement', 'stroke_mismatch', 'time_trial_only'] as const) {
      expect(relayLegIsVacant(missing(reason)), reason).toBe(true);
    }
    expect(relayLegIsVacant(missing('no_baseline'))).toBe(false);
  });
});

describe('the lineup audit names the unpriced leg and does not call it vacant', () => {
  function audit(rows: Row[], override: RelayLegOverride) {
    const simulated = run(rows, override);
    const workspace: Workspace = workspaceFixture({
      id: 'w',
      name: 'w',
      createdAt: 0,
      menResults: rows,
      womenResults: fixture.womenResults,
      recruits: [],
      meetEntryPlans: [],
      activeEntryIds: [],
      athleteHistory: [],
      relayLegOverrides: [override],
      deletedSwimmers: [],
      conference: 'NSISC',
      scoringSettings: NSISC_PRESET_SETTINGS,
      scorerRosterOverrides: [{ name: OUT, team: TEAM, gender: Gender.MEN, isScorer: false }],
    });
    return buildTeamLineupAudit({
      workspace,
      gender: Gender.MEN,
      team: TEAM,
      settings: NSISC_PRESET_SETTINGS,
      allResults: simulated,
      allScored: simulated,
      removeSeniors: false,
      detectDuplicates: false,
    });
  }

  it('one relay_time_unknown item for the leg, in plain words, and no needs-fill item for it', () => {
    const rows = noBaselineRows();
    const result = audit(rows, overrideOn(rows, { assigneeName: IN }));
    const items = result.checklistItems.filter(i => i.type === 'relay_time_unknown' && i.relayEvent === EVENT);
    expect(items).toHaveLength(1);
    expect(items[0]?.legIndex).toBe(LEG);
    expect(items[0]?.message).toContain('leg 3');
    expect(items[0]?.message).toContain('has no recorded split or usable swim');
    expect(items[0]?.message).toContain('NT');
    expect(
      result.checklistItems.some(i => i.type === 'relay_needs_fill' && i.relayEvent === EVENT && i.legIndex === LEG)
    ).toBe(false);
    expect(issueBadgeLabel({ type: 'relay_time_unknown', message: '' })).toBe('Relay time');
  });

  it('a relay with a baseline has no such item', () => {
    const rows = fixture.menResults;
    const result = audit(rows, overrideOn(rows, { assigneeName: IN }));
    expect(result.checklistItems.some(i => i.type === 'relay_time_unknown')).toBe(false);
  });
});
