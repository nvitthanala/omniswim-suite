/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A7: the `robust` objective (plans/2026-10-25/D5-AUTOBUILDER.md, 5.4, 8.2, 8.4, 12.7 and 14.1). Every fixture is synthetic and
 * every rule is the shipped `nsisc` v4 with the settings a test names changed. No time, date or point value here is a competition value.
 * The oracle is `scoreMeet`: the brute force scores every entry set through a whole-meet call with the robust swims pinned, and the
 * AutoBuilder must equal the best one. The robust swim is written out here a second time, independent of `robust.ts`, so a drift in the
 * rule shows as a difference.
 */
import { describe, expect, it } from 'vitest';
import { AutoBuildError, autoBuild, builtinRulePreset, entryKey, requireComplete, scoreMeet } from '@omniswim/engine';
import type {
  RelaySplit,
  AutoBuildLimits,
  AutoBuildRequest,
  AutoBuildResult,
  CompleteRulePreset,
  ConversionSettings,
  DateWindow,
  Lineup,
  LineupEntry,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MipSolve,
  RulePreset,
  ScheduledEvent,
  ScorerTag,
} from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { Evaluator, sameRows } from '../packages/engine/src/autobuilder/evaluate';
import { pinLineup, spreadOf } from '../packages/engine/src/autobuilder/robust';
import { buildSnapshot } from './helpers/simulatorFixtures';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set, TEST_PROVENANCE } from './engineTestPresets';

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const E1 = '100 Freestyle';
const E2 = '100 Backstroke';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';
type Gender = 'Men' | 'Women';
const LIMITS: AutoBuildLimits = { candidatesPerEvent: 8, maxCandidatesPerEvent: 12, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 };
const RANGE: DateWindow = { kind: 'dates', from: '2025-09-01', to: '2026-06-30' };
const ROBUST = { kind: 'robust', recentSwims: 5, minSwims: 3 } as const;

// ---- builders ----------------------------------------------------------------------------------

interface SwimSpec {
  readonly time: number;
  /** `null`: an undated swim. */
  readonly date: string | null;
  readonly id?: string;
  readonly seasonId?: string | null;
  readonly converted?: boolean;
  readonly userInputted?: boolean;
  readonly extractedSplit?: boolean;
  /** `true`: no time (NT). */
  readonly nt?: boolean;
}

interface Spec {
  readonly id: string;
  readonly team: string;
  readonly gender?: Gender;
  /** Swims by event key. */
  readonly swims: Readonly<Record<string, readonly SwimSpec[]>>;
}

const meetEvent = (eventKey: string, gender: Gender = 'Men'): MeetEvent =>
  eventKey === DIVE
    ? { eventKey, gender, kind: 'diving', distanceYards: null, relayKind: null }
    : eventKey === RELAY
      ? { eventKey, gender, kind: 'relay', distanceYards: 400, relayKind: 'freestyle' }
      : { eventKey, gender, kind: 'individual', distanceYards: 100, relayKind: null };

function swimOf(swimmerId: string, eventKey: string, s: SwimSpec, index: number): MeetSwim {
  return {
    swimId: s.id ?? `${swimmerId}:${eventKey}:${index}`,
    swimmerId,
    eventKey,
    recordedCourse: s.converted === true ? 'LCM' : 'SCY',
    recordedTime: s.nt === true ? null : { text: (s.time / 100).toFixed(2), hundredths: s.time },
    date: s.date,
    seasonId: s.seasonId === undefined ? '2025-26' : s.seasonId,
    flags: { ...(s.userInputted === true ? { userInputted: true } : {}), ...(s.extractedSplit === true ? { extractedSplit: true } : {}) },
    scy: s.converted === true ? { kind: 'converted', hundredths: s.time, basis: { method: 'swimcloud', displayedText: 'synthetic' }, estimated: true } : { kind: 'recorded-scy' },
    origin: ORIGIN,
  };
}

function buildModel(specs: readonly Spec[], eventKeys: readonly string[], range: DateWindow = RANGE, genders: readonly Gender[] = ['Men']): MeetModel {
  const swims: MeetSwim[] = [];
  const splits: RelaySplit[] = [];
  for (const s of specs) for (const [eventKey, list] of Object.entries(s.swims)) list.forEach((x, i) => swims.push(swimOf(s.id, eventKey, x, i)));
  // A flying split for every swimmer with a 100 free swim: the swim named `<id>:100 Freestyle` minus one second (synthetic).
  for (const s of specs) {
    const free = (s.swims[E1] ?? []).find((x) => x.id === `${s.id}:${E1}`);
    if (free !== undefined) {
      splits.push({ splitId: `split-${s.id}`, swimmerId: s.id, relayEventKey: null, legPosition: null, start: 'flying', legEventKey: E1, split: { text: ((free.time - 100) / 100).toFixed(2), hundredths: free.time - 100 }, course: 'SCY', date: null, origin: ORIGIN });
    }
  }
  const teamIds = [...new Set(specs.map((s) => s.team))];
  return {
    payloadVersion: 1,
    meetKey: 'synthetic',
    teams: teamIds.map((teamId) => ({ teamId, division: { state: 'unknown', reason: 'unmapped_team' } })),
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? 'Men', classYear: null, roster: 'member' })),
    events: genders.flatMap((g) => eventKeys.map((k) => meetEvent(k, g))),
    swims,
    relaySplits: splits,
    recordRange: range,
    extendedWindow: false,
    observedScores: null,
  };
}

const ind = (team: string, swimmerId: string, eventKey: string, gender: Gender = 'Men'): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey, gender, seedSwimId: null });
const relay = (team: string, letter: string, ids: readonly string[]): LineupEntry => ({
  kind: 'relay',
  teamId: team,
  eventKey: RELAY,
  gender: 'Men',
  letter,
  legs: ids.map((swimmerId, i) => ({
    swimmerId,
    basis: i === 0 ? { kind: 'flat-start-swim' as const, swimId: `${swimmerId}:${E1}` } : { kind: 'split' as const, splitId: `split-${swimmerId}` },
  })) as unknown as Extract<LineupEntry, { kind: 'relay' }>['legs'],
});
const lineup = (...entries: LineupEntry[]): Lineup => ({ payloadVersion: 1, meetKey: 'synthetic', entries });
const tags = (team: string, ids: readonly string[]): ScorerTag[] => ids.map((swimmerId) => ({ teamId: team, swimmerId, role: 'scorer' as const }));

interface RuleOpts {
  readonly cap?: number;
  readonly maxInd?: number;
}

/** nsisc v4 with the settings a test names changed. */
function rulesOf(o: RuleOpts = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 4) as RulePreset;
  return requireComplete({
    ...base,
    scorers: { ...base.scorers, ...(o.cap === undefined ? {} : { perEventScorerCap: set({ cap: o.cap, overCap: 'removed-from-consideration' as const }) }) },
    entries: { ...base.entries, ...(o.maxInd === undefined ? {} : { maxIndividualPerSwimmer: set(o.maxInd) }) },
  });
}

interface Fx {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly tags: readonly ScorerTag[];
  readonly rules: CompleteRulePreset;
}

function request(fx: Fx, over: Partial<AutoBuildRequest> = {}): AutoBuildRequest {
  return { model: fx.model, lineup: fx.lineup, rules: fx.rules, sourcing: SOURCING, tags: fx.tags, ownTeamId: 'A', genders: ['Men'], objective: ROBUST, load: null, limits: LIMITS, ...over };
}

async function autoError(run: () => Promise<unknown>): Promise<AutoBuildError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AutoBuildError) return error;
    throw error;
  }
  throw new Error('did not throw');
}

/** Dated swims, newest first, one per day in March 2026: `[4900, 5100]` is a swim of 4900 on 2026-03-02 and one of 5100 on 2026-03-01. */
const dated = (times: readonly number[], first = 28): SwimSpec[] => times.map((time, i) => ({ time, date: `2026-03-${String(first - i).padStart(2, '0')}` }));

// ---- the robust swim, written a second time -------------------------------------------------------

/** The oracle of D5 5.4: the robust swim id of one pair, or `null` when the spread is absent. Independent of `robust.ts`. */
function oracleSwim(swims: readonly MeetSwim[], range: DateWindow, diving: boolean, recent: number, min: number): string | null {
  const ok = swims.filter((s) => {
    if (s.flags.extractedSplit === true || s.flags.userInputted === true || s.flags.programUnconfirmed === true) return false;
    if (s.scy.kind !== 'recorded-scy' || s.date === null || s.recordedTime === null) return false;
    if (range.kind === 'dates') return s.date >= range.from && s.date <= range.to;
    return s.seasonId !== null && range.seasonIds.includes(s.seasonId);
  });
  const newest = [...ok].sort((a, b) => (a.date as string < (b.date as string) ? 1 : a.date === b.date ? (a.swimId < b.swimId ? -1 : 1) : -1)).slice(0, recent);
  if (newest.length < min) return null;
  const t = (s: MeetSwim): number => (s.recordedTime as { hundredths: number }).hundredths;
  const fastFirst = [...newest].sort((a, b) => (diving ? t(b) - t(a) : t(a) - t(b)) || (a.swimId < b.swimId ? -1 : 1));
  return (fastFirst[Math.ceil((fastFirst.length - 1) / 2)] as MeetSwim).swimId;
}

const swimsOf = (id: string, times: readonly SwimSpec[], eventKey = E1): MeetSwim[] => times.map((s, i) => swimOf(id, eventKey, s, i));

// ---- the volatile and the consistent swimmer -------------------------------------------------------

/**
 * One event, a cap of one own scorer. V is volatile: a best of 40.00 in September, then five recent swims of 49.00, 51.00, 49.50, 50.00 and 49.00, so
 * the robust swim is 49.50 (the slower middle of the five). C is consistent: 43.00 to 43.40, robust 43.20. Rivals stand at 41.00, 43.10 and 46.00, each on a team of its own (the cap of one scorer applies to every team).
 *
 * Normal seeds: V 40.00 is 1st (20 points), C 43.00 is 2nd (17). Robust seeds: C 43.20 is 3rd behind 43.10 (16), V 49.50 is 4th (15).
 */
function volatile(current: 'none' | 'V' | 'C'): Fx {
  const specs: Spec[] = [
    { id: 'V', team: 'A', swims: { [E1]: [...dated([4900, 5100, 4950, 5000, 4900]), { time: 4000, date: '2025-10-01' }] } },
    { id: 'C', team: 'A', swims: { [E1]: dated([4310, 4320, 4330, 4300, 4340]) } },
    { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }] } },
    { id: 'R3', team: 'D', swims: { [E1]: [{ time: 4310, date: null }] } },
    { id: 'R2', team: 'E', swims: { [E1]: [{ time: 4600, date: null }] } },
  ];
  const own = current === 'none' ? [] : [ind('A', current, E1)];
  return {
    model: buildModel(specs, [E1]),
    lineup: lineup(...own, ind('B', 'R1', E1), ind('D', 'R3', E1), ind('E', 'R2', E1)),
    tags: [...tags('A', ['V', 'C']), ...tags('B', ['R1']), ...tags('D', ['R3']), ...tags('E', ['R2'])],
    rules: rulesOf({ cap: 1 }),
  };
}

const ownTotal = (r: { teams: readonly { teamId: string; points: number }[] }): number => (r.teams.find((t) => t.teamId === 'A') as { points: number }).points;
const entered = (l: Lineup): string[] => l.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A').map((e) => (e as { swimmerId: string }).swimmerId).sort();

describe('autoBuild (D5, slice A7: robust)', () => {
  it('1 robustSwimIsSlowerMiddle: the swim at index ceil((n - 1) / 2) of the most recent, fastest first, over real dated SCY swims only', () => {
    const settings = { recentSwims: 5, minSwims: 3 };
    const pick = (list: readonly SwimSpec[], over: Partial<typeof settings> = {}, range: DateWindow = RANGE, diving = false) =>
      spreadOf(swimsOf('s', list), range, diving, { ...settings, ...over });
    // Five: fastest first 4900 4950 5000 5100 5200, index 2.
    const five = dated([5000, 4900, 5200, 4950, 5100]);
    expect(pick(five)).toMatchObject({ present: true, swims: 5 });
    expect((pick(five) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5000);
    // Three: index 1, the middle. Four: index ceil(1.5) = 2, the slower of the two middle swims.
    expect((pick(dated([4900, 5100, 5000])) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5000);
    expect((pick(dated([4900, 5100, 5000, 4800])) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5000);
    // Two swims with minSwims 3: no spread, and the count is reported.
    expect(pick(dated([4900, 5000]))).toEqual({ present: false, swims: 2 });
    expect(pick(dated([4900, 5000]), { minSwims: 2 })).toMatchObject({ present: true, swims: 2 });
    expect(pick([])).toEqual({ present: false, swims: 0 });
    // A sixth, older swim is ignored, even when it is the fastest, and the five are the newest by date and not by position in the list.
    const older = [...five, { time: 3000, date: '2026-02-01' }];
    expect((pick(older) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5000);
    expect((pick([...older].reverse()) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5000);
    // recentSwims and minSwims come from the request.
    const mixed = dated([4900, 5100, 5300, 4800, 5000]);
    expect((pick(mixed) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5000); // five: 4800 4900 5000 5100 5300
    expect(pick(mixed, { recentSwims: 3 })).toMatchObject({ present: true, swims: 3 });
    expect((pick(mixed, { recentSwims: 3 }) as { swim: MeetSwim }).swim.recordedTime?.hundredths).toBe(5100); // the newest three: 4900 5100 5300
  });

  it('1b robustSwimIgnores: undated, converted, out-of-range, user-typed, extracted-split and no-time swims never count', () => {
    const base = dated([5000, 5100, 4900]);
    const settings = { recentSwims: 5, minSwims: 3 };
    const count = (extra: readonly SwimSpec[], range: DateWindow = RANGE): number => spreadOf(swimsOf('s', [...base, ...extra]), range, false, settings).swims;
    expect(count([])).toBe(3);
    expect(count([{ time: 3000, date: null }])).toBe(3); // undated
    expect(count([{ time: 3000, date: '2026-03-30', converted: true }])).toBe(3); // a converted estimate
    expect(count([{ time: 3000, date: '2025-08-31' }])).toBe(3); // before the range
    expect(count([{ time: 3000, date: '2026-07-01' }])).toBe(3); // after the range
    expect(count([{ time: 3000, date: '2026-03-30', userInputted: true }])).toBe(3);
    expect(count([{ time: 3000, date: '2026-03-30', extractedSplit: true }])).toBe(3);
    expect(count([{ time: 0, date: '2026-03-30', nt: true }])).toBe(3); // no time
    // The range bounds are inclusive.
    expect(count([{ time: 3000, date: '2025-09-01' }, { time: 3000, date: '2026-06-30' }])).toBe(5);
    // A season window needs a listed season id.
    const seasons: DateWindow = { kind: 'seasons', seasonIds: ['2025-26'] };
    expect(count([{ time: 3000, date: '2026-03-30', seasonId: '2024-25' }], seasons)).toBe(3);
    expect(count([{ time: 3000, date: '2026-03-30', seasonId: null }], seasons)).toBe(3);
    expect(count([{ time: 3000, date: '2026-03-30', seasonId: '2025-26' }], seasons)).toBe(4);
    expect(count([{ time: 3000, date: null, seasonId: '2025-26' }], seasons)).toBe(3); // an undated swim never counts, in either window
    // A season window reads the season id and not the date.
    expect(count([{ time: 3000, date: '2020-01-01' }], seasons)).toBe(4);
    // A date tie breaks by swim id, and the choice is the same in either input order.
    const tie: SwimSpec[] = [
      { time: 4800, date: '2026-03-10', id: 'b' },
      { time: 5200, date: '2026-03-10', id: 'a' },
      { time: 5300, date: '2026-03-10', id: 'c' },
      { time: 5250, date: '2026-03-10', id: 'd' },
    ];
    const first = spreadOf(swimsOf('s', tie), RANGE, false, { recentSwims: 3, minSwims: 3 }) as { swim: MeetSwim };
    const second = spreadOf(swimsOf('s', [...tie].reverse()), RANGE, false, { recentSwims: 3, minSwims: 3 }) as { swim: MeetSwim };
    expect(first.swim.swimId).toBe(second.swim.swimId);
    expect(first.swim.swimId).toBe('a'); // the three smallest swim ids a, b, c; fastest first b (4800), a (5200), c (5300): index 1. Taking d instead of a gives d.
    // A dive: higher is better, so the robust swim is the slower middle by score.
    const dive = [24000, 26000, 25000, 27000].map((time, i) => swimOf('d', DIVE, { time, date: `2026-03-${String(10 - i).padStart(2, '0')}` }, i));
    const picked = spreadOf(dive, RANGE, true, { recentSwims: 5, minSwims: 3 }) as { swim: MeetSwim };
    expect(picked.swim.recordedTime?.hundredths).toBe(25000); // highest first 27000 26000 25000 24000, index ceil(1.5) = 2
  });

  it('2 frozenPairIsListed: a pair with fewer than three swims is never added, is listed with its swim count, and is not in the optimum', async () => {
    // F has the fastest normal swim of the team (3800), but two swims only. G has five. One event, cap 1.
    const specs: Spec[] = [
      { id: 'F', team: 'A', swims: { [E1]: dated([4400, 3800]) } },
      { id: 'G', team: 'A', swims: { [E1]: dated([4700, 4720, 4710, 4730, 4740]) } },
      { id: 'R', team: 'B', swims: { [E1]: [{ time: 4300, date: null }] } },
    ];
    const fx: Fx = { model: buildModel(specs, [E1]), lineup: lineup(ind('B', 'R', E1)), tags: [...tags('A', ['F', 'G']), ...tags('B', ['R'])], rules: rulesOf({ cap: 1 }) };
    const max = await autoBuild(request(fx, { objective: { kind: 'max-own' } }), nodeMipSolve());
    expect(max.kind === 'improved' && entered(max.proposal.lineup)).toEqual(['F']);
    expect(max.proof.searchSpace.frozenPairs).toEqual([]);
    expect(max.proof.searchSpace.restrictions).not.toContain('robust_frozen_pairs');
    expect(max.kind === 'improved' && max.proposal.evaluation.robustOwnPoints).toBeNull();
    const robust = await autoBuild(request(fx), nodeMipSolve());
    expect(robust.kind).toBe('improved');
    if (robust.kind !== 'improved') return;
    expect(entered(robust.proposal.lineup)).toEqual(['G']);
    expect(robust.proof.status).toBe('proven_optimal');
    expect(robust.proof.searchSpace.frozenPairs).toEqual([{ swimmerId: 'F', eventKey: E1, gender: 'Men', swims: 2 }]);
    expect(robust.proof.searchSpace.restrictions).toContain('robust_frozen_pairs');
    expect(robust.proof.searchSpace.restrictionStatus.find((r) => r.restriction === 'robust_frozen_pairs')).toEqual({ restriction: 'robust_frozen_pairs', binding: false });
    // A pair with no swim at all has no usable seed, so it is not listed (it is not a candidate in any mode).
    const none: Fx = { ...fx, model: buildModel([...specs, { id: 'H', team: 'A', swims: {} }], [E1]), tags: [...fx.tags, ...tags('A', ['H'])] };
    const noneResult = await autoBuild(request(none), nodeMipSolve());
    expect(noneResult.proof.searchSpace.frozenPairs.map((p) => p.swimmerId)).toEqual(['F']);
  });

  it('2b frozenCurrentEntryStays: a pinned swimmer never loses the current entry of a frozen pair, though dropping it would raise the objective', async () => {
    // F is entered now with two swims (a robust value of its normal seed 49.00, 3rd). G is consistent (43.20, 2nd). Cap 1: G could replace F.
    const make = (fSwims: readonly number[]): Fx => {
      const specs: Spec[] = [
        { id: 'F', team: 'A', swims: { [E1]: dated(fSwims) } },
        { id: 'G', team: 'A', swims: { [E1]: dated([4310, 4320, 4330, 4300, 4340]) } },
        { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }] } },
        { id: 'R2', team: 'D', swims: { [E1]: [{ time: 4800, date: null }] } },
      ];
      return { model: buildModel(specs, [E1]), lineup: lineup(ind('A', 'F', E1), ind('B', 'R1', E1), ind('D', 'R2', E1)), tags: [...tags('A', ['F', 'G']), ...tags('B', ['R1']), ...tags('D', ['R2'])], rules: rulesOf({ cap: 1 }) };
    };
    // The control: F has three swims, a spread of 49.00, so his entry is not held. G beats him under the cap of 1, which takes F's entry out of the
    // places. The fewest-changes tie-break then keeps F's entry (dropping it is a second change that buys nothing): G is added, F stays.
    const control = await autoBuild(request(make([4900, 4900, 4900])), nodeMipSolve());
    expect(control.kind).toBe('improved');
    expect(control.kind === 'improved' && entered(control.proposal.lineup)).toEqual(['F', 'G']);
    expect(control.kind === 'improved' && control.proposal.changeCount).toBe(1);
    expect(control.proof.searchSpace.frozenPairs).toEqual([]);
    // Frozen: F has two swims, so his entry stays. G is not frozen, so he may be added beside F: the cap of 1 removes F's entry from the places
    // (F is the slower of the two), G takes 2nd (17) and F's entry is still in the lineup. A column prune that ignored the frozen entry would miss this.
    const frozen = await autoBuild(request(make([4900, 4900])), nodeMipSolve());
    expect(frozen.kind).toBe('improved');
    if (frozen.kind !== 'improved') return;
    expect(entered(frozen.proposal.lineup)).toEqual(['F', 'G']);
    expect(frozen.proposal.evaluation.objective).toBe(17);
    expect(frozen.proposal.entryChanges.some((c) => c.kind === 'removed')).toBe(false);
    expect(frozen.proof.searchSpace.frozenPairs).toEqual([{ swimmerId: 'F', eventKey: E1, gender: 'Men', swims: 2 }]);
    // The frozen entry is valued at its normal seed: the current objective is F's 3rd place (16) and robustOwnPoints says so.
    expect(frozen.current.robustOwnPoints).toBe(16);
    expect(frozen.current.objective).toBe(16);
  });

  describe('2c frozenFreeEntry: a free swimmer keeps the current entry of a frozen pair (D5 5.4), without being forced onto the roster', () => {
    // F is untagged and entered in E1 with two swims (no spread, normal seed 49.00). G is untagged with a consistent E1 history (robust 43.20) and
    // would beat F under the per-team cap of 1. R1 and R2 are rivals on their own teams.
    const make = (fE2: readonly number[]): Fx => {
      const specs: Spec[] = [
        { id: 'F', team: 'A', swims: { [E1]: dated([4900, 4900]), ...(fE2.length > 0 ? { [E2]: dated(fE2) } : {}) } },
        { id: 'G', team: 'A', swims: { [E1]: dated([4310, 4320, 4330, 4300, 4340]) } },
        { id: 'P', team: 'A', swims: {} },
        { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }], [E2]: [{ time: 5000, date: null }] } },
        { id: 'R2', team: 'D', swims: { [E1]: [{ time: 4800, date: null }] } },
      ];
      return {
        model: buildModel(specs, [E1, E2]),
        lineup: lineup(ind('A', 'F', E1), ind('B', 'R1', E1), ind('B', 'R1', E2), ind('D', 'R2', E1)),
        tags: [...tags('A', ['P']), ...tags('B', ['R1']), ...tags('D', ['R2'])],
        rules: rulesOf({ cap: 1 }),
      };
    };
    const hasEntry = (l: Lineup, id: string, event: string): boolean => l.entries.some((e) => e.kind === 'individual' && e.teamId === 'A' && e.swimmerId === id && e.eventKey === event);
    const timesOut: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });

    it('F joins for E2 and G joins for E1: the frozen E1 entry of F stays (MIP and local search)', async () => {
      const fx = make([4400, 4410, 4420]);
      for (const [label, solve] of [['mip', nodeMipSolve()], ['local search', timesOut]] as const) {
        const r = await autoBuild(request(fx), solve);
        expect(r.kind, label).toBe('improved');
        if (r.kind !== 'improved') return;
        expect(r.proposal.rosterAdds.map((a) => a.swimmerId), label).toEqual(['F', 'G']);
        expect(hasEntry(r.proposal.lineup, 'F', E1), `${label}: the frozen entry is not dropped`).toBe(true);
        expect(hasEntry(r.proposal.lineup, 'F', E2), label).toBe(true);
        expect(hasEntry(r.proposal.lineup, 'G', E1), label).toBe(true);
        expect(r.proposal.entryChanges.some((c) => c.kind === 'removed' && c.entryKey === entryKey(ind('A', 'F', E1))), label).toBe(false);
        expect(r.proof.searchSpace.frozenPairs, label).toEqual([{ swimmerId: 'F', eventKey: E1, gender: 'Men', swims: 2 }]);
        expect(r.proof.searchSpace.restrictions, label).not.toContain('held_split_entries');
        // The gate re-scored the built lineup: the pinned own points are an independent scoreMeet total.
        const pins = new Map<string, string>(['G', 'F'].flatMap((id) => [E1, E2].flatMap((e) => {
          const swim = oracleSwim(fx.model.swims.filter((s) => s.swimmerId === id && s.eventKey === e), RANGE, false, 5, 3);
          return swim === null ? [] : [[`${id}\u0000${e}`, swim] as const];
        })));
        const pinned = pinLineup(r.proposal.lineup, 'A', pins, () => true);
        expect(r.proposal.evaluation.robustOwnPoints, label).toBe(ownTotal(scoreMeet(fx.model, pinned, r.proposal.tagsForScoring, fx.rules, SOURCING)));
      }
    });

    it('a current entry with no time at all is not frozen: it is not listed and it may go when the swimmer joins', async () => {
      // F has swims in E2 only. His E1 entry is a no-time entry (no usable seed), so the pair is neither frozen nor listed.
      const fx = make([]);
      const model = buildModel(
        [
          { id: 'F', team: 'A', swims: { [E2]: dated([4400, 4410, 4420]) } },
          { id: 'P', team: 'A', swims: {} },
          { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }], [E2]: [{ time: 5000, date: null }] } },
          { id: 'R2', team: 'D', swims: { [E1]: [{ time: 4800, date: null }] } },
        ],
        [E1, E2]
      );
      const r = await autoBuild(request({ ...fx, model }), nodeMipSolve());
      expect(r.kind).toBe('improved');
      if (r.kind !== 'improved') return;
      expect(r.proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['F']);
      expect(r.proof.searchSpace.frozenPairs).toEqual([]);
      expect(hasEntry(r.proposal.lineup, 'F', E1)).toBe(false);
      expect(hasEntry(r.proposal.lineup, 'F', E2)).toBe(true);
    });

    it('a free swimmer with a spread is not held: the solver may drop his current entry when he joins for another event', async () => {
      // F's E1 pair has three swims (a spread), so it is not frozen. One individual entry only: F joins for E2 (20 points) and drops E1 (16).
      const specs: Spec[] = [
        { id: 'F', team: 'A', swims: { [E1]: dated([5200, 5300, 5250]), [E2]: dated([4400, 4410, 4420]) } },
        { id: 'P', team: 'A', swims: {} },
        { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }], [E2]: [{ time: 5000, date: null }] } },
        { id: 'R2', team: 'D', swims: { [E1]: [{ time: 4800, date: null }] } },
      ];
      const fx: Fx = {
        model: buildModel(specs, [E1, E2]),
        lineup: lineup(ind('A', 'F', E1), ind('B', 'R1', E1), ind('B', 'R1', E2), ind('D', 'R2', E1)),
        tags: [...tags('A', ['P']), ...tags('B', ['R1']), ...tags('D', ['R2'])],
        rules: rulesOf({ maxInd: 1 }),
      };
      const r = await autoBuild(request(fx), nodeMipSolve());
      expect(r.kind).toBe('improved');
      if (r.kind !== 'improved') return;
      expect(r.proof.searchSpace.frozenPairs).toEqual([]);
      expect(r.proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['F']);
      expect(hasEntry(r.proposal.lineup, 'F', E1)).toBe(false);
      expect(hasEntry(r.proposal.lineup, 'F', E2)).toBe(true);
    });

    it('F has nothing else to swim: his entry stays and the roster is not forced', async () => {
      const fx = make([]);
      for (const [label, solve] of [['mip', nodeMipSolve()], ['local search', timesOut]] as const) {
        const r = await autoBuild(request(fx), solve);
        expect(r.kind, label).toBe('improved');
        if (r.kind !== 'improved') return;
        expect(hasEntry(r.proposal.lineup, 'F', E1), `${label}: the frozen entry is not dropped`).toBe(true);
        expect(hasEntry(r.proposal.lineup, 'G', E1), label).toBe(true);
        // The MIP breaks the tie by fewest changes. The local search takes the first strictly better column, which may list F as well.
        if (label === 'mip') expect(r.proposal.rosterAdds.map((a) => a.swimmerId), 'F is not forced onto the roster').toEqual(['G']);
        else expect(r.proposal.rosterAdds.map((a) => a.swimmerId)).toContain('G');
      }
    });
  });

  it('3 simulatorOnlyNoSpread: a model built from the simulator (no dated swims) is refused with robust_no_spread', async () => {
    const { snapshot } = buildSnapshot('C');
    const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: 'robust-config-C', snapshotId: 'test' });
    if (adapted.kind !== 'ready') throw new Error(`config C did not adapt: ${adapted.kind}`);
    const { model, lineup: current } = adapted.adapted;
    expect(model.swims.every((s) => s.date === null), 'simulator swims carry no date').toBe(true);
    const own = String(model.teams.find((t) => String(t.teamId) === '58')?.teamId ?? (model.teams[0] as { teamId: string }).teamId);
    const mine = model.swimmers.filter((s) => s.teamId === own && s.gender === 'Men').map((s) => s.swimmerId).sort().slice(0, 3);
    const opponents = new Map<string, Set<string>>();
    for (const e of current.entries) {
      if (e.teamId === own) continue;
      const ids = opponents.get(e.teamId) ?? new Set<string>();
      for (const id of e.kind === 'individual' ? [e.swimmerId] : e.legs.map((l) => l.swimmerId)) ids.add(id);
      opponents.set(e.teamId, ids);
    }
    const sides = [...tags(own, mine), ...[...opponents].flatMap(([teamId, ids]) => tags(teamId, [...ids].sort()))];
    const rules = requireComplete(builtinRulePreset('nsisc', 5) as RulePreset);
    const error = await autoError(() => autoBuild({ model, lineup: current, rules, sourcing: SOURCING, tags: sides, ownTeamId: own as never, genders: ['Men'], objective: ROBUST, load: null, limits: LIMITS }, nodeMipSolve()));
    expect(error).toMatchObject({ code: 'robust_no_spread', subject: 'robust' });
  });

  it('3b noSpreadAnywhere: dated swims below minSwims in every pair refuse, and one pair with a spread is enough to search', async () => {
    const specs: Spec[] = [
      { id: 'P', team: 'A', swims: { [E1]: dated([4400, 4500]) } },
      { id: 'R', team: 'B', swims: { [E1]: [{ time: 4300, date: null }] } },
    ];
    const fx: Fx = { model: buildModel(specs, [E1]), lineup: lineup(ind('B', 'R', E1)), tags: [...tags('A', ['P']), ...tags('B', ['R'])], rules: rulesOf() };
    expect(await autoError(() => autoBuild(request(fx), nodeMipSolve()))).toMatchObject({ code: 'robust_no_spread' });
    // The same swims outside the record range count for nothing.
    const late = buildModel([{ id: 'P', team: 'A', swims: { [E1]: dated([4400, 4500, 4600]) } }, specs[1] as Spec], [E1], { kind: 'dates', from: '2027-01-01', to: '2027-12-31' });
    expect(await autoError(() => autoBuild(request({ ...fx, model: late }), nodeMipSolve()))).toMatchObject({ code: 'robust_no_spread' });
    // minSwims 2 gives P a spread.
    const two = await autoBuild(request(fx, { objective: { kind: 'robust', recentSwims: 5, minSwims: 2 } }), nodeMipSolve());
    expect(two.kind).toBe('improved');
  });

  it('4 consistentBeatsVolatile: a consistent swimmer is entered over a faster, volatile one, unlike max-own', async () => {
    const fx = volatile('none');
    const own = await autoBuild(request(fx, { objective: { kind: 'max-own' } }), nodeMipSolve());
    expect(own.kind === 'improved' && entered(own.proposal.lineup)).toEqual(['V']);
    const robust = await autoBuild(request(fx), nodeMipSolve());
    expect(robust.kind).toBe('improved');
    if (robust.kind !== 'improved') return;
    expect(entered(robust.proposal.lineup)).toEqual(['C']);
    expect(robust.proof.status).toBe('proven_optimal');
    // The robust objective is C's robust points: 3rd (16). His normal points are 2nd (17), and the two numbers are different on purpose.
    expect(robust.proposal.evaluation).toMatchObject({ objective: 16, robustOwnPoints: 16, ownPoints: 17 });
    expect(robust.current.robustOwnPoints).toBe(0);
    // `scoreMeet` on the lineup as built gives the normal points, with no pin in it.
    const plain = scoreMeet(fx.model, robust.proposal.lineup, robust.proposal.tagsForScoring, fx.rules, SOURCING);
    expect(ownTotal(plain)).toBe(17);
    expect(robust.proposal.lineup.entries.filter((e) => e.kind === 'individual' && e.teamId === 'A').map((e) => (e as { seedSwimId: string | null }).seedSwimId)).toEqual([null]);
    // `scoreMeet` on the robust seeds, pinned here from the rule written in this file, gives the robust points.
    const swimsOfC = fx.model.swims.filter((s) => s.swimmerId === 'C');
    const pin = oracleSwim(swimsOfC, RANGE, false, 5, 3) as string;
    expect(swimsOfC.find((s) => s.swimId === pin)?.recordedTime?.hundredths).toBe(4320);
    const pinned = lineup(...robust.proposal.lineup.entries.map((e) => (e.kind === 'individual' && e.swimmerId === 'C' ? { ...e, seedSwimId: pin } : e)));
    expect(ownTotal(scoreMeet(fx.model, pinned, robust.proposal.tagsForScoring, fx.rules, SOURCING))).toBe(16);
  });

  it('4b candidatesRankedByRobustTime: with one candidate per event, the robust time picks the candidate', async () => {
    const limits = { ...LIMITS, candidatesPerEvent: 1, maxCandidatesPerEvent: 1, refineRounds: 0 };
    const robust = await autoBuild(request(volatile('none'), { limits }), nodeMipSolve());
    expect(robust.kind === 'improved' && entered(robust.proposal.lineup)).toEqual(['C']);
    // The bound does not model the per-event cap, so it stays a gap here: it still covers the optimum (16).
    expect(robust.proof.bestFound).toBe(16);
    expect(robust.proof.upperBound as number).toBeGreaterThanOrEqual(16);
  });

  it('5 guardComparesRobustObjectives: the guard measures robust points, so a lineup with fewer normal points can be the improvement', async () => {
    // V is entered: 20 normal points, 15 robust. C is robust 16: robust mode improves while the normal points fall from 20 to 17.
    const withV = await autoBuild(request(volatile('V')), nodeMipSolve());
    expect(withV.kind).toBe('improved');
    if (withV.kind !== 'improved') return;
    expect(withV.current).toMatchObject({ objective: 15, robustOwnPoints: 15, ownPoints: 20 });
    // C is added and V's entry stays (one change): by the robust seeds C is ahead of V and V is over the cap, so the objective is 16. By the normal seeds
    // V is ahead and keeps his 20 points, so the lineup as built scores 20 and the two numbers differ on purpose.
    expect(withV.proposal.evaluation).toMatchObject({ objective: 16, robustOwnPoints: 16, ownPoints: 20 });
    expect(withV.proposal.changeCount).toBe(1);
    expect(withV.proposal.evaluation.objective).toBeGreaterThan(withV.current.objective);
    const own = await autoBuild(request(volatile('V'), { objective: { kind: 'max-own' } }), nodeMipSolve());
    expect(own).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    // C is entered: robust mode finds nothing better and proves it, though V would add 3 normal points.
    const withC = await autoBuild(request(volatile('C')), nodeMipSolve());
    expect(withC).toMatchObject({ kind: 'unchanged', reason: 'proven_no_better' });
    expect(withC.current).toMatchObject({ objective: 16, robustOwnPoints: 16, ownPoints: 17 });
    const ownC = await autoBuild(request(volatile('C'), { objective: { kind: 'max-own' } }), nodeMipSolve());
    expect(ownC.kind).toBe('improved');
  });

  it('6 settingsAreValidated: the recent and minimum swims are integers with 1 <= minSwims <= recentSwims <= 20', async () => {
    const fx = volatile('none');
    const bad = (recentSwims: number, minSwims: number): Promise<AutoBuildError> => autoError(() => autoBuild(request(fx, { objective: { kind: 'robust', recentSwims, minSwims } }), nodeMipSolve()));
    expect(await bad(0, 1)).toMatchObject({ code: 'limits_invalid', subject: 'objective.recentSwims' });
    expect(await bad(21, 3)).toMatchObject({ code: 'limits_invalid', subject: 'objective.recentSwims' });
    expect(await bad(5.5, 3)).toMatchObject({ code: 'limits_invalid', subject: 'objective.recentSwims' });
    expect(await bad(5, 0)).toMatchObject({ code: 'limits_invalid', subject: 'objective.minSwims' });
    expect(await bad(5, 6)).toMatchObject({ code: 'limits_invalid', subject: 'objective.minSwims' });
    expect(await bad(5, 2.5)).toMatchObject({ code: 'limits_invalid', subject: 'objective.minSwims' });
    // The bounds themselves are fine.
    const edge = await autoBuild(request(fx, { objective: { kind: 'robust', recentSwims: 20, minSwims: 20 } }), nodeMipSolve()).catch((e: unknown) => e);
    expect(edge).toMatchObject({ code: 'robust_no_spread' }); // 20 swims are needed and nobody has them: valid settings, no spread
    const one = await autoBuild(request(fx, { objective: { kind: 'robust', recentSwims: 1, minSwims: 1 } }), nodeMipSolve());
    expect(one.kind).toBe('improved'); // the newest swim only: V 49.00 and C 43.10
  });

  it('7 evaluatorParity: the fast scorer gives the rows of scoreMeet for pinned columns, with no fallback', () => {
    const fx = volatile('V');
    const own = fx.model.swimmers.filter((s) => s.teamId === 'A').map((s) => s.swimmerId);
    const pins = new Map<string, string>();
    for (const id of own) pins.set(`${id}\u0000${E1}`, oracleSwim(fx.model.swims.filter((s) => s.swimmerId === id && s.eventKey === E1), RANGE, false, 5, 3) as string);
    const base = { model: fx.model, lineup: fx.lineup, tags: fx.tags, rules: fx.rules, sourcing: SOURCING, own: 'A', decision: new Set(own), free: new Set<string>(), load: null, held: new Set<string>(), pins };
    const fast = new Evaluator({ ...base, fast: true, selfChecks: 0 });
    const reference = new Evaluator({ ...base, fast: false });
    const event = fx.model.events[0] as MeetEvent;
    for (const members of [[], ['V'], ['C'], ['C', 'V']]) {
      const a = fast.evaluate(event, members);
      const b = reference.evaluate(event, members);
      expect(sameRows(a.rows, b.rows), members.join()).toBe(true);
      expect(a.own).toBeCloseTo(b.own, 9);
    }
    expect(fast.referenceCalls, 'the fast scorer served every column').toBe(0);
    expect(fast.fallbacks.size).toBe(0);
    // The pinned values are the robust ones: C alone is 3rd (16), V alone 4th (15).
    expect(fast.evaluate(event, ['C']).own).toBe(16);
    expect(fast.evaluate(event, ['V']).own).toBe(15);
    // No pins: the normal seeds (C 17, V 20).
    const plain = new Evaluator({ ...base, pins: new Map<string, string>(), fast: true, selfChecks: 0 });
    expect(plain.evaluate(event, ['C']).own).toBe(17);
    expect(plain.evaluate(event, ['V']).own).toBe(20);
  });

  it('7b pinLineupPinsOnlyOwnedPairs: only an owned own swimmer with a pin is pinned, and nothing else changes', () => {
    const pins = new Map<string, string>([[`V\u0000${E1}`, 'pin-V'], [`C\u0000${E1}`, 'pin-C'], [`R1\u0000${E1}`, 'pin-R1']]);
    const source = lineup(ind('A', 'V', E1), ind('A', 'C', E1), ind('B', 'R1', E1), ind('A', 'Z', E1));
    const pinned = pinLineup(source, 'A', pins, (id) => id !== 'C');
    expect(pinned.entries.map((e) => (e as { seedSwimId: string | null }).seedSwimId)).toEqual(['pin-V', null, null, null]);
    expect(source.entries.every((e) => (e as { seedSwimId: string | null }).seedSwimId === null), 'the source is not changed').toBe(true);
  });

  it('8 robustBruteForce: seeded worlds with dated, undated, converted, user-typed and out-of-range swims equal the best entry set scored by scoreMeet on the robust seeds', async () => {
    const stats = { worlds: 0, noSpread: 0, frozenPairs: 0, frozenCurrent: 0, pinnedDiffers: 0 };
    for (let seed = 0; seed < 16; seed++) {
      const w = robustWorld(seed);
      const result = await autoBuild(request(w.fx), nodeMipSolve()).catch((e: unknown) => e);
      if (result instanceof AutoBuildError) {
        expect(result.code, `seed ${seed}`).toBe('robust_no_spread');
        stats.noSpread += 1;
        continue;
      }
      const r = result as AutoBuildResult;
      stats.worlds += 1;
      const best = bruteRobust(w);
      const label = `seed ${seed}`;
      expect(r.kind === 'improved' || r.kind === 'unchanged', label).toBe(true);
      const objective = r.kind === 'improved' ? r.proposal.evaluation.objective : r.current.objective;
      expect(objective, label).toBeCloseTo(best.value, 9);
      expect(r.current.objective, label).toBeCloseTo(best.current, 9);
      expect(r.proof.status, label).toBe('proven_optimal');
      stats.frozenPairs += r.proof.searchSpace.frozenPairs.length;
      stats.frozenCurrent += best.frozenCurrent;
      if (r.kind === 'improved') {
        // The lineup as built carries no pin, and `ownPoints` is the plain `scoreMeet` total.
        const plain = scoreMeet(w.fx.model, r.proposal.lineup, r.proposal.tagsForScoring, w.fx.rules, SOURCING);
        expect(ownTotal(plain), label).toBe(r.proposal.evaluation.ownPoints);
        const added = r.proposal.entryChanges.filter((c) => c.kind === 'added').map((c) => c.entryKey);
        expect(r.proposal.lineup.entries.filter((e) => added.includes(entryKey(e))).every((e) => (e as { seedSwimId: string | null }).seedSwimId === null), label).toBe(true);
        // A frozen pair is never added, and a frozen current entry is never removed.
        const frozen = new Set(r.proof.searchSpace.frozenPairs.map((f) => entryKey(ind('A', f.swimmerId, f.eventKey, f.gender))));
        for (const c of r.proposal.entryChanges) if (c.kind === 'added') expect(frozen.has(c.entryKey), `${label} added ${c.entryKey}`).toBe(false);
        for (const id of best.frozenKept) expect(entered(r.proposal.lineup), label).toContain(id);
        if (r.proposal.evaluation.robustOwnPoints !== r.proposal.evaluation.ownPoints) stats.pinnedDiffers += 1;
      }
    }
    expect(stats.worlds).toBeGreaterThanOrEqual(10);
    expect(stats.frozenPairs, 'some world must freeze a pair').toBeGreaterThan(0);
    expect(stats.frozenCurrent, 'some world must hold a frozen current entry').toBeGreaterThan(0);
    expect(stats.pinnedDiffers, 'some proposal must score differently on robust seeds').toBeGreaterThan(0);
  }, 300_000);

  it('9 racesUseNormalSeeds: a split heat is seeded by the entered times, so the races of a pinned column come from the lineup as entered', async () => {
    // SP is a split timed final (fast heat of 2 in the evening, the rest in the morning). X's normal seed 40.00 is the fastest: he swims the
    // evening fast heat. His robust swim 46.00 would put him in the morning heats. E2 is an evening final. With one race per session, X cannot
    // enter both events: SP and E2 are both evening races for him as entered. A column scored on the robust seeds would see a morning race and
    // allow both, and the gate (which reads the lineup as built) would refuse it.
    const SP = '200 Freestyle';
    const specs: Spec[] = [
      { id: 'X', team: 'A', swims: { [SP]: [...dated([4600, 4600, 4600, 4600, 4600]), { time: 4000, date: '2025-10-01' }], [E2]: dated([4400, 4400, 4400]) } },
      { id: 'b1', team: 'B', swims: { [SP]: [{ time: 4200, date: null }] } },
      { id: 'b2', team: 'B', swims: { [SP]: [{ time: 4300, date: null }] } },
      { id: 'r1', team: 'B', swims: { [E2]: [{ time: 5000, date: null }] } },
    ];
    const schedule: ScheduledEvent[] = [
      { eventKey: SP, gender: 'both', format: { kind: 'timed-final-split', slowHeats: { day: 1, slot: 'morning' }, fastHeat: { day: 1, slot: 'evening' }, fastHeatSize: set(2), smallFieldSession: set({ day: 1, slot: 'evening' as const }) } },
      { eventKey: E2, gender: 'both', format: { kind: 'timed-final', session: { day: 1, slot: 'evening' } } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [SP, E2]),
      lineup: lineup(ind('B', 'b1', SP), ind('B', 'b2', SP), ind('B', 'r1', E2)),
      tags: [...tags('A', ['X']), ...tags('B', ['b1', 'b2', 'r1'])],
      rules: rulesOf(),
    };
    const load: AutoBuildRequest['load'] = {
      schedule: { payloadVersion: 1, provenance: TEST_PROVENANCE, events: schedule },
      preference: { mode: 'respect', maxRacesPerSession: set(1), diving: set('excluded' as const) },
    };
    const r = await autoBuild(request(fx, { load }), nodeMipSolve());
    expect(r.kind).toBe('improved');
    if (r.kind !== 'improved') return;
    // X enters one event: E2 (20 points, 1st alone) beats SP (robust: 3rd, 16 points).
    expect(entered(r.proposal.lineup)).toEqual(['X']);
    expect(r.proposal.lineup.entries.filter((e) => e.teamId === 'A').map((e) => e.eventKey)).toEqual([E2]);
    expect(r.proposal.evaluation.objective).toBe(20);
    // Without the load rows X enters both: 20 + 16.
    const free = await autoBuild(request(fx), nodeMipSolve());
    expect(free.kind === 'improved' && free.proposal.evaluation.objective).toBe(36);
  });

  it('9b relaysAreNotSlowed: a relay event beside individual events keeps its normal legs, and the gate still agrees with the columns', async () => {
    // Six own swimmers with dated 100 free swims (the first swim of each is the relay leadoff) and flying splits. Team B holds the only relay now.
    const specs: Spec[] = [];
    for (let i = 1; i <= 6; i++) {
      const base = 4500 + i * 30;
      specs.push({ id: `o${i}`, team: 'A', swims: { [E1]: [{ time: base, date: '2026-03-28', id: `o${i}:${E1}` }, ...dated([base + 200, base + 300, base + 250, base + 400], 27)] } });
    }
    for (let i = 1; i <= 4; i++) specs.push({ id: `b${i}`, team: 'B', swims: { [E1]: [{ time: 4700 + i * 40, date: null, id: `b${i}:${E1}` }] } });
    const fx: Fx = {
      model: buildModel(specs, [E1, RELAY]),
      lineup: lineup(relay('B', 'A', ['b1', 'b2', 'b3', 'b4']), ...[1, 2, 3, 4].map((i) => ind('B', `b${i}`, E1))),
      tags: [...tags('A', specs.filter((s) => s.team === 'A').map((s) => s.id)), ...tags('B', ['b1', 'b2', 'b3', 'b4'])],
      rules: rulesOf(),
    };
    const robust = await autoBuild(request(fx), nodeMipSolve());
    expect(robust.kind).toBe('improved');
    if (robust.kind !== 'improved') return;
    // A relay leg keeps its normal basis: the flat-start leadoff and the flying splits are never replaced by a robust swim. (The squads may differ
    // between the modes: the individual values change what a swimmer's entries leave for the relay.)
    const squads = (r: typeof robust): string[] => r.proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A').map((e) => JSON.stringify((e as { legs: unknown }).legs));
    expect(squads(robust).length).toBeGreaterThan(0);
    expect(squads(robust).every((s) => s.includes('flat-start-swim') && s.includes('split-'))).toBe(true);
    expect(robust.proposal.lineup.entries.every((e) => e.kind !== 'relay' || e.teamId !== 'A' || JSON.stringify(e.legs).includes('seedSwimId') === false)).toBe(true);
    // The robust objective is the pinned lineup's own points, scored independently here.
    const pins = new Map(fx.model.swimmers.filter((s) => s.teamId === 'A').map((s) => [`${s.swimmerId}\u0000${E1}`, oracleSwim(fx.model.swims.filter((w) => w.swimmerId === s.swimmerId && w.eventKey === E1), RANGE, false, 5, 3) as string] as const));
    const pinned = pinLineup(robust.proposal.lineup, 'A', pins, () => true);
    expect(ownTotal(scoreMeet(fx.model, pinned, robust.proposal.tagsForScoring, fx.rules, SOURCING))).toBe(robust.proposal.evaluation.robustOwnPoints);
    expect(robust.proposal.evaluation.robustOwnPoints).toBeLessThan(robust.proposal.evaluation.ownPoints);
  });

  it('9c joinerIsPinned: an untagged member who joins the roster is valued and scored on his robust swim, so the gate agrees with the columns', async () => {
    // J is untagged (free). His best is 42.00 and his robust swim 44.00. Behind R1 (41.00) and R2 (43.50) he is 3rd on robust seeds (16 points), 2nd on
    // normal seeds (17). P is tagged and swims E2 only. Joining is the optimum.
    const specs: Spec[] = [
      { id: 'J', team: 'A', swims: { [E1]: dated([4500, 4200, 4300, 4400, 4600]) } },
      { id: 'P', team: 'A', swims: { [E2]: dated([4400, 4450, 4500]) } },
      { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }], [E2]: [{ time: 5000, date: null }] } },
      { id: 'R2', team: 'D', swims: { [E1]: [{ time: 4350, date: null }] } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, E2]),
      lineup: lineup(ind('B', 'R1', E1), ind('B', 'R1', E2), ind('D', 'R2', E1)),
      tags: [...tags('A', ['P']), ...tags('B', ['R1']), ...tags('D', ['R2'])],
      rules: rulesOf({ maxInd: 2 }),
    };
    const r = await autoBuild(request(fx), nodeMipSolve());
    expect(r.kind).toBe('improved');
    if (r.kind !== 'improved') return;
    expect(r.proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['J']);
    expect(entered(r.proposal.lineup)).toEqual(['J', 'P']);
    const pins = new Map(['J', 'P'].flatMap((id) => [E1, E2].map((e) => [`${id}\u0000${e}`, oracleSwim(fx.model.swims.filter((s) => s.swimmerId === id && s.eventKey === e), RANGE, false, 5, 3)] as const)).flatMap(([k, v]) => (v === null ? [] : [[k, v] as const])));
    const pinned = pinLineup(r.proposal.lineup, 'A', pins, () => true);
    const independent = ownTotal(scoreMeet(fx.model, pinned, r.proposal.tagsForScoring, fx.rules, SOURCING));
    expect(r.proposal.evaluation.robustOwnPoints).toBe(independent);
    expect(r.proposal.evaluation.objective).toBe(independent);
    // J scores 16 on his robust swim and 17 on his best: the two totals differ by one.
    expect(r.proposal.evaluation.ownPoints - independent).toBe(1);
  });

  it('10b frozenEntryUnderFallback: with no MIP result the local search keeps a frozen current entry and improves another event', async () => {
    // E1 is the 2b fixture with F frozen (two swims) and G a better robust choice that cap 1 would allow only by dropping F. H can enter E2.
    const specs: Spec[] = [
      { id: 'F', team: 'A', swims: { [E1]: dated([4900, 4900]) } },
      { id: 'G', team: 'A', swims: { [E1]: dated([4310, 4320, 4330, 4300, 4340]) } },
      { id: 'H', team: 'A', swims: { [E2]: dated([4400, 4410, 4420]) } },
      { id: 'R1', team: 'B', swims: { [E1]: [{ time: 4100, date: null }], [E2]: [{ time: 5000, date: null }] } },
      { id: 'R2', team: 'D', swims: { [E1]: [{ time: 4800, date: null }] } },
    ];
    const fx: Fx = {
      model: buildModel(specs, [E1, E2]),
      lineup: lineup(ind('A', 'F', E1), ind('B', 'R1', E1), ind('B', 'R1', E2), ind('D', 'R2', E1)),
      tags: [...tags('A', ['F', 'G', 'H']), ...tags('B', ['R1']), ...tags('D', ['R2'])],
      rules: rulesOf({ cap: 1 }),
    };
    const timesOut: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });
    const r = await autoBuild(request(fx), timesOut);
    expect(r.kind).toBe('improved');
    if (r.kind !== 'improved') return;
    expect(r.proposal.method).toBe('local-search');
    expect(entered(r.proposal.lineup)).toEqual(['F', 'G', 'H']);
    expect(r.proposal.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === 'F' && e.eventKey === E1)).toBe(true);
    expect(r.proposal.evaluation.objective).toBeGreaterThan(r.current.objective);
    // The same request with the MIP solver agrees on the entries.
    const exact = await autoBuild(request(fx), nodeMipSolve());
    expect(exact.kind === 'improved' && entered(exact.proposal.lineup)).toEqual(['F', 'G', 'H']);
    expect(exact.kind === 'improved' && exact.proposal.evaluation.objective).toBe(r.proposal.evaluation.objective);
  });

  it('10 timeLimitFallback: with no MIP result the local search runs on the robust columns and its lineup passes the gate', async () => {
    const timesOut: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });
    const r = await autoBuild(request(volatile('V')), timesOut);
    expect(r.kind).toBe('improved');
    if (r.kind !== 'improved') return;
    expect(r.proposal.method).toBe('local-search');
    expect(entered(r.proposal.lineup)).toEqual(['C']);
    expect(r.proposal.evaluation).toMatchObject({ objective: 16, robustOwnPoints: 16 });
  });
});

// ---- the seeded worlds -------------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  readonly fx: Fx;
  readonly own: readonly string[];
}

/**
 * SYNTHETIC. Four own swimmers (pinned) in two events with at most one individual entry each. Each pair has 0 to 6 swims: dated in the range,
 * undated, converted, typed in, or out of the range. Team B has four swimmers in each event. The current lineup enters some own swimmers.
 */
function robustWorld(seed: number): World {
  const next = rng(seed * 4099 + 11);
  const events = [E1, E2];
  const specs: Spec[] = [];
  const own = ['p1', 'p2', 'p3', 'p4'];
  for (const id of own) {
    const swims: Record<string, SwimSpec[]> = {};
    for (const e of events) {
      const n = Math.floor(next() * 7);
      const list: SwimSpec[] = [];
      for (let i = 0; i < n; i++) {
        const time = 4300 + Math.floor(next() * 12) * 40;
        const roll = next();
        const day = 1 + Math.floor(next() * 28);
        if (roll < 0.1) list.push({ time, date: null });
        else if (roll < 0.2) list.push({ time, date: `2026-02-${String(day).padStart(2, '0')}`, converted: true });
        else if (roll < 0.3) list.push({ time, date: `2025-06-${String(day).padStart(2, '0')}` });
        else if (roll < 0.38) list.push({ time, date: `2026-02-${String(day).padStart(2, '0')}`, userInputted: true });
        else list.push({ time, date: `2026-0${1 + Math.floor(next() * 5)}-${String(day).padStart(2, '0')}` });
      }
      if (list.length > 0) swims[e] = list;
    }
    specs.push({ id, team: 'A', swims });
  }
  for (let i = 1; i <= 4; i++) {
    const swims: Record<string, SwimSpec[]> = {};
    for (const e of events) swims[e] = [{ time: 4300 + Math.floor(next() * 12) * 40, date: null }];
    specs.push({ id: `b${i}`, team: 'B', swims });
  }
  const model = buildModel(specs, events);
  const rivals = specs.filter((s) => s.team === 'B');
  const mine: LineupEntry[] = [];
  for (const id of own) {
    const spec = specs.find((s) => s.id === id) as Spec;
    const choices = events.filter((e) => (spec.swims[e] ?? []).length > 0);
    if (choices.length > 0 && next() < 0.55) mine.push(ind('A', id, choices[Math.floor(next() * choices.length)] as string));
  }
  const fx: Fx = {
    model,
    lineup: lineup(...mine, ...rivals.flatMap((s) => events.map((e) => ind('B', s.id, e)))),
    tags: [...tags('A', own), ...tags('B', rivals.map((s) => s.id))],
    rules: rulesOf({ maxInd: 1 }),
  };
  return { fx, own };
}

interface Brute {
  readonly value: number;
  readonly current: number;
  /** Frozen current entries of pinned swimmers: their swimmers must stay entered. */
  readonly frozenKept: readonly string[];
  readonly frozenCurrent: number;
}

/** Every choice of one event (or none) for each own swimmer, scored by `scoreMeet` with the robust swims pinned. */
function bruteRobust(w: World): Brute {
  const { fx } = w;
  const events = [E1, E2];
  const swimsOf1 = (id: string, e: string): MeetSwim[] => fx.model.swims.filter((s) => s.swimmerId === id && s.eventKey === e);
  const pin = (id: string, e: string): string | null => oracleSwim(swimsOf1(id, e), RANGE, false, 5, 3);
  const usable = (id: string, e: string): boolean =>
    swimsOf1(id, e).some((s) => s.flags.userInputted !== true && s.flags.extractedSplit !== true && s.recordedTime !== null && (s.scy.kind === 'recorded-scy' || s.scy.kind === 'converted'));
  const currentOf = (id: string): string | null => {
    const e = fx.lineup.entries.find((x) => x.kind === 'individual' && x.teamId === 'A' && x.swimmerId === id);
    return e === undefined ? null : e.eventKey;
  };
  const rivals = fx.lineup.entries.filter((e) => e.teamId !== 'A');
  const score = (choice: ReadonlyMap<string, string | null>, pinned: boolean): number => {
    const own: LineupEntry[] = [];
    for (const [id, e] of choice) {
      if (e === null) continue;
      const p = pinned ? pin(id, e) : null;
      own.push({ ...(ind('A', id, e) as Extract<LineupEntry, { kind: 'individual' }>), seedSwimId: p });
    }
    return ownTotal(scoreMeet(fx.model, lineup(...own, ...rivals), fx.tags, fx.rules, SOURCING));
  };
  // The current lineup under the same pins (the pins of a frozen pair are null: the entry keeps its normal seed).
  const currentChoice = new Map(w.own.map((id) => [id, currentOf(id)] as const));
  const frozenKept: string[] = [];
  const options = w.own.map((id) => {
    const cur = currentOf(id);
    if (cur !== null && pin(id, cur) === null && usable(id, cur)) {
      frozenKept.push(id);
      return [cur] as (string | null)[];
    }
    return [null, ...events.filter((e) => pin(id, e) !== null)] as (string | null)[];
  });
  let value = -Infinity;
  const walk = (i: number, chosen: ReadonlyMap<string, string | null>): void => {
    if (i === w.own.length) {
      value = Math.max(value, score(chosen, true));
      return;
    }
    for (const o of options[i] as (string | null)[]) walk(i + 1, new Map([...chosen, [w.own[i] as string, o]]));
  };
  walk(0, new Map());
  return { value, current: score(currentChoice, true), frozenKept, frozenCurrent: frozenKept.length };
}
