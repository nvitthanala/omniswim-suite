/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * When the projection takes a non-scorer off a relay, the lineup audit says so,
 * and says it on that athlete's roster row — whichever spelling the relay leg
 * was printed under.
 *
 * FIXED 2026-10-01 (found the same day by the bug-hunter pass). These cases pin
 * the corrected behaviour; the description below records the defect they guard.
 *
 * Setup: an active alias link "Camden Mask" -> "Cam Mask", a scorer override
 * turning "Cam Mask" off, and a relay leg printed as "Camden Mask".
 * `buildWhatIfProjection` passes the alias resolver to
 * `computeVacateRelayLegNames`, so it recognises the leg holder as the
 * non-scorer and vacates the leg. `buildTeamLineupAudit`
 * (rosterLineupAudit.ts) calls the same function WITHOUT the resolver — the
 * function's own doc comment warns against exactly that — so:
 *
 * 1. The audit gives the wrong reason. It reports `relay_leg_vacant` ("Relay
 *    leg vacant — needs filling"; with "drop seniors" on, "Senior removed")
 *    instead of `relay_scorer_off` ("non-scorers cannot swim relays").
 * 2. The issue is keyed by the leg's spelling ("camden mask"). The roster row
 *    shows the canonical spelling, and `teamRosterView.ts` looks issues up by
 *    `normalizeSwimmerName(row.name)`, so the badge never reaches the athlete.
 *
 * Fixture is synthetic: invented teams, names and times.
 */
import { describe, expect, it } from 'vitest';
import { Gender, type SwimmerResult, type Workspace } from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS, mergeScoringSettings } from '../packages/core/src/lib/scoringDefaults';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { athleteHasIssueType, buildTeamLineupAudit } from '../packages/core/src/lib/rosterLineupAudit';

const TEAM = 'Alpha University';
const CANONICAL = 'Cam Mask';
const ALIAS = 'Camden Mask';
const RELAY_EVENT = 'Event 1 Men 200 Yard Freestyle Relay';

function individual(id: string, name: string, rank: number, time: string): SwimmerResult {
  return {
    id,
    rank,
    name,
    classYear: 'JR',
    team: TEAM,
    time,
    finalsTime: time,
    points: 0,
    event: 'Event 4 Men 50 Yard Freestyle',
    gender: Gender.MEN,
    roundSwam: 'A Final',
  } as SwimmerResult;
}

function relay(firstLeg: string): SwimmerResult[] {
  const legs = [firstLeg, 'Bo Bee', 'Cy Cee', 'Di Dee'];
  return legs.map((name, i) => ({
    id: `r1-${i}`,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: '1:20.00',
    finalsTime: '1:20.00',
    relayTeamTime: '1:20.00',
    roundSwam: 'A Final',
    points: 0,
    event: RELAY_EVENT,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
  })) as SwimmerResult[];
}

function audit(legSpelling: string) {
  const menResults = [
    individual('i1', CANONICAL, 1, '20.10'),
    individual('i2', 'Bo Bee', 2, '20.50'),
    ...relay(legSpelling),
  ];
  const workspace = {
    id: 'ws-audit-alias',
    name: 'audit alias probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    sourceMenResults: menResults,
    sourceWomenResults: [],
    recruits: [],
    scoringSettings: { ...NSISC_PRESET_SETTINGS },
    conference: 'NSISC',
    meetEntryPlans: [],
    activeEntryIds: [],
    historySources: [],
    relayLegOverrides: [],
    athleteHistory: [],
    athleteAliases: [
      { id: 'link-1', gender: Gender.MEN, team: TEAM, canonicalName: CANONICAL, aliasName: ALIAS, source: 'manual', status: 'active' },
    ],
    scorerRosterOverrides: [{ name: CANONICAL, team: TEAM, gender: Gender.MEN, isScorer: false }],
  } as unknown as Workspace;
  const bundle = buildScoringBundle({
    workspace,
    gender: Gender.MEN,
    removeSeniors: false,
    applyWhatIf: true,
    scorerRosterOverrides: workspace.scorerRosterOverrides,
  });
  const firstLegVacated = bundle.allScored.some(r => r.isRelay && r.relayLegIndex === 0 && r.relayLegVacant === true);
  const result = buildTeamLineupAudit({
    workspace,
    gender: Gender.MEN,
    team: TEAM,
    settings: mergeScoringSettings(workspace.scoringSettings, { conference: 'NSISC' }),
    allResults: bundle.allResults,
    allScored: bundle.allScored,
    removeSeniors: false,
  });
  const issueTypes = [...result.athleteIssues.values()].flat().map(i => i.type);
  return { result, firstLegVacated, issueTypes };
}

describe('lineup audit: a non-scorer vacated from a relay leg', () => {
  it('names the scorer rule on the roster row when the leg carries the canonical spelling (control)', () => {
    const { result, firstLegVacated, issueTypes } = audit(CANONICAL);
    expect(firstLegVacated, 'the projection vacated leg 1').toBe(true);
    expect(athleteHasIssueType(result, CANONICAL, 'relay_scorer_off'), 'relay_scorer_off reachable by the roster name').toBe(true);
    expect(issueTypes).not.toContain('relay_leg_vacant');
  });

  it('names the scorer rule when the leg carries the linked alias spelling', () => {
    const { firstLegVacated, issueTypes } = audit(ALIAS);
    expect(firstLegVacated, 'the projection vacated leg 1').toBe(true);
    expect(issueTypes).toContain('relay_scorer_off');
  });

  it('attaches the issue to the roster row, which shows the canonical spelling', () => {
    const { result, firstLegVacated } = audit(ALIAS);
    expect(firstLegVacated, 'the projection vacated leg 1').toBe(true);
    expect(athleteHasIssueType(result, CANONICAL, 'relay_scorer_off'), 'relay_scorer_off reachable by the roster name').toBe(true);
  });

  it('files ONE relay_scorer_off issue, under the canonical spelling, carrying the leg it came from', () => {
    const { result } = audit(ALIAS);
    const onRoster = result.athleteIssues.get('cam mask') ?? [];
    const scorerOff = onRoster.filter(i => i.type === 'relay_scorer_off');
    expect(scorerOff).toHaveLength(1);
    // The per-leg sweep names the relay; the roster-wide sweep does not. The one
    // issue on the roster row must be the informative one.
    expect(scorerOff[0].relayEvent).toBe(RELAY_EVENT);
    expect(result.athleteIssues.has('camden mask'), 'nothing left under the alias spelling').toBe(false);
  });
});
