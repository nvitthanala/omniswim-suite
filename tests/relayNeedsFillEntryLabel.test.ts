/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The `relay_needs_fill` message names the relay entry (backlog A14).
 *
 * The A and B relays of one event can both need the same leg. Their messages
 * were word for word the same, so a coach could not tell which entry to fix.
 *
 * Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json` (2026 NSISC
 * Championships, HSU men). With Gavin Kock and Scott Doll removed, leg 1 of
 * the 4x50 Free Relay is empty on both the A Final (place 1) and the B Final
 * (place 9).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Gender, type ScoringSettings, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { scoreWorkspaceRows } from '../packages/core/src/lib/arbitrage/shared';
import { buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };

const HSU = 'Henderson State University';
const M_200FR = 'Event 31 Men 4x50 Yard Freestyle Relay';
const STRICT: ScoringSettings = {
  ...NSISC_PRESET_SETTINGS,
  scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
};

function needsFill(): { message: string; relayEntryKey?: string }[] {
  const ws = {
    id: 'ws-needs-fill-label',
    name: '2026 NSISC (needs-fill label)',
    createdAt: 0,
    menResults: fixture.menResults,
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [
      { name: 'Gavin Kock', gender: Gender.MEN },
      { name: 'Scott Doll', gender: Gender.MEN },
    ],
    conference: 'NSISC',
    scoringSettings: STRICT,
  } as Workspace;
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
  }).checklistItems.filter(i => i.type === 'relay_needs_fill');
}

describe('relay_needs_fill names the relay entry', () => {
  it('tells the A and B relay of one event apart', () => {
    const forEvent = needsFill().filter(i => i.message.includes(M_200FR));
    expect(forEvent.map(i => i.relayEntryKey)).toStrictEqual([
      `${HSU}|${M_200FR}|A Final|1|1:20.21`,
      `${HSU}|${M_200FR}|B Final|9|1:23.30`,
    ]);
    expect(forEvent.map(i => i.message)).toStrictEqual([
      `Relay ${M_200FR} (A Final, place 1): leg 1 (Free) needs filling`,
      `Relay ${M_200FR} (B Final, place 9): leg 1 (Free) needs filling`,
    ]);
  });

  it('gives every needs-fill item on the team its own message', () => {
    const messages = needsFill().map(i => i.message);
    expect(messages.length).toBeGreaterThan(2);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
