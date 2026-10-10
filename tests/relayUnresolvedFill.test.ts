/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A relay fill that names a swimmer must not read as filled once that name
 * stops resolving to a swim the leg can use (backlog A13).
 *
 * `resolveRelayLegs` used to fall through to the override's `manualLegTime`
 * whenever the named swimmer did not resolve. A relay swap writes BOTH the
 * swimmer's name and a clock-hold `manualLegTime`, so when the swimmer lost the
 * one swim the leg needs (Scott Doll's 50 Free removed, his 100/200/500 Free
 * kept) the leg showed `—` at the held clock: counted as filled, not vacant,
 * and never flagged `relay_needs_fill`.
 *
 * What the fall-through was for: a coach typing only a time into a leg
 * (`IndRelayManagementView.saveManualLeg`) writes an override with NO
 * `assigneeName` and NO `recruitId`. That stays a deliberate clock hold. The
 * two are told apart by whether the override names anyone.
 *
 * Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json` (2026 NSISC
 * Championships, HSU men).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
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
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };

const HSU = 'Henderson State University';
const M_200FR = 'Event 31 Men 4x50 Yard Freestyle Relay';
const RELAY_A_KEY = `${HSU}|${M_200FR}|A Final|1|1:20.21`;
const STRICT: ScoringSettings = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
};

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-unresolved-fill',
    name: '2026 NSISC (unresolved fill)',
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
    ...over,
  } as Workspace;
}

/** Fill leg 1 of the 200 Free Relay A with Scott Doll through the real swap ranking. */
function filledWithDoll(): Workspace {
  const ws = workspace();
  const swap = rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings: STRICT }).swaps.find(
    s => s.relayEvent === M_200FR && s.legIndex === 0 && s.inAthlete === 'Scott Doll'
  );
  if (!swap) throw new Error('the swap ranking offered no Scott Doll fill for the 200 Free Relay A');
  return { ...ws, ...applyRelayLegSwap(ws, swap, { team: HSU, gender: Gender.MEN }).patch };
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

function fillWarnings(ws: Workspace): string[] {
  const allResults = buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
  return buildTeamLineupAudit({
    workspace: ws,
    gender: Gender.MEN,
    team: HSU,
    settings: STRICT,
    allResults,
    allScored: scoreWorkspaceRows(ws, Gender.MEN, STRICT),
    removeSeniors: false,
    detectDuplicates: false,
  })
    .checklistItems.filter(i => i.type === 'relay_needs_fill' && i.relayEntryKey === RELAY_A_KEY)
    .map(i => i.message);
}

const pts = (ws: Workspace) => sumTeamPoints(scoreWorkspaceRows(ws, Gender.MEN, STRICT), HSU, Gender.MEN);

describe('a relay fill whose swimmer stops resolving', () => {
  const doll = fixture.menResults.filter(r => r.name === 'Scott Doll' && !r.isRelay);
  const fifty = doll.find(r => r.event === 'Event 8 Men 50 Yard Freestyle')!;

  it('the fixture has the shape the report described', () => {
    expect(fifty).toBeDefined();
    expect(doll.filter(r => r !== fifty).length).toBeGreaterThan(0);
  });

  it('reads vacant and flagged when the swimmer keeps rows but none the leg can use', () => {
    const filled = filledWithDoll();
    expect(legView(filled)[0]).toBe('Scott Doll 1:20.21 vacant=false missing=-');
    expect(fillWarnings(filled)).toStrictEqual([]);

    const after = { ...filled, ...removeProjectedSwim(filled, Gender.MEN, fifty.id).patch } as Workspace;
    // The fill survives: Doll still has rows, and a 50 Free added back would re-resolve it.
    expect(after.relayLegOverrides).toStrictEqual(filled.relayLegOverrides);
    expect(legView(after)).toStrictEqual([
      '— 1:23.21 vacant=true missing=vacant',
      'Tristen Fergunson 1:23.21 vacant=false missing=-',
      'Vitor Sa 1:23.21 vacant=false missing=-',
      'Oliver Pozvai 1:23.21 vacant=false missing=-',
    ]);
    expect(fillWarnings(after)).toStrictEqual([
      expect.stringContaining('leg 1 (Free) needs filling'),
    ]);
    // Scores exactly like the same leg with no fill at all.
    expect(pts(after)).toBe(pts({ ...after, relayLegOverrides: [] }));
  });

  it('a recruit-id fill that no longer resolves reads vacant too', () => {
    const ws = workspace({
      relayLegOverrides: [
        { relayEntryKey: RELAY_A_KEY, legIndex: 0, recruitId: 'gone', manualLegTime: '20.47', source: 'manual' },
      ],
    });
    expect(legView(ws)[0]).toBe('— 1:23.21 vacant=true missing=vacant');
  });

  it('a time typed with no swimmer named stays a clock hold', () => {
    const hold: RelayLegOverride = { relayEntryKey: RELAY_A_KEY, legIndex: 0, manualLegTime: '20.47', source: 'manual' };
    const ws = workspace({ relayLegOverrides: [hold] });
    expect(legView(ws)[0]).toBe('— 1:20.21 vacant=false missing=-');
    expect(fillWarnings(ws)).toStrictEqual([]);
  });
});
