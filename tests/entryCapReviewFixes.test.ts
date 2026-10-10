/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Four entry-cap defects found by the architect review of 2026-10-01. Each case
 * below failed before its fix and pins it afterwards.
 *
 * 1. `applyScoringTheory` measured the total entry cap against raw meet rows. It
 *    ignored relay-leg overrides, inactive plans and the cross-plane collapse that
 *    the lineup audit applies, and its relay step checked no cap at all.
 * 2. A plan label ("50 Freestyle") and a HyTek label ("Event 4 Men 50 Yard
 *    Freestyle") were two entries in the theory and in the history import's
 *    `occupiesEvent`. They name one event (`swimEventIdentity`).
 * 3. `rankRelayLegSwaps` skipped the candidate cap check when the relay cap was
 *    999, so a swimmer at the TOTAL cap was offered another relay.
 * 4. `rankDropOnly` / `rankAddOnly` / `rankRelayLegSwaps` passed `undefined` as the
 *    alias resolver, so two linked spellings were two swimmers against one cap
 *    (docs/INVARIANTS.md item 6).
 *
 * Fixtures are synthetic: invented teams, names and times. The caps are NSISC's
 * (7 total) but nothing is keyed to a conference name: the cap value comes from
 * the settings object the workspace carries.
 */
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type HistoricalSwim,
  type RelayLegOverride,
  type SwimmerResult,
  type Workspace,
} from '../packages/core/src/types';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { applyScoringTheory, type ParsedScoringTheory } from '../packages/core/src/lib/scoringTheory';
import { importHistoryToRoster } from '../packages/core/src/lib/historyImportRoster';
import { countSwimmerEntries } from '../packages/core/src/lib/swimmerEntryLimits';
import { buildWhatIfResults } from '../packages/core/src/lib/whatIfProjection';
import { buildAliasResolver } from '../packages/core/src/lib/athleteAliases';
import { relayEntryKey } from '../packages/core/src/lib/relaySplits';
import { relayTemplateFromLeg } from '../packages/core/src/lib/relayLegMatching';
import { rankRelayLegSwaps } from '../packages/core/src/lib/arbitrage/relayLegSwaps';
import { rankAddOnly, rankDropOnly } from '../packages/core/src/lib/arbitrage/dropAdd';

const TEAM = 'Alpha University';
const RIVAL = 'Beta College';
const ANN = 'Ann Able';
const MATES = ['Bo Bee', 'Cy Cee', 'Di Dee', 'Ed Eff'];

function individual(
  id: string,
  name: string,
  event: string,
  time: string,
  extra: Partial<SwimmerResult> = {}
): SwimmerResult {
  return {
    id,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time,
    finalsTime: time,
    points: 0,
    event,
    gender: Gender.MEN,
    roundSwam: 'A Final',
    ...extra,
  } as SwimmerResult;
}

function relayRows(prefix: string, event: string, clock: string, legs: string[]): SwimmerResult[] {
  return legs.map((name, i) => ({
    id: `${prefix}-${i}`,
    rank: 1,
    name,
    classYear: 'JR',
    team: TEAM,
    time: clock,
    finalsTime: clock,
    relayTeamTime: clock,
    relayLegSplit: '20.00',
    roundSwam: 'A Final',
    points: 0,
    event,
    gender: Gender.MEN,
    isRelay: true,
    relayLegIndex: i,
    relayNames: legs.map(n => ({ name: n, year: 'JR' })),
  })) as SwimmerResult[];
}

/** The override that puts `name` on leg `legIndex` of the relay these rows describe. */
function legOverride(rows: SwimmerResult[], legIndex: number, name: string): RelayLegOverride {
  return {
    relayEntryKey: relayEntryKey(relayTemplateFromLeg(rows, rows[0])),
    legIndex,
    assigneeName: name,
    source: 'manual',
  };
}

function history(event: string, time: string, name = ANN): HistoricalSwim {
  return { name, team: TEAM, gender: Gender.MEN, event, time, timeType: 'SCY', source: 'paste' } as HistoricalSwim;
}

function workspace(menResults: SwimmerResult[], extra: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-entry-cap-review',
    name: 'entry cap review probe',
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
    scorerRosterOverrides: [],
    relayLegOverrides: [],
    athleteHistory: [
      history('500 Freestyle', '4:30.00'),
      history('100 Butterfly', '49.00'),
      history('200 Individual Medley', '1:50.00'),
      history('100 Backstroke', '50.00'),
    ],
    ...extra,
  } as unknown as Workspace;
}

/** What the lineup audit reports: `countSwimmerEntries` over the projected pool. */
function auditTotal(ws: Workspace, name = ANN): number {
  const pool = buildWhatIfResults({ workspace: ws, gender: Gender.MEN, removeSeniors: false });
  return countSwimmerEntries(pool, TEAM, Gender.MEN, name, buildAliasResolver(ws)).total ?? 0;
}

function theory(swimmers: ParsedScoringTheory['swimmers'], relays: ParsedScoringTheory['relays'] = []): ParsedScoringTheory {
  return { swimmers, relays, others: [], warnings: [] };
}


// ---------------------------------------------------------------------------
// Fixtures shared by the theory cases
// ---------------------------------------------------------------------------

const ANN_FREE_SWIMS = [
  individual('i1', ANN, 'Event 4 Men 50 Yard Freestyle', '20.10'),
  individual('i2', ANN, 'Event 10 Men 100 Yard Freestyle', '45.10'),
  individual('i3', ANN, 'Event 16 Men 200 Yard Freestyle', '1:39.00'),
];
const R200 = relayRows('r200', 'Event 1 Men 200 Yard Freestyle Relay', '1:20.00', MATES);
const R400 = relayRows('r400', 'Event 3 Men 400 Yard Freestyle Relay', '2:58.00', MATES);
const R800 = relayRows('r800', 'Event 5 Men 800 Yard Freestyle Relay', '6:40.00', MATES);
/**
 * Ann holds a leg on each of three relays only through an override: audit count 3 + 3 = 6.
 * An override applies only to a leg whose holder has left, so Ed Eff (leg 3 of every
 * relay) is a removed swimmer.
 */
const ED_LEFT = [{ name: 'Ed Eff', gender: Gender.MEN }];
const THREE_OVERRIDES = [legOverride(R200, 3, ANN), legOverride(R400, 3, ANN), legOverride(R800, 3, ANN)];

describe('fix 1: the theory counts entries the way the lineup audit does', () => {
  const base = () =>
    workspace([...ANN_FREE_SWIMS, ...R200, ...R400, ...R800], { relayLegOverrides: THREE_OVERRIDES, deletedSwimmers: ED_LEFT });

  it('the fixture is at 6 of 7 by the audit (control)', () => {
    expect(auditTotal(base())).toBe(6);
  });

  it('adds one entry, not four, to a swimmer at 6 of 7 through relay-leg overrides', () => {
    const ws = base();
    const result = applyScoringTheory(
      ws,
      theory([{ rawName: ANN, events: ['500 Freestyle', '100 Butterfly', '200 Individual Medley', '100 Backstroke'] }]),
      { team: TEAM, gender: Gender.MEN }
    );
    expect(result.summary.entriesAdded).toBe(1);
    expect(result.warnings.filter(w => /total entry cap/.test(w))).toHaveLength(3);
    expect(auditTotal({ ...ws, ...result.patch })).toBe(7);
  });

  it('an inactive plan does not spend an entry', () => {
    const inactive = ['500 Freestyle', '100 Butterfly', '200 Individual Medley', '200 Backstroke'].map((event, i) => ({
      id: `p${i}`,
      name: ANN,
      team: TEAM,
      gender: Gender.MEN,
      event,
      time: '1:00.00',
      timeType: 'SCY' as const,
      source: 'manual' as const,
      active: false,
    }));
    const ws = workspace(ANN_FREE_SWIMS, { meetEntryPlans: inactive as never, activeEntryIds: [] });
    expect(auditTotal(ws)).toBe(3);
    const result = applyScoringTheory(ws, theory([{ rawName: ANN, events: ['100 Backstroke'] }]), {
      team: TEAM,
      gender: Gender.MEN,
    });
    expect(result.summary.entriesAdded).toBe(1);
  });

  describe('the relay step', () => {
    /** 3 individual + 3 override relays + 1 raw relay leg = 7 of 7. */
    const R_MEDLEY = relayRows('rmed', 'Event 7 Men 400 Yard Medley Relay', '3:15.00', [ANN, ...MATES.slice(0, 3)]);
    const R_FIFTH = relayRows('r1600', 'Event 9 Men 200 Yard Medley Relay', '1:30.00', MATES);
    const full = () =>
      workspace([...ANN_FREE_SWIMS, ...R200, ...R400, ...R800, ...R_MEDLEY, ...R_FIFTH], {
        relayLegOverrides: THREE_OVERRIDES,
        deletedSwimmers: ED_LEFT,
      });
    const fifth = theory([], [
      { event: '200 Medley Relay', squad: 'A', legs: [{ name: ANN, alternates: [] }] },
    ]);

    it('the fixture is at 7 of 7 by the audit (control)', () => {
      expect(auditTotal(full())).toBe(7);
    });

    it('refuses to put a swimmer at the total cap on another relay', () => {
      const result = applyScoringTheory(full(), fifth, { team: TEAM, gender: Gender.MEN });
      expect(result.summary.relayLegsAssigned).toBe(0);
      expect(result.warnings.some(w => /total entry cap/.test(w))).toBe(true);
      expect((result.patch.relayLegOverrides ?? []).length).toBe(THREE_OVERRIDES.length);
    });

    it('still assigns a swimmer with room (control)', () => {
      const ws = workspace([...ANN_FREE_SWIMS, ...R200, ...R400, ...R800, ...R_FIFTH], {
        relayLegOverrides: THREE_OVERRIDES,
        deletedSwimmers: ED_LEFT,
      });
      expect(auditTotal(ws)).toBe(6);
      const result = applyScoringTheory(ws, fifth, { team: TEAM, gender: Gender.MEN });
      expect(result.summary.relayLegsAssigned).toBe(1);
    });

    it('counts an entry the same apply added for this swimmer (the 7th is spent before the relay)', () => {
      const ws = workspace([...ANN_FREE_SWIMS, ...R200, ...R400, ...R800, ...R_FIFTH], {
        relayLegOverrides: THREE_OVERRIDES,
        deletedSwimmers: ED_LEFT,
      });
      const both = theory([{ rawName: ANN, events: ['500 Freestyle'] }], fifth.relays);
      const result = applyScoringTheory(ws, both, { team: TEAM, gender: Gender.MEN });
      expect({ entries: result.summary.entriesAdded, legs: result.summary.relayLegsAssigned }).toEqual({
        entries: 1,
        legs: 0,
      });
      expect(auditTotal({ ...ws, ...result.patch })).toBe(7);
    });

    it('does not charge a second entry for a relay the swimmer already holds', () => {
      const again = theory([], [
        { event: '200 Freestyle Relay', squad: 'A', legs: [{ name: ANN, alternates: [] }] },
      ]);
      const result = applyScoringTheory(full(), again, { team: TEAM, gender: Gender.MEN });
      expect(result.summary.relayLegsAssigned).toBe(1);
    });
  });
});

describe('fix 2: a plan label and a HyTek label are one event', () => {
  it('a theory plan for an event the swimmer swims at the meet replaces it and spends no entry', () => {
    const ws = workspace([
      ...ANN_FREE_SWIMS,
      ...relayRows('a', 'Event 1 Men 200 Yard Freestyle Relay', '1:20.00', [ANN, ...MATES.slice(0, 3)]),
      ...relayRows('b', 'Event 3 Men 400 Yard Freestyle Relay', '2:58.00', [ANN, ...MATES.slice(0, 3)]),
      ...relayRows('c', 'Event 5 Men 800 Yard Freestyle Relay', '6:40.00', [ANN, ...MATES.slice(0, 3)]),
    ]);
    expect(auditTotal(ws)).toBe(6);
    const withHistory = { ...ws, athleteHistory: [...(ws.athleteHistory ?? []), history('50 Freestyle', '20.00')] };
    const parsed = theory([{ rawName: ANN, events: ['50 Freestyle', '500 Freestyle'] }]);
    const result = applyScoringTheory(withHistory, parsed, { team: TEAM, gender: Gender.MEN });
    // The 50 Freestyle plan replaces the meet row (one entry); the 500 is the 7th.
    expect((result.patch.meetEntryPlans ?? []).map(p => p.event).sort()).toEqual(['50 Freestyle', '500 Freestyle']);
    expect(result.warnings.filter(w => /entry cap/.test(w))).toEqual([]);
    const applied = { ...withHistory, ...result.patch };
    expect(auditTotal(applied)).toBe(7);

    // At 7 of 7 the swimmer still gets the plan that replaces an entry she holds, and nothing else.
    const full = workspace(
      [
        ...ANN_FREE_SWIMS,
        ...relayRows('a', 'Event 1 Men 200 Yard Freestyle Relay', '1:20.00', [ANN, ...MATES.slice(0, 3)]),
        ...relayRows('b', 'Event 3 Men 400 Yard Freestyle Relay', '2:58.00', [ANN, ...MATES.slice(0, 3)]),
        ...relayRows('c', 'Event 5 Men 800 Yard Freestyle Relay', '6:40.00', [ANN, ...MATES.slice(0, 3)]),
        ...relayRows('d', 'Event 7 Men 400 Yard Medley Relay', '3:15.00', [ANN, ...MATES.slice(0, 3)]),
      ],
      { athleteHistory: withHistory.athleteHistory }
    );
    expect(auditTotal(full)).toBe(7);
    const atCap = applyScoringTheory(full, parsed, { team: TEAM, gender: Gender.MEN });
    expect((atCap.patch.meetEntryPlans ?? []).map(p => p.event)).toEqual(['50 Freestyle']);
    expect(atCap.warnings.filter(w => /total entry cap/.test(w))).toHaveLength(1);
    expect(auditTotal({ ...full, ...atCap.patch })).toBe(7);

    // Applied again, both events are planned: neither is added twice.
    const again = applyScoringTheory(applied, parsed, { team: TEAM, gender: Gender.MEN });
    expect(again.summary.entriesAdded).toBe(0);
    expect(again.warnings.filter(w => /already has a plan/.test(w))).toHaveLength(2);
  });

  describe('the history import', () => {
    const NAME = 'Jay Oak';
    const sixEntries = (): SwimmerResult[] => [
      individual('s1', NAME, 'Event 15 Men 400 Yard IM', '4:14.81'),
      individual('s2', NAME, 'Event 26 Men 100 Yard Breaststroke', '55.16'),
      individual('s3', NAME, 'Event 28 Men 200 Yard Butterfly', '2:00.72'),
      individual('s4', NAME, 'Event 39 Men 200 Yard Breaststroke', '2:01.43'),
      ...relayRows('sr1', 'Event 11 Men 4x50 Yard Medley Relay', '1:29.58', [NAME, ...MATES.slice(0, 3)]),
      ...relayRows('sr2', 'Event 20 Men 4x100 Yard Medley Relay', '3:16.45', [NAME, ...MATES.slice(0, 3)]),
    ];
    const FIELD = [
      individual('f1', 'Bo Bee', 'Event 30 Men 200 Yard Backstroke', '1:52.00'),
      individual('f2', 'Bo Bee', 'Event 26 Men 100 Yard Breaststroke', '56.00'),
    ];
    const swim = (event: string, time: string): HistoricalSwim =>
      ({ name: NAME, team: TEAM, gender: Gender.MEN, event, time, timeType: 'SCY', source: 'swimcloud', meet: 'Invite', date: '2026-01-01' }) as HistoricalSwim;

    it('still writes no plan for an event the meet labels exactly as the candidate (unchanged)', () => {
      const plain = [individual('p1', NAME, '100 Breaststroke', '55.16'), ...FIELD.slice(0, 1)];
      const ws = workspace(plain, { athleteHistory: [] });
      const res = importHistoryToRoster(ws, [swim('100 Breaststroke', '55.00')], { team: TEAM, gender: Gender.MEN });
      expect(res.patch.meetEntryPlans ?? []).toEqual([]);
    });

    it('does not charge a plan twice when it names an event the swimmer swims at the meet', () => {
      const plan = {
        id: 'plan-1',
        name: NAME,
        team: TEAM,
        gender: Gender.MEN,
        event: '100 Breaststroke',
        time: '55.00',
        timeType: 'SCY' as const,
        source: 'manual' as const,
        active: true,
      };
      const ws = workspace([...sixEntries(), ...FIELD], {
        athleteHistory: [],
        meetEntryPlans: [plan] as never,
        activeEntryIds: ['plan-1'],
      });
      expect(auditTotal(ws, NAME)).toBe(6);
      const res = importHistoryToRoster(ws, [swim('200 Backstroke', '1:50.00')], { team: TEAM, gender: Gender.MEN });
      expect(res.summary.lineupEntriesAdded).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the arbitrage cases (modelled on scripts/test_relay_swaps.mjs)
// ---------------------------------------------------------------------------

const ELIG_SETTINGS = {
  scoringPoints: [9, 7, 6, 5, 4, 3, 2, 1],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 18,
  maxRelaysScoringPerTeam: 999,
  aFinalBracketSize: 8,
  scorerCapScope: 'meet',
  scorerEligibilityMode: 'roster',
  scorerAutoRules: {
    abFinalTiers: ['A', 'B'],
    includeRelayLegsInFinals: false,
    distanceFinalRequired: true,
    distanceEventPattern: ['1000', '1650', '1500'],
  },
  diverEventPattern: ['DIVING', 'DIVE'],
  maxIndividualEntriesPerSwimmer: 999,
  maxRelayEntriesPerSwimmer: 999,
};

const FIVE = 'Alpha Five';
const FIVE_ALIAS = 'Alfa Five';

function swapWorkspace(
  settings: Record<string, unknown>,
  extraResults: SwimmerResult[] = [],
  extra: Partial<Workspace> = {}
): Workspace {
  const ind = (id: string, name: string, team: string, event: string, time: string, rank: number) =>
    individual(id, name, event, time, { team, rank });
  const menResults = [
    ind('a1', 'Alpha One', TEAM, '50 Freestyle', '20.00', 2),
    ind('a2', 'Alpha Two', TEAM, '50 Freestyle', '20.50', 3),
    ind('a3', 'Alpha Three', TEAM, '50 Freestyle', '21.00', 4),
    ind('a5', FIVE, TEAM, '50 Freestyle', '20.20', 5),
    ind('b1', 'Beta One', RIVAL, '50 Freestyle', '19.90', 1),
    ...relayRows('rel', '200 Yard Freestyle Relay', '1:22.00', ['Alpha One', 'Alpha Two', 'Alpha Three', 'Alpha Four']),
    ...extraResults,
  ];
  return {
    id: 'ws-swap',
    name: 'swap probe',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    scoringSettings: settings,
    conference: undefined,
    meetEntryPlans: [],
    activeEntryIds: [],
    athleteHistory: [
      { name: FIVE, team: TEAM, gender: Gender.MEN, event: '50 Freestyle', time: '20.20', timeType: 'SCY', source: 'paste' },
    ],
    historySources: [],
    scorerRosterOverrides: [{ name: 'Alpha Four', team: TEAM, gender: Gender.MEN, isScorer: false }],
    relayLegOverrides: [],
    deletedSwimmers: [],
    ...extra,
  } as unknown as Workspace;
}

/** Two more individual events for Alpha Five, so she holds 3 individual entries in total. */
const FIVE_EXTRA = (name: string) => [
  individual('x1', name, '100 Freestyle', '45.00', { rank: 5 }),
  individual('x2', name, '200 Freestyle', '1:40.00', { rank: 5 }),
];

describe('fix 3: the relay-swap candidate check honours the total cap', () => {
  const fiveIsOffered = (ws: Workspace) =>
    rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings as never }).swaps.some(
      s => s.inAthlete === FIVE
    );

  it('offers a swimmer with room under a total cap (control)', () => {
    const ws = swapWorkspace({ ...ELIG_SETTINGS, maxTotalEntriesPerSwimmer: 4 }, FIVE_EXTRA(FIVE));
    expect(fiveIsOffered(ws)).toBe(true);
  });

  it('still offers a swimmer at the total cap a leg on a relay event she already swims', () => {
    // Her entries: 50, 100 and 200 Freestyle, plus the 200 Free Relay on squad B: 4 of 4.
    // A leg on squad A of the same relay adds no entry.
    const squadB = relayRows('relB', '200 Yard Freestyle Relay', '1:30.00', [FIVE, 'Alpha Six', 'Alpha Seven', 'Alpha Eight']).map(
      r => ({ ...r, rank: 2 })
    );
    const ws = swapWorkspace({ ...ELIG_SETTINGS, maxTotalEntriesPerSwimmer: 4 }, [...FIVE_EXTRA(FIVE), ...squadB]);
    expect(countSwimmerEntries(ws.menResults ?? [], TEAM, Gender.MEN, FIVE).total).toBe(4);
    expect(fiveIsOffered(ws)).toBe(true);
  });

  it('does not offer a swimmer at the total cap another relay', () => {
    const ws = swapWorkspace({ ...ELIG_SETTINGS, maxTotalEntriesPerSwimmer: 3 }, FIVE_EXTRA(FIVE));
    expect(fiveIsOffered(ws)).toBe(false);
  });
});

describe('fix 4: the arbitrage rankings resolve linked spellings', () => {
  const link = {
    id: 'link-1',
    gender: Gender.MEN,
    team: TEAM,
    canonicalName: FIVE,
    aliasName: FIVE_ALIAS,
    source: 'manual' as const,
    status: 'active' as const,
  };

  it('rankRelayLegSwaps does not offer a swimmer whose other spelling fills the cap', () => {
    // Under the alias spelling Alpha Five holds 2 more entries: 3 in all, at a total cap of 3.
    const ws = swapWorkspace(
      { ...ELIG_SETTINGS, maxTotalEntriesPerSwimmer: 3 },
      FIVE_EXTRA(FIVE_ALIAS),
      { athleteAliases: [link] as never }
    );
    const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings as never });
    expect(ranking.swaps.some(s => s.inAthlete === FIVE)).toBe(false);
  });

  it('rankRelayLegSwaps offers the swimmer when no link exists (control)', () => {
    const ws = swapWorkspace({ ...ELIG_SETTINGS, maxTotalEntriesPerSwimmer: 3 }, FIVE_EXTRA(FIVE_ALIAS));
    const ranking = rankRelayLegSwaps(ws, { team: TEAM, gender: Gender.MEN, settings: ws.scoringSettings as never });
    expect(ranking.swaps.some(s => s.inAthlete === FIVE)).toBe(true);
  });

  /**
   * A field with no relay. Alpha Five swims 2 events under her own spelling and 2 under the
   * linked one: 4 individual entries against a cap of 3, but only 2 and 2 if the spellings
   * are two swimmers.
   */
  function capWorkspace(opts: { linked: boolean; held: number; history?: HistoricalSwim[] }): Workspace {
    const events = ['100 Freestyle', '200 Freestyle', '100 Backstroke', '100 Breaststroke'];
    const rows = [
      ...events.slice(0, opts.held).map((ev, i) =>
        individual(`f${i}`, i < 2 ? FIVE : FIVE_ALIAS, ev, '50.00', { rank: 1 })
      ),
      ...events.map((ev, i) => individual(`b${i}`, 'Beta One', ev, '51.00', { team: RIVAL, rank: 2 })),
    ];
    return {
      ...workspace(rows, {
        scoringSettings: { ...ELIG_SETTINGS, maxIndividualEntriesPerSwimmer: 3 } as never,
        conference: undefined,
        athleteHistory: opts.history ?? [],
        athleteAliases: opts.linked ? ([link] as never) : [],
      }),
    } as Workspace;
  }

  it('rankDropOnly sees a swimmer over the cap across two spellings', () => {
    const drops = (linked: boolean) =>
      rankDropOnly(capWorkspace({ linked, held: 4 }), { team: TEAM, gender: Gender.MEN }).drops.filter(
        d => d.capRelief
      ).length;
    expect(drops(false)).toBe(0);
    expect(drops(true)).toBeGreaterThan(0);
  });

  it('rankAddOnly offers no add to a swimmer at the cap across two spellings', () => {
    const hist = ['100 Butterfly', '200 Butterfly'].map(ev => history(ev, '49.00', FIVE));
    const evaluated = (linked: boolean) =>
      rankAddOnly(capWorkspace({ linked, held: 3, history: hist }), { team: TEAM, gender: Gender.MEN })
        .candidatesEvaluated;
    expect(evaluated(false)).toBeGreaterThan(0);
    expect(evaluated(true)).toBe(0);
  });
});
