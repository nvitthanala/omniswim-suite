/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Removing a swimmer's last swim must clear the relay leg they were filling.
 *
 * A relay leg swap (`applyRelayLegSwap`) writes an override that names the
 * incoming swimmer AND carries a clock-hold `manualLegTime`. An override only
 * resolves onto the swimmer's meet rows and recruit rows (plus history swims
 * for swimmers who still have one of those). When `removeProjectedSwim` takes
 * away the last of those rows, the name no longer resolves, and
 * `resolveRelayLegs` falls through to the manual time: the leg renders `—` at
 * the held clock, is NOT flagged vacant, carries no missing-leg reason, gets no
 * 3-second penalty, and the lineup audit raises no `relay_needs_fill`. Under a
 * strict roster the relay silently scores 0 with nothing telling the coach why.
 *
 * Toggling the same swimmer off as a scorer prunes the override
 * (`applyScorerOffRelayPatch`), which leaves an honest, flagged vacancy. These
 * tests hold `removeProjectedSwim` to that behaviour.
 *
 * Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json` (2026 NSISC
 * Championships, HSU men). Gavin Kock is removed, which vacates leg 1 of the
 * 200 Free Relay A (Event 31). "Jordan Newman" is a hypothetical recruit; the
 * real data holds no recruit rows.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ClassYear,
  Gender,
  type Recruit,
  type RelayLegOverride,
  type ScoringSettings,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { applyRelayLegSwap, rankRelayLegSwaps } from '../packages/core/src/lib/crossCourseArbitrage';
import { removeProjectedSwim } from '../packages/core/src/lib/swimEditor';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { scoreWorkspaceRows, sumTeamPoints } from '../packages/core/src/lib/arbitrage/shared';
import { applyScorerOffRelayPatch, buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };

const HSU = 'Henderson State University';
const M_200FR = 'Event 31 Men 4x50 Yard Freestyle Relay';
const RELAY_A_KEY = `${HSU}|${M_200FR}|A Final|1|1:20.21`;
/** A/B-final legs are not auto-scorers, so a hollow leg costs the relay its points. */
const STRICT: ScoringSettings = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
};

function recruit(id: string, event: string, time: string): Recruit {
  return {
    id,
    name: 'Jordan Newman',
    team: HSU,
    event,
    time,
    gender: Gender.MEN,
    classYear: ClassYear.FR,
    timeType: 'SCY',
  };
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-remove-relay-override',
    name: '2026 NSISC (remove + relay override)',
    createdAt: 0,
    menResults: fixture.menResults,
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [{ name: 'Gavin Kock', gender: Gender.MEN }],
    conference: 'NSISC',
    scoringSettings: STRICT,
    scorerRosterOverrides: [{ name: 'Jordan Newman', team: HSU, gender: Gender.MEN, isScorer: true }],
    ...over,
  } as Workspace;
}

/** Fill leg 1 of the 200 Free Relay A with `athlete` through the real swap ranking. */
function filledWith(athlete: string, recruits: Recruit[] = []): Workspace {
  const ws = workspace({ recruits });
  const swap = rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: STRICT }).swaps.find(
    s => s.relayEvent === M_200FR && s.legIndex === 0 && s.inAthlete === athlete
  );
  if (!swap) throw new Error(`the swap ranking offered no ${athlete} fill for the 200 Free Relay A`);
  return { ...ws, ...applyRelayLegSwap(ws, swap, { team: HSU, gender: Gender.MEN }).patch };
}

function filledWithJordan(recruits: Recruit[]): Workspace {
  return filledWith('Jordan Newman', recruits);
}

function relayA(ws: Workspace): SwimmerResult[] {
  return buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false })
    .filter(r => r.isRelay && r.team === HSU && r.event === M_200FR && r.rank === 1)
    .sort((a, b) => (a.relayLegIndex ?? 0) - (b.relayLegIndex ?? 0));
}

function legView(ws: Workspace): string[] {
  return relayA(ws).map(
    r => `${r.name} ${r.time} vacant=${r.relayLegVacant} missing=${r.relayMissingLeg?.reason ?? '-'}`
  );
}

function relayFillWarnings(ws: Workspace): string[] {
  const allResults = buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
  const audit = buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team: HSU,
    settings: STRICT,
    allResults,
    allScored: scoreWorkspaceRows(ws, Gender.MEN, STRICT),
    removeSeniors: false,
    detectDuplicates: false,
  });
  return audit.checklistItems
    .filter(i => i.type === 'relay_needs_fill' && i.relayEntryKey === RELAY_A_KEY)
    .map(i => i.message);
}

function apply(ws: Workspace, edit: { patch: Partial<Workspace> }): Workspace {
  return { ...ws, ...edit.patch };
}

describe('removeProjectedSwim and relay leg overrides', () => {
  it('the swap fills the leg first (the precondition is real)', () => {
    const ws = filledWithJordan([recruit('rec-50', '50 Yard Freestyle', '20.60')]);
    expect(ws.relayLegOverrides).toStrictEqual<RelayLegOverride[]>([
      { relayEntryKey: RELAY_A_KEY, legIndex: 0, assigneeName: 'Jordan Newman', manualLegTime: '20.47', source: 'manual' },
    ]);
    expect(legView(ws)[0]).toBe('Jordan Newman 1:20.21 vacant=false missing=-');
    expect(relayFillWarnings(ws)).toStrictEqual([]);
  });

  it("removing a recruit's last row leaves the leg vacant and flagged, as a scorer toggle does", () => {
    const filled = filledWithJordan([recruit('rec-50', '50 Yard Freestyle', '20.60')]);
    const edit = removeProjectedSwim(filled, Gender.MEN, 'rec-50');
    const removed = apply(filled, edit);

    expect(legView(removed)).toStrictEqual([
      '— 1:23.21 vacant=true missing=vacant',
      'Tristen Fergunson 1:23.21 vacant=false missing=-',
      'Vitor Sa 1:23.21 vacant=false missing=-',
      'Oliver Pozvai 1:23.21 vacant=false missing=-',
    ]);
    expect(relayFillWarnings(removed)).toStrictEqual([
      'Relay Event 31 Men 4x50 Yard Freestyle Relay: leg 1 (Free) needs filling',
    ]);

    // Same relay state as toggling Jordan off as a scorer.
    const toggled = {
      ...filled,
      ...applyScorerOffRelayPatch(filled, {
        name: 'Jordan Newman',
        team: HSU,
        gender: Gender.MEN,
        isScorer: false,
        overrides: [{ name: 'Jordan Newman', team: HSU, gender: Gender.MEN, isScorer: false }],
      }),
    };
    expect(legView(removed)).toStrictEqual(legView(toggled));
    expect(removed.relayLegOverrides).toStrictEqual(toggled.relayLegOverrides);

    // The relay scores what an unfilled leg scores, and Undo brings the fill back.
    const pts = (ws: Workspace) => sumTeamPoints(scoreWorkspaceRows(ws, Gender.MEN, STRICT), HSU, Gender.MEN);
    expect(pts(removed)).toBe(pts({ ...removed, relayLegOverrides: [] }));
    const undone = { ...removed, ...edit.inverse };
    expect(undone.relayLegOverrides).toStrictEqual(filled.relayLegOverrides);
    expect(undone.recruits).toStrictEqual(filled.recruits);
    expect(legView(undone)).toStrictEqual(legView(filled));
  });

  it('removing a credited swim that is the last row clears the fill too', () => {
    // Scott Doll is the swap ranking's real top fill. He keeps three relay rows
    // of his own (B relays), which cannot fill a leg, so they must not count.
    const doll = fixture.menResults.filter(r => r.name === 'Scott Doll');
    expect(doll.filter(r => r.isRelay)).toHaveLength(3);
    const individual = doll.filter(r => !r.isRelay);
    const fifty = individual.find(r => r.event === 'Event 8 Men 50 Yard Freestyle')!;
    let ws = filledWith('Scott Doll');
    const fill = ws.relayLegOverrides;
    expect(fill).toHaveLength(1);
    for (const row of individual.filter(r => r !== fifty)) {
      ws = apply(ws, removeProjectedSwim(ws, Gender.MEN, row.id));
      expect(ws.relayLegOverrides).toStrictEqual(fill);
      expect(legView(ws)[0]).toBe('Scott Doll 1:20.21 vacant=false missing=-');
    }
    ws = apply(ws, removeProjectedSwim(ws, Gender.MEN, fifty.id));
    expect(ws.relayLegOverrides).toStrictEqual([]);
    expect(legView(ws)[0]).toBe('— 1:23.21 vacant=true missing=vacant');
    expect(relayFillWarnings(ws)).toStrictEqual([
      'Relay Event 31 Men 4x50 Yard Freestyle Relay: leg 1 (Free) needs filling',
    ]);
  });

  it('keeps the fill while the swimmer still has a row the leg can resolve onto', () => {
    const filled = filledWithJordan([
      recruit('rec-50', '50 Yard Freestyle', '20.60'),
      recruit('rec-100', '100 Yard Freestyle', '45.10'),
    ]);
    const removed = apply(filled, removeProjectedSwim(filled, Gender.MEN, 'rec-100'));
    expect(removed.relayLegOverrides).toStrictEqual(filled.relayLegOverrides);
    expect(legView(removed)[0]).toBe('Jordan Newman 1:20.21 vacant=false missing=-');
  });

  it('a removed planned entry never touches the overrides (plans do not fill legs)', () => {
    const filled = filledWithJordan([recruit('rec-50', '50 Yard Freestyle', '20.60')]);
    const withPlan = {
      ...filled,
      meetEntryPlans: [
        {
          id: 'plan-1',
          name: 'Jordan Newman',
          team: HSU,
          gender: Gender.MEN,
          classYear: ClassYear.FR,
          event: '100 Yard Butterfly',
          time: '50.00',
          timeType: 'SCY',
          source: 'manual',
          active: true,
        },
      ],
    } as Workspace;
    const edit = removeProjectedSwim(withPlan, Gender.MEN, 'plan-1');
    expect(edit.patch.relayLegOverrides).toBeUndefined();
  });
});
