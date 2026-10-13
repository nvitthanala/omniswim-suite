/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * D9: a time-trial swim does not fill a relay leg unless the coach opts in
 * (`ScoringSettings.relayLegsAllowTimeTrials`), and a leg filled that way is
 * labelled (`relayLegTimeTrial`).
 *
 * ## Why this test exists
 *
 * `isRelayLegEvent` reads a time trial of the leg event as the leg event, so
 * before D9 a time trial filled a leg in the relay builder, the swap ranking,
 * the what-if projection and the theoretical meet, with nothing on the leg to
 * say so. A coach could read a 3:02 relay that rested on a swim from outside
 * the meet's program.
 *
 * Real rows: `tests/fixtures/nsisc-2026-relay-followups-r1.json` (2026 NSISC
 * Championships, HSU men). Aiden Killackey's only 100 Free there is a time
 * trial (50.82, "Event 201 Men 100 Yard Freestyle Time Trial"), so he is the
 * swimmer a time-trial rule decides.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type HistoricalSwim,
  type RelayLegOverride,
  type ScoringSettings,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import {
  NSISC_PRESET_SETTINGS,
  mergeScoringSettings,
  relayLegsAllowTimeTrials,
} from '../packages/core/src/lib/scoringDefaults';
import {
  listEligibleRelayLegCandidates,
  resolveOverrideAssignee,
  suggestBestRelayLegFill,
  swimmerMatchesRelayLeg,
} from '../packages/core/src/lib/relayLegMatching';
import { relayLegHistoryCandidates } from '../packages/core/src/lib/relayLegHistoryCandidates';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { buildWhatIfProjection } from '../packages/core/src/lib/whatIfProjection';
import { buildScoringBundle } from '../packages/core/src/lib/scoringEngine';
import { historicalSwimFromResult } from '../packages/core/src/lib/athleteHistory';
import { isTimeTrialSwim } from '../packages/core/src/lib/utils';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[]; womenResults: SwimmerResult[] };

const HSU = 'Henderson State University';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
const M_200FR = 'Event 31 Men 4x50 Yard Freestyle Relay';
/** 4x100 Free Relay A (1st, 3:02.81). Leg 2 (the third leg) is Scott Doll's. */
const RELAY_A_KEY = `${HSU}|${M_400FR}|A Final|1|3:02.81`;
const KILLACKEY = 'Aiden Killackey';
const ON: Pick<ScoringSettings, 'relayLegsAllowTimeTrials'> = { relayLegsAllowTimeTrials: true };

const killackeyTimeTrial = fixture.menResults.find(
  r => r.name === KILLACKEY && r.isTimeTrial === true
) as SwimmerResult;

function workspace(over: Partial<Workspace> = {}, settings: Partial<ScoringSettings> = {}): Workspace {
  return {
    id: 'ws-relay-leg-time-trials',
    name: '2026 NSISC (relay leg time trials)',
    createdAt: 0,
    menResults: fixture.menResults,
    womenResults: fixture.womenResults,
    recruits: [],
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [],
    conference: 'NSISC',
    scoringSettings: { ...NSISC_PRESET_SETTINGS, ...settings },
    ...over,
  } as Workspace;
}

/** HSU men's individual rows: the pool a leg is filled from. */
const pool: SwimmerResult[] = fixture.menResults.filter(r => !r.isRelay && r.team === HSU);

/** Scott Doll leaves the 4x100 Free Relay A; the override names Killackey for his leg. */
function dollReplacedByKillackey(settings: Partial<ScoringSettings>): Workspace {
  const override: RelayLegOverride = {
    relayEntryKey: RELAY_A_KEY,
    legIndex: 2,
    assigneeName: KILLACKEY,
    source: 'manual',
  };
  return workspace(
    {
      deletedSwimmers: [{ name: 'Scott Doll', gender: Gender.MEN }],
      relayLegOverrides: [override],
    },
    settings
  );
}

function relayALegs(ws: Workspace): SwimmerResult[] {
  return buildWhatIfProjection({ workspace: ws, gender: Gender.MEN, removeSeniors: false }).rows.filter(
    r =>
      r.isRelay === true &&
      r.team === HSU &&
      r.event === M_400FR &&
      r.roundSwam === 'A Final' &&
      r.rank === 1
  );
}

describe('the setting', () => {
  it('is off unless it is the literal true', () => {
    expect(relayLegsAllowTimeTrials(undefined)).toBe(false);
    expect(relayLegsAllowTimeTrials(null)).toBe(false);
    expect(relayLegsAllowTimeTrials({})).toBe(false);
    expect(relayLegsAllowTimeTrials({ relayLegsAllowTimeTrials: false })).toBe(false);
    // A malformed saved value must not flip a competition rule.
    expect(
      relayLegsAllowTimeTrials({ relayLegsAllowTimeTrials: 'yes' } as unknown as ScoringSettings)
    ).toBe(false);
    expect(relayLegsAllowTimeTrials(ON)).toBe(true);
  });

  it('survives the conference merge, and a legacy preset has no field', () => {
    expect(NSISC_PRESET_SETTINGS.relayLegsAllowTimeTrials).toBeUndefined();
    const merged = mergeScoringSettings({ ...NSISC_PRESET_SETTINGS, ...ON }, { conference: 'NSISC' });
    expect(merged.relayLegsAllowTimeTrials).toBe(true);
    expect(relayLegsAllowTimeTrials(mergeScoringSettings(NSISC_PRESET_SETTINGS, { conference: 'NSISC' }))).toBe(false);
  });
});

describe('what counts as a time trial', () => {
  it('reads the flag or the label, and keeps a Boys/Girls championship swim', () => {
    expect(isTimeTrialSwim({ event: 'Event 201 Men 100 Yard Freestyle', isTimeTrial: true })).toBe(true);
    expect(isTimeTrialSwim({ event: 'Event 201 Men 100 Yard Freestyle Time Trial' })).toBe(true);
    expect(isTimeTrialSwim({ event: 'Event 35 Men 100 Yard Freestyle' })).toBe(false);
    expect(isTimeTrialSwim({ event: 'Event 5 Boys 50 Yard Freestyle Time Trial', isTimeTrial: true })).toBe(false);
  });
});

describe('leg candidates', () => {
  it('leaves a time trial off the leg by default, on real rows', () => {
    expect(killackeyTimeTrial.event).toBe('Event 201 Men 100 Yard Freestyle Time Trial');
    expect(swimmerMatchesRelayLeg(killackeyTimeTrial, M_400FR, 2)).toBe(false);
    const off = listEligibleRelayLegCandidates(pool, M_400FR, 2, new Set(), HSU, Gender.MEN);
    expect(off.map(r => r.name)).not.toContain(KILLACKEY);
    expect(off.length).toBeGreaterThan(3);
    expect(off.some(r => r.relayLegTimeTrial === true)).toBe(false);
  });

  it('a legacy settings object, with or without the field, behaves as off', () => {
    const legacy = { ...NSISC_PRESET_SETTINGS };
    const explicit = { ...NSISC_PRESET_SETTINGS, relayLegsAllowTimeTrials: false };
    const names = (s?: Partial<ScoringSettings>) =>
      listEligibleRelayLegCandidates(pool, M_400FR, 2, new Set(), HSU, Gender.MEN, s).map(r => r.name);
    expect(names(legacy)).toStrictEqual(names(undefined));
    expect(names(explicit)).toStrictEqual(names(undefined));
    expect(names(legacy)).not.toContain(KILLACKEY);
  });

  it('opted in, includes the time trial and labels it', () => {
    const on = listEligibleRelayLegCandidates(pool, M_400FR, 2, new Set(), HSU, Gender.MEN, ON);
    const hit = on.find(r => r.name === KILLACKEY);
    expect(hit?.relayLegTimeTrial).toBe(true);
    expect(hit?.time).toBe('50.82');
    // Only the time-trial swim is labelled, and the input row is not changed.
    expect(on.filter(r => r.relayLegTimeTrial === true).map(r => r.name)).toStrictEqual([KILLACKEY]);
    expect(killackeyTimeTrial.relayLegTimeTrial).toBeUndefined();
  });

  it('the autofill suggestion follows the setting', () => {
    const template = fixture.menResults.find(
      r => r.isRelay && r.team === HSU && r.event === M_400FR && r.roundSwam === 'A Final' && r.relayLegIndex === 0
    ) as SwimmerResult;
    // Only the time-trial swimmer is left, so the leg is the setting's call.
    const only = pool.filter(r => r.name === KILLACKEY);
    expect(suggestBestRelayLegFill(only, template, 2, new Set(), new Set())).toBeNull();
    const fill = suggestBestRelayLegFill(only, template, 2, new Set(), new Set(), ON);
    expect(fill?.override.assigneeName).toBe(KILLACKEY);
    expect(fill?.swimmer.relayLegTimeTrial).toBe(true);
  });

  it('an override resolves onto the time trial only when allowed', () => {
    const override: RelayLegOverride = { relayEntryKey: RELAY_A_KEY, legIndex: 2, assigneeName: KILLACKEY };
    expect(resolveOverrideAssignee(override, pool, HSU, M_400FR, 2, Gender.MEN)).toBeNull();
    const on = resolveOverrideAssignee(override, pool, HSU, M_400FR, 2, Gender.MEN, ON);
    expect(on?.relayLegTimeTrial).toBe(true);
  });
});

describe('the projected relay', () => {
  it('leaves the leg vacant when the setting is off', () => {
    const legs = relayALegs(dollReplacedByKillackey({}));
    expect(legs).toHaveLength(4);
    const leg = legs.find(r => r.relayLegIndex === 2) as SwimmerResult;
    expect(leg.relayLegVacant).toBe(true);
    expect(leg.name).toBe('—');
    expect(legs.some(r => r.relayLegTimeTrial === true)).toBe(false);
    expect(legs[0].relayNames?.map(n => n.name)).not.toContain(KILLACKEY);
  });

  it('fills and labels the leg when the setting is on', () => {
    const legs = relayALegs(dollReplacedByKillackey(ON));
    const leg = legs.find(r => r.relayLegIndex === 2) as SwimmerResult;
    expect(leg.name).toBe(KILLACKEY);
    expect(leg.relayLegVacant).toBe(false);
    expect(leg.relayLegTimeTrial).toBe(true);
    // The label is on the filled leg only.
    expect(legs.filter(r => r.relayLegTimeTrial === true).map(r => r.relayLegIndex)).toStrictEqual([2]);
    expect(legs[0].relayNames?.map(n => n.name)).toContain(KILLACKEY);
  });

  it('the label reaches the scored rows the screens read', () => {
    // The UI reads the scoring bundle, which collapses aliases and re-scores the rows.
    const scoredLeg = (settings: Partial<ScoringSettings>) =>
      buildScoringBundle({
        workspace: dollReplacedByKillackey(settings),
        gender: Gender.MEN,
        removeSeniors: false,
        applyWhatIf: true,
        scorerRosterOverrides: [],
      }).allScored.filter(
        r => r.isRelay === true && r.team === HSU && r.event === M_400FR && r.roundSwam === 'A Final' && r.rank === 1 && r.relayLegIndex === 2
      );
    const on = scoredLeg(ON);
    expect(on.length).toBeGreaterThan(0);
    expect(on.every(r => r.name === KILLACKEY && r.relayLegTimeTrial === true)).toBe(true);
    expect(scoredLeg({}).some(r => r.relayLegTimeTrial === true)).toBe(false);
  });

  it('a workspace saved without the field projects as one that says false', () => {
    const legacy = relayALegs(dollReplacedByKillackey({}));
    const explicit = relayALegs(dollReplacedByKillackey({ relayLegsAllowTimeTrials: false }));
    expect(explicit).toStrictEqual(legacy);
  });
});

describe('history candidates', () => {
  const ttHistory = historicalSwimFromResult(killackeyTimeTrial, 'NSISC 2026 time trials') as HistoricalSwim;
  const withoutTimeTrialRow = (rows: SwimmerResult[]) => rows.filter(r => r !== killackeyTimeTrial);
  const wsWithHistory = (history: HistoricalSwim[], settings: Partial<ScoringSettings>) =>
    workspace({ athleteHistory: history }, settings);

  it('the history swim is a time trial', () => {
    expect(ttHistory.isTimeTrial).toBe(true);
    expect(isTimeTrialSwim(ttHistory)).toBe(true);
  });

  it('offers no candidate from a time-trial history swim by default, and labels it when allowed', () => {
    const rows = withoutTimeTrialRow(pool).concat([{ ...killackeyTimeTrial, event: 'Event 6 Men 50 Yard Freestyle', isTimeTrial: false, id: 'k-50' }]);
    // The pool holds Killackey, so he is on the roster; his only 100 Free swim is the history one.
    // One history array for every call: the converted-swim cache is keyed on it,
    // so toggling the setting must not return a stale answer.
    const history = [ttHistory];
    const off = relayLegHistoryCandidates(wsWithHistory(history, {}), rows, Gender.MEN);
    expect(off.filter(r => r.name === KILLACKEY)).toHaveLength(0);
    const on = relayLegHistoryCandidates(wsWithHistory(history, ON), rows, Gender.MEN);
    const hit = on.find(r => r.name === KILLACKEY);
    expect(hit?.relayLegTimeTrial).toBe(true);
    expect(hit?.relayLegHistory).toBeDefined();
    const offAgain = relayLegHistoryCandidates(wsWithHistory(history, {}), rows, Gender.MEN);
    expect(offAgain.filter(r => r.name === KILLACKEY)).toHaveLength(0);
  });

  it('a time-trial row in the pool does not hide the swimmer\'s real history swim while off', () => {
    const real = historicalSwimFromResult(
      { ...killackeyTimeTrial, event: 'Event 201 Men 100 Yard Freestyle', isTimeTrial: false, time: '51.50' },
      'Earlier meet'
    ) as HistoricalSwim;
    expect(real.isTimeTrial).toBeUndefined();
    // The pool still holds his time-trial row. It cannot fill the leg, so his real swim must be offered.
    const off = relayLegHistoryCandidates(wsWithHistory([real], {}), pool, Gender.MEN);
    const hit = off.find(r => r.name === KILLACKEY && r.event === '100 Freestyle');
    expect(hit?.time).toBe('51.50');
    expect(hit?.relayLegTimeTrial).toBeUndefined();
    // Allowed: the time-trial row can fill the leg, so it wins over history (rule 3, as before D9).
    const on = relayLegHistoryCandidates(wsWithHistory([real], ON), pool, Gender.MEN);
    expect(on.find(r => r.name === KILLACKEY && r.event === '100 Freestyle')).toBeUndefined();
  });
});

describe('the relay-leg swap ranking', () => {
  // A copy of Killackey's real time-trial row at 50 Free, so the 4x50 Free Relay A can see one.
  const syntheticFiftyTimeTrial: SwimmerResult = {
    ...killackeyTimeTrial,
    id: 'synthetic-tt-50-free',
    event: 'Event 300 Men 50 Yard Freestyle Time Trial',
    time: '20.80',
    finalsTime: '20.80',
  };
  const strict = (extra: Partial<ScoringSettings>): ScoringSettings => ({
    ...NSISC_PRESET_SETTINGS,
    scorerAutoRules: { ...NSISC_PRESET_SETTINGS.scorerAutoRules!, includeRelayLegsInFinals: false },
    ...extra,
  });
  const ranked = (extra: Partial<ScoringSettings>) => {
    const settings = strict(extra);
    const ws = workspace(
      {
        menResults: [...fixture.menResults, syntheticFiftyTimeTrial],
        deletedSwimmers: [{ name: 'Gavin Kock', gender: Gender.MEN }],
      },
      settings
    );
    return rankRelayLegSwaps(ws, { team: HSU, gender: Gender.MEN, settings });
  };

  it('does not offer a time-trial swimmer by default', () => {
    const off = ranked({});
    expect(off.swaps.some(s => s.inAthlete === KILLACKEY)).toBe(false);
    expect(off.swaps.some(s => s.inFromTimeTrial === true)).toBe(false);
    // The ranking is not empty: Scott Doll takes Gavin Kock's 4x50 leg.
    expect(off.swaps.some(s => s.relayEvent === M_200FR && s.inAthlete === 'Scott Doll')).toBe(true);
  });

  it('offers and labels it when allowed, and scores only that candidate extra', () => {
    const off = ranked({});
    const on = ranked(ON);
    const labelled = on.swaps.filter(s => s.inFromTimeTrial === true);
    expect(labelled.length).toBeGreaterThan(0);
    expect(labelled.every(s => s.inAthlete === KILLACKEY)).toBe(true);
    // Every other swap is the one the default ranking has.
    const key = (s: { relayEntryKey: string; legIndex: number; inAthlete: string; deltaPoints: number }) =>
      `${s.relayEntryKey}|${s.legIndex}|${s.inAthlete}|${s.deltaPoints}`;
    const rest = on.swaps.filter(s => s.inFromTimeTrial !== true).map(key).sort();
    expect(rest).toStrictEqual(off.swaps.map(key).sort());
    expect(on.candidatesEvaluated).toBeGreaterThan(off.candidatesEvaluated);
  });
});
