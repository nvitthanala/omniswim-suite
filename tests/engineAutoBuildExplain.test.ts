/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `autoBuild`, slice A8: explanations (plans/2026-10-25/D5-AUTOBUILDER.md, 9 and 12.8). Every fixture is synthetic and every rule is the
 * shipped `nsisc` v4 with the settings a test names changed. No time or point value here is a competition value.
 *
 * The oracle (`expected`) writes the whole explanation list a second time from `scoreMeet`, `sessionLoad` and the model swims only. It never
 * calls `explain.ts`. Each test compares `proposal.explanations` to it with `toEqual`, so every fact is re-derived: place, points, seed,
 * estimated, otherTeamsAhead, nextOtherTeamBehind, marginalPoints, each skipped event (placeAlone, marginalPoints, binding), and each
 * roster add (spotsAfter, marginalPoints). Facts that a fixture pins by hand are asserted by value as well, so a shared misreading of the spec
 * between the code and the oracle cannot hide.
 */
import { describe, expect, it, vi } from 'vitest';
import { autoBuild, builtinRulePreset, entryKey, requireComplete, scoreMeet, sessionLoad } from '@omniswim/engine';
import type {
  AutoBuildExplanation,
  AutoBuildLimits,
  AutoBuildProposal,
  AutoBuildRequest,
  AutoBuildResult,
  CompleteRulePreset,
  ConversionSettings,
  Lineup,
  LineupEntry,
  LoadPreference,
  MeetEvent,
  MeetModel,
  MeetSwim,
  MipSolve,
  RelaySplit,
  Results,
  RulePreset,
  ScheduledEvent,
  ScorerTag,
  SessionPreset,
} from '@omniswim/engine';
import { explain, rankOrder, rosterSpots, seedIsEstimated } from '../packages/engine/src/autobuilder/explain';
import { buildProblem } from '../packages/engine/src/autobuilder/space';
import { checkRules, loadRuleOf } from '../packages/engine/src/autobuilder/support';
import { nodeMipSolve } from './helpers/nodeMipSolve';
import { set, TEST_PROVENANCE } from './engineTestPresets';

// `explain` is switched off for one test, to prove that the explanations change nothing else in the result.
const switchedOff = vi.hoisted(() => ({ off: false }));
vi.mock('../packages/engine/src/autobuilder/explain', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/engine/src/autobuilder/explain')>();
  return { ...real, explain: (...args: Parameters<typeof real.explain>) => (switchedOff.off ? [] : real.explain(...args)) };
});

const SOURCING: ConversionSettings = { includeConvertedSwims: false, lcmToScy: null };
const ORIGIN = { kind: 'simulator', snapshotId: 'synthetic' } as const;
const E1 = '100 Freestyle';
const E2 = '100 Backstroke';
const E3 = '100 Butterfly';
const E4 = '100 Breaststroke';
const E5 = '100 Individual Medley';
const DIVE3 = '3-Meter Diving';
const DIVE = '1-Meter Diving';
const RELAY = '400 Freestyle Relay';
const LIMITS: AutoBuildLimits = { candidatesPerEvent: 8, maxCandidatesPerEvent: 12, relaySquadsPerEvent: 12, maxRelaySquadsPerEvent: 24, refineRounds: 2, timeLimitSeconds: 60 };
type Gender = 'Men' | 'Women';
type Unusual = Extract<AutoBuildExplanation, { kind: 'unusual_event' }>;
type RosterAdd = Extract<AutoBuildExplanation, { kind: 'roster_add' }>;

// ---- builders ----------------------------------------------------------------------------------

interface SwimSpec {
  readonly time: number;
  readonly id?: string;
  readonly converted?: boolean;
}

interface Spec {
  readonly id: string;
  readonly team: string;
  readonly roster?: 'member' | 'not_member';
  readonly gender?: Gender;
  /** Swims by event key. */
  readonly swims: Readonly<Record<string, readonly SwimSpec[]>>;
}

const one = (time: number): SwimSpec[] => [{ time }];

const meetEvent = (eventKey: string, gender: Gender = 'Men'): MeetEvent =>
  eventKey === DIVE || eventKey === DIVE3
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
    recordedTime: { text: (s.time / 100).toFixed(2), hundredths: s.time },
    date: null,
    seasonId: null,
    flags: {},
    scy: s.converted === true ? { kind: 'converted', hundredths: s.time, basis: { method: 'swimcloud', displayedText: 'synthetic' }, estimated: true } : { kind: 'recorded-scy' },
    origin: ORIGIN,
  };
}

function buildModel(specs: readonly Spec[], eventKeys: readonly string[], womenKeys: readonly string[] = []): MeetModel {
  const swims: MeetSwim[] = [];
  const splits: RelaySplit[] = [];
  for (const s of specs) for (const [eventKey, list] of Object.entries(s.swims)) list.forEach((x, i) => swims.push(swimOf(s.id, eventKey, x, i)));
  // A flying split for every swimmer with a swim named `<id>:100 Freestyle`: one second under it (synthetic).
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
    swimmers: specs.map((s) => ({ swimmerId: s.id, teamId: s.team, gender: s.gender ?? ('Men' as const), classYear: null, roster: s.roster ?? ('member' as const) })),
    events: [...eventKeys.map((k) => meetEvent(k)), ...womenKeys.map((k) => meetEvent(k, 'Women'))],
    swims,
    relaySplits: splits,
    recordRange: { kind: 'seasons', seasonIds: ['2025-26'] },
    extendedWindow: false,
    observedScores: null,
  };
}

const ind = (team: string, swimmerId: string, eventKey: string, seedSwimId: string | null = null, gender: Gender = 'Men'): LineupEntry => ({ kind: 'individual', teamId: team, swimmerId, eventKey, gender, seedSwimId });
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
  /** The per-event scorer cap (default 1). */
  readonly cap?: number;
  /** `entries.maxIndividualPerSwimmer` (default 2). */
  readonly maxInd?: number | 'unlimited';
  readonly size?: number;
}

/** nsisc v4 with the settings a test names changed. */
function rulesOf(o: RuleOpts = {}): CompleteRulePreset {
  const base = builtinRulePreset('nsisc', 4) as RulePreset;
  return requireComplete({
    ...base,
    scorers: {
      ...base.scorers,
      perEventScorerCap: set({ cap: o.cap ?? 1, overCap: 'removed-from-consideration' as const }),
      ...(o.size === undefined ? {} : { scoringTeamSize: set(o.size) }),
    },
    entries: { ...base.entries, maxIndividualPerSwimmer: set(o.maxInd ?? 2), ...(o.maxInd === 'unlimited' ? { maxTotalPerSwimmer: set('unlimited' as const) } : {}) },
  });
}

interface Fx {
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly tags: readonly ScorerTag[];
  readonly rules: CompleteRulePreset;
}

type Load = NonNullable<AutoBuildRequest['load']>;

function request(fx: Fx, over: Partial<AutoBuildRequest> = {}): AutoBuildRequest {
  return { model: fx.model, lineup: fx.lineup, rules: fx.rules, sourcing: SOURCING, tags: fx.tags, ownTeamId: 'A', genders: ['Men'], objective: { kind: 'max-own' }, load: null, limits: LIMITS, ...over };
}

const respect = (max: number): LoadPreference => ({ mode: 'respect', maxRacesPerSession: set(max), diving: set('excluded' as const) });
const timedFinal = (eventKey: string): ScheduledEvent => ({ eventKey, gender: 'both', format: { kind: 'timed-final', session: { day: 1, slot: 'evening' } } });
const schedule = (...events: ScheduledEvent[]): SessionPreset => ({ payloadVersion: 1, provenance: TEST_PROVENANCE, events });

/** The mode and the proof status of the last run: the facts of the search the oracle needs for the `search_limit` and `objective` labels. */
const lastRun: { maxOwn: boolean; status: string } = { maxOwn: true, status: 'proven_optimal' };

async function run(req: AutoBuildRequest, solver: Parameters<typeof autoBuild>[1] = nodeMipSolve()): Promise<AutoBuildResult> {
  const result = await autoBuild(req, solver);
  lastRun.maxOwn = req.objective.kind === 'max-own';
  lastRun.status = 'proof' in result ? result.proof.status : 'unknown';
  return result;
}

async function built(fx: Fx, over: Partial<AutoBuildRequest> = {}): Promise<AutoBuildProposal> {
  const result: AutoBuildResult = await run(request(fx, over));
  if (result.kind !== 'improved') throw new Error(`expected an improved result, got ${result.kind}`);
  return result.proposal;
}

// ---- the world ---------------------------------------------------------------------------------

/**
 * Three individual events, the own swimmers S and T, and four rivals each on a team of their own (the per-event cap applies per team).
 *
 *   S (own):  E1 40.00, E2 41.00, E3 42.00      T (own): E2 39.00
 *   R1 (B):   E1 45.00, E2 46.00, E3 38.00      R2 (D): E1 44.00, E2 47.00
 *   R4 (E):   E3 43.00                          R5 (F): E3 46.00
 *
 * S alone against the other teams is 1st in E1 and in E2 (20 points) and 2nd in E3 (behind R1). Ties on place and points break by event key,
 * so his ranking is E2 ("100 Backstroke" sorts before "100 Freestyle"), E1, E3. T is entered in E2 now. With the per-event cap of 1 a second own entry
 * there adds nothing, and the fewest-changes tie-break keeps T. S swims E1 and E3.
 */
function world(o: { sE2?: readonly SwimSpec[]; cap?: number; r4?: number; maxInd?: number | 'unlimited'; sE3?: readonly SwimSpec[]; sMore?: Readonly<Record<string, readonly SwimSpec[]>>; current?: readonly LineupEntry[]; extra?: readonly Spec[]; extraTags?: readonly ScorerTag[]; events?: readonly string[]; size?: number } = {}): Fx {
  const specs: Spec[] = [
    { id: 'S', team: 'A', swims: { [E1]: one(4000), [E2]: o.sE2 ?? one(4100), [E3]: o.sE3 ?? one(4200), ...(o.sMore ?? {}) } },
    { id: 'T', team: 'A', swims: { [E2]: one(3900) } },
    { id: 'R1', team: 'B', swims: { [E1]: one(4500), [E2]: one(4600), [E3]: one(3800) } },
    { id: 'R2', team: 'D', swims: { [E1]: one(4400), [E2]: one(4700) } },
    { id: 'R4', team: 'E', swims: { [E3]: one(o.r4 ?? 4300) } },
    { id: 'R5', team: 'F', swims: { [E3]: one(4600) } },
    ...(o.extra ?? []),
  ];
  return {
    model: buildModel(specs, o.events ?? [E1, E2, E3]),
    lineup: lineup(ind('B', 'R1', E1), ind('B', 'R1', E2), ind('B', 'R1', E3), ind('D', 'R2', E1), ind('D', 'R2', E2), ind('E', 'R4', E3), ind('F', 'R5', E3), ind('A', 'T', E2), ...(o.current ?? [])),
    tags: [...tags('A', ['S', 'T']), ...tags('B', ['R1']), ...tags('D', ['R2']), ...tags('E', ['R4']), ...tags('F', ['R5']), ...(o.extraTags ?? [])],
    rules: rulesOf({ maxInd: o.maxInd ?? 2, ...(o.cap === undefined ? {} : { cap: o.cap }), ...(o.size === undefined ? {} : { size: o.size }) }),
  };
}

// ---- the oracle ---------------------------------------------------------------------------------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const swimValue = (s: MeetSwim): number | null => (s.scy.kind === 'converted' ? s.scy.hundredths : s.recordedTime === null ? null : s.recordedTime.hundredths);
const ownTotal = (r: Results): number => (r.teams.find((t) => t.teamId === 'A') as { points: number }).points;

/** The seed an entry has, from the model swims: the pinned swim, or the best rankable value (a dive: the highest). */
function seedOf(fx: Fx, entry: LineupEntry & { kind: 'individual' }): number | null {
  const swims = fx.model.swims.filter((s) => s.swimmerId === entry.swimmerId && s.eventKey === entry.eventKey);
  if (entry.seedSwimId !== null) return swimValue(swims.find((s) => s.swimId === entry.seedSwimId) as MeetSwim);
  const diving = fx.model.events.find((e) => e.eventKey === entry.eventKey)?.kind === 'diving';
  const values = swims.filter((s) => s.flags.userInputted !== true && s.flags.extractedSplit !== true).map(swimValue).filter((v): v is number => v !== null);
  return values.length === 0 ? null : diving ? Math.max(...values) : Math.min(...values);
}

function estimatedOf(fx: Fx, entry: LineupEntry & { kind: 'individual' }): boolean {
  const swims = fx.model.swims.filter((s) => s.swimmerId === entry.swimmerId && s.eventKey === entry.eventKey);
  if (entry.seedSwimId !== null) return (swims.find((s) => s.swimId === entry.seedSwimId) as MeetSwim).scy.kind === 'converted';
  const seed = seedOf(fx, entry);
  return swims.filter((s) => swimValue(s) === seed).every((s) => s.scy.kind === 'converted');
}

interface OracleOpts {
  readonly maxInd: number | 'unlimited';
  readonly load?: Load;
  /** The scoring-team size in spots (the diver weight is a third of one). */
  readonly size?: number;
  /** The pairs `swimmerId|eventKey` that were outside the candidate columns of the run (default: none). */
  readonly outside?: readonly string[];
}

/** The explanation list of D5 9, from `scoreMeet` and `sessionLoad` alone. */
function expected(fx: Fx, proposal: AutoBuildProposal, o: OracleOpts): AutoBuildExplanation[] {
  const score = (entries: readonly LineupEntry[], tg: readonly ScorerTag[] = proposal.tagsForScoring): Results => scoreMeet(fx.model, lineup(...entries), tg, fx.rules, SOURCING);
  const results = score(proposal.lineup.entries);
  const own = ownTotal(results);
  const owned = new Set(proposal.tagsForScoring.filter((t) => t.teamId === 'A' && t.role === 'scorer').map((t) => t.swimmerId));
  const out: AutoBuildExplanation[] = [];

  for (const add of [...proposal.rosterAdds].sort((a, b) => cmp(a.swimmerId, b.swimmerId))) {
    const scorers = [...owned].filter((id) => fx.model.swimmers.find((s) => s.swimmerId === id)?.gender === 'Men');
    const relays = new Set(proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A').flatMap((e) => (e.kind === 'relay' ? e.legs.map((l) => l.swimmerId) : [])));
    const divers = scorers.filter((id) => !relays.has(id) && proposal.lineup.entries.some((e) => e.kind === 'individual' && e.swimmerId === id && e.eventKey === DIVE)).length;
    const weight = (builtinRulePreset('nsisc', 4) as RulePreset).scorers.diverWeight;
    if (weight.state !== 'set') throw new Error('the fixture needs a set diver weight');
    const den = weight.value.denominator;
    const without = proposal.lineup.entries.filter((e) => e.teamId !== 'A' || (e.kind === 'individual' ? e.swimmerId !== add.swimmerId : e.legs.every((l) => l.swimmerId !== add.swimmerId)));
    out.push({
      kind: 'roster_add',
      swimmerId: add.swimmerId,
      spotsAfter: { numerator: (scorers.length - divers) * den + divers * weight.value.numerator, denominator: den },
      marginalPoints: own - ownTotal(score(without)),
    });
  }

  // The request builds the men. A woman tagged on the own team stays as entered and is not explained.
  const mine = proposal.lineup.entries.filter((e): e is LineupEntry & { kind: 'individual' } => e.kind === 'individual' && e.teamId === 'A' && e.gender === 'Men' && owned.has(e.swimmerId));
  for (const swimmerId of [...new Set(mine.map((e) => e.swimmerId))].sort(cmp)) {
    const entries = mine.filter((e) => e.swimmerId === swimmerId);
    // The proposal's entry, else the request's own current entry (it may name a seed swim), else a new one.
    const current = (eventKey: string): (LineupEntry & { kind: 'individual' }) | undefined => fx.lineup.entries.find((e): e is LineupEntry & { kind: 'individual' } => e.kind === 'individual' && e.teamId === 'A' && e.swimmerId === swimmerId && e.eventKey === eventKey);
    const fresh = (eventKey: string): LineupEntry & { kind: 'individual' } => entries.find((e) => e.eventKey === eventKey) ?? current(eventKey) ?? (ind('A', swimmerId, eventKey) as LineupEntry & { kind: 'individual' });
    // The swimmer alone: every other team's entry and his one entry.
    const alone = (eventKey: string): { place: number; points: number } | null => {
      const e = fresh(eventKey);
      if (seedOf(fx, e) === null) return null;
      const r = score([...fx.lineup.entries.filter((x) => x.teamId !== 'A'), e], [...fx.tags.filter((t) => t.teamId !== 'A'), ...tags('A', [swimmerId])]);
      const row = r.events.find((x) => x.eventKey === eventKey)?.rows.find((x) => x.entryKey === entryKey(e));
      return row === undefined || row.place === null ? null : { place: row.place, points: row.points };
    };
    const ranking = fx.model.events
      .filter((e) => e.kind !== 'relay' && e.gender === 'Men')
      .flatMap((e) => {
        const a = alone(e.eventKey);
        return a === null ? [] : [{ eventKey: e.eventKey, ...a }];
      })
      .sort((a, b) => a.place - b.place || b.points - a.points || cmp(a.eventKey, b.eventKey));
    const best = new Set(ranking.slice(0, entries.length).map((r) => r.eventKey));
    for (const entry of [...entries].sort((a, b) => cmp(entryKey(a), entryKey(b)))) {
      const row = results.events.find((e) => e.eventKey === entry.eventKey)?.rows.find((r) => r.entryKey === entryKey(entry));
      if (row === undefined || row.place === null || best.has(entry.eventKey)) continue;
      const field = (results.events.find((e) => e.eventKey === entry.eventKey) as { rows: typeof results.events[number]['rows'] }).rows.filter((r) => r.teamId !== 'A' && r.place !== null);
      const behindRows = field.filter((r) => (r.place as number) > (row.place as number)).sort((a, b) => (a.place as number) - (b.place as number) || cmp(a.teamId, b.teamId));
      const next = behindRows[0];
      const rank = ranking.findIndex((r) => r.eventKey === entry.eventKey);
      const skipped = ranking
        .slice(0, rank)
        .filter((r) => !entries.some((e) => e.eventKey === r.eventKey))
        .map((r) => {
          const added = [...proposal.lineup.entries, fresh(r.eventKey)];
          const after = score(added);
          const gain = ownTotal(after) - own;
          // The races over the limit of every swimmer on the roster, from sessionLoad of a whole lineup.
          const overLimit = (entriesOf: readonly LineupEntry[], res: Results): { mine: boolean; extra: number } => {
            if (o.load === undefined) return { mine: false, extra: 0 };
            const run = sessionLoad(fx.model, lineup(...entriesOf), res, o.load.schedule, o.load.preference, fx.rules);
            const max = (o.load.preference as { maxRacesPerSession: { value: number } }).maxRacesPerSession.value;
            let extra = 0;
            for (const s of run.perSwimmer) if (owned.has(s.swimmerId)) for (const x of s.sessions) if (x.races > max) extra += x.races - max;
            return { mine: run.perSwimmer.some((s) => s.swimmerId === swimmerId && s.sessions.some((x) => x.races > max)), extra };
          };
          // The spots of the own men's roster with the entry added: a swimmer with only dive entries and no relay is a diver (a third of a spot).
          const spots = (): number => {
            const w = (builtinRulePreset('nsisc', 4) as RulePreset).scorers.diverWeight;
            if (w.state !== 'set') throw new Error('the fixture needs a set diver weight');
            const isDive = (e: LineupEntry): boolean => fx.model.events.find((m) => m.eventKey === e.eventKey)?.kind === 'diving';
            const mineIn = (id: string): LineupEntry[] => added.filter((e) => e.teamId === 'A' && (e.kind === 'individual' ? e.swimmerId === id : e.legs.some((l) => l.swimmerId === id)));
            const divers = [...owned].filter((id) => mineIn(id).length > 0 && mineIn(id).every((e) => e.kind === 'individual' && isDive(e))).length;
            return (owned.size - divers) * w.value.denominator + divers * w.value.numerator;
          };
          let binding: 'entry_cap' | 'session_load' | 'strict_diver_rule' | 'load_penalty' | 'search_limit' | 'objective' | 'teammates' = 'teammates';
          const respectLimit = o.load !== undefined && o.load.preference.mode === 'respect';
          const preferLimit = o.load !== undefined && o.load.preference.mode === 'prefer';
          const penaltyPerRace = o.load !== undefined && o.load.preference.mode === 'prefer' ? (o.load.preference.penaltyPointsPerExtraRace as { value: number }).value : 0;
          const delta = preferLimit ? (overLimit(added, after).extra - overLimit(proposal.lineup.entries, results).extra) * penaltyPerRace : 0;
          if (o.maxInd !== 'unlimited' && entries.length + 1 > o.maxInd) binding = 'entry_cap';
          else if (respectLimit && overLimit(added, after).mine) binding = 'session_load';
          else if (o.size !== undefined && spots() > o.size * 3) binding = 'strict_diver_rule';
          else if (preferLimit && gain > 0 && delta > 0 && gain - delta <= 0) binding = 'load_penalty';
          else if (gain > 0) binding = lastRun.maxOwn || lastRun.status !== 'proven_optimal' || (o.outside ?? []).includes(`${swimmerId}|${r.eventKey}`) ? 'search_limit' : 'objective';
          return { eventKey: r.eventKey, placeAlone: r.place, marginalPoints: gain, binding };
        });
      const seed = seedOf(fx, entry) as number;
      out.push({
        kind: 'unusual_event',
        entryKey: entryKey(entry),
        swimmerId,
        eventKey: entry.eventKey,
        gender: 'Men',
        place: row.place,
        points: row.points,
        seed,
        estimated: estimatedOf(fx, entry),
        otherTeamsAhead: field.filter((r) => (r.place as number) < (row.place as number)).length,
        nextOtherTeamBehind: next === undefined ? null : { teamId: next.teamId, seed: seedOf(fx, ind(next.teamId, next.swimmerId as string, entry.eventKey) as LineupEntry & { kind: 'individual' }) as number },
        marginalPoints: own - ownTotal(score(proposal.lineup.entries.filter((e) => entryKey(e) !== entryKey(entry)))),
        skipped,
      });
    }
  }
  return out;
}

const unusual = (xs: readonly AutoBuildExplanation[]): Unusual[] => xs.filter((x): x is Unusual => x.kind === 'unusual_event');
const adds = (xs: readonly AutoBuildExplanation[]): RosterAdd[] => xs.filter((x): x is RosterAdd => x.kind === 'roster_add');

describe('autoBuild (D5, slice A8: explanations)', () => {
  it('1 explanationFactsRederive: every fact of an unusual entry equals the value the oracle derives from scoreMeet and the model', async () => {
    const fx = world();
    const proposal = await built(fx);
    // The build is the one the fixture describes: S swims E1 and E3, T swims E2.
    const own = proposal.lineup.entries.filter((e) => e.teamId === 'A').map(entryKey).sort();
    expect(own).toEqual([entryKey(ind('A', 'S', E1)), entryKey(ind('A', 'S', E3)), entryKey(ind('A', 'T', E2))].sort());
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    // The values by hand: S is 2nd in the 100 fly with 42.00 behind R1. The next other-team entry behind is R4 (43.00, team E).
    expect(unusual(proposal.explanations)).toEqual([
      {
        kind: 'unusual_event',
        entryKey: entryKey(ind('A', 'S', E3)),
        swimmerId: 'S',
        eventKey: E3,
        gender: 'Men',
        place: 2,
        points: proposal.evaluation.results.events.find((e) => e.eventKey === E3)?.rows.find((r) => r.teamId === 'A')?.points,
        seed: 4200,
        estimated: false,
        otherTeamsAhead: 1,
        nextOtherTeamBehind: { teamId: 'E', seed: 4300 },
        marginalPoints: proposal.evaluation.results.events.find((e) => e.eventKey === E3)?.rows.find((r) => r.teamId === 'A')?.points,
        skipped: [{ eventKey: E2, placeAlone: 1, marginalPoints: 0, binding: 'entry_cap' }],
      },
    ]);
    expect((unusual(proposal.explanations)[0] as Unusual).points).toBeGreaterThan(0);
  });

  it('2 bestEventsGetNoExplanation: a swimmer entered in the best n events by place alone gets no explanation', async () => {
    // T is gone. S swims his two best events by place alone, E2 and E1, so neither is unusual.
    const fx = world();
    const noT: Fx = {
      ...fx,
      model: { ...fx.model, swims: fx.model.swims.filter((s) => s.swimmerId !== 'T') },
      lineup: lineup(...fx.lineup.entries.filter((e) => e.kind !== 'individual' || e.swimmerId !== 'T')),
      tags: fx.tags.filter((t) => t.swimmerId !== 'T'),
    };
    const proposal = await built(noT);
    expect(proposal.lineup.entries.filter((e) => e.teamId === 'A').map(entryKey).sort()).toEqual([entryKey(ind('A', 'S', E1)), entryKey(ind('A', 'S', E2))].sort());
    expect(proposal.explanations).toEqual([]);
    expect(expected(noT, proposal, { maxInd: 2 })).toEqual([]);
  });

  it('2b theOrderIsPlaceThenPointsThenEventKey: ties on place and points break by event key, and a better place ranks first', () => {
    const ev = (eventKey: string): MeetEvent => meetEvent(eventKey);
    const rows = [
      { event: ev(E1), place: 2, points: 17 },
      { event: ev(E3), place: 1, points: 20 },
      { event: ev(E2), place: 1, points: 20 },
      { event: ev('200 Freestyle'), place: 1, points: 22 },
    ];
    expect([...rows].sort(rankOrder).map((r) => r.event.eventKey)).toEqual(['200 Freestyle', E2, E3, E1]);
  });

  it('3 estimatedOnlyOnConvertedSeeds: the badge is on a converted seed, off on a recorded one, and follows a named seed swim', async () => {
    // The seed of S in the 100 fly is a converted swim: est.
    const converted = world({ sE3: [{ time: 4200, converted: true }] });
    const pc = await built(converted);
    expect(pc.explanations).toEqual(expected(converted, pc, { maxInd: 2 }));
    expect(unusual(pc.explanations).map((x) => [x.eventKey, x.estimated])).toEqual([[E3, true]]);
    // Recorded: no badge.
    const recorded = await built(world());
    expect(unusual(recorded.explanations).map((x) => [x.eventKey, x.estimated])).toEqual([[E3, false]]);
    // The entry names a converted swim although a faster recorded one exists: the named swim is the seed, so est.
    const pinned = world({ sE3: [{ time: 4150, id: 's3rec' }, { time: 4200, id: 's3conv', converted: true }], current: [ind('A', 'S', E3, 's3conv')] });
    const pp = await built(pinned);
    expect(pp.explanations).toEqual(expected(pinned, pp, { maxInd: 2 }));
    expect(unusual(pp.explanations).map((x) => [x.eventKey, x.seed, x.estimated])).toEqual([[E3, 4200, true]]);
  });

  it('3b seedIsEstimated: a recorded swim at the same value proves the value, and a named seed swim wins', () => {
    const swim = (id: string, time: number, converted: boolean): MeetSwim => swimOf('S', E3, { time, id, converted }, 0);
    const entry = ind('A', 'S', E3) as LineupEntry & { kind: 'individual' };
    expect(seedIsEstimated([swim('c', 4200, true)], entry, 4200)).toBe(true);
    expect(seedIsEstimated([swim('c', 4200, true), swim('r', 4200, false)], entry, 4200)).toBe(false);
    expect(seedIsEstimated([swim('c', 4200, true), swim('r', 4300, false)], entry, 4200)).toBe(true);
    expect(seedIsEstimated([swim('c', 4200, true), swim('r', 4100, false)], { ...entry, seedSwimId: 'c' }, 4200)).toBe(true);
    expect(seedIsEstimated([swim('c', 4200, true), swim('r', 4100, false)], { ...entry, seedSwimId: 'r' }, 4100)).toBe(false);
    expect(() => seedIsEstimated([swim('r', 4300, false)], entry, 4200)).toThrow(/seed value/);
    // A typed-in swim is not a candidate seed, so it cannot prove the value: the converted swim is the seed.
    const typed: MeetSwim = { ...swim('typed', 4200, false), flags: { userInputted: true } };
    expect(seedIsEstimated([swim('c', 4200, true), typed], entry, 4200)).toBe(true);
  });

  it('4 bindingOrderTeammates: with room under every cap, a skipped event where a teammate wins is "teammates"', async () => {
    const fx = world({ maxInd: 4 });
    const proposal = await built(fx);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 4 }));
    expect((unusual(proposal.explanations)[0] as Unusual).skipped).toEqual([{ eventKey: E2, placeAlone: 1, marginalPoints: 0, binding: 'teammates' }]);
  });

  it('4b bindingOrderSessionLoadBeatsTeammates: at the session limit with no entry cap, the skipped event is "session_load"', async () => {
    const fx = world({ maxInd: 'unlimited' });
    const load: Load = { schedule: schedule(timedFinal(E1), timedFinal(E2), timedFinal(E3)), preference: respect(2) };
    const proposal = await built(fx, { load });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 'unlimited', load }));
    expect((unusual(proposal.explanations)[0] as Unusual).skipped).toEqual([{ eventKey: E2, placeAlone: 1, marginalPoints: 0, binding: 'session_load' }]);
  });

  it('4c bindingOrderEntryCapBeatsSessionLoad: when both the entry cap and the session limit break, the skipped event is "entry_cap"', async () => {
    const fx = world({ maxInd: 2 });
    const load: Load = { schedule: schedule(timedFinal(E1), timedFinal(E2), timedFinal(E3)), preference: respect(2) };
    const proposal = await built(fx, { load });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2, load }));
    expect((unusual(proposal.explanations)[0] as Unusual).skipped).toEqual([{ eventKey: E2, placeAlone: 1, marginalPoints: 0, binding: 'entry_cap' }]);
  });

  it('4d preferModeIsNotSessionLoad: a preference is not a hard limit, so a skipped event is "teammates"', async () => {
    const fx = world({ maxInd: 4 });
    const load: Load = { schedule: schedule(timedFinal(E1), timedFinal(E2), timedFinal(E3)), preference: { mode: 'prefer', maxRacesPerSession: set(2), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(1) } };
    const proposal = await built(fx, { load });
    for (const x of unusual(proposal.explanations)) for (const s of x.skipped) expect(s.binding).toBe('teammates');
    expect(unusual(proposal.explanations).length).toBeGreaterThan(0);
  });

  it('5 robustUsesNormalSeeds: a robust proposal is explained with the normal seeds the applied lineup would have', async () => {
    // S has three dated swims in each event. His best 100 fly is 42.00 and his robust swim 44.00. The proposal carries no pins.
    const swims = (who: string, event: string, times: readonly number[]): readonly SwimSpec[] => times.map((time, i) => ({ time, id: `${who}:${event}:${i}` }));
    const specs: Spec[] = [
      { id: 'S', team: 'A', swims: { [E1]: swims('S', E1, [4000, 4050, 4100]), [E2]: swims('S', E2, [4100, 4150, 4200]), [E3]: swims('S', E3, [4200, 4400, 4500]) } },
      { id: 'T', team: 'A', swims: { [E2]: swims('T', E2, [3900]) } },
      { id: 'R1', team: 'B', swims: { [E1]: one(4500), [E2]: one(4600), [E3]: one(3800) } },
      { id: 'R2', team: 'D', swims: { [E1]: one(4400), [E2]: one(4700) } },
      { id: 'R4', team: 'E', swims: { [E3]: one(4300) } },
      { id: 'R5', team: 'F', swims: { [E3]: one(4600) } },
    ];
    const base = world();
    // Date the swims: the model swims need a date inside the record range for the robust rule.
    const model = buildModel(specs, [E1, E2, E3]);
    const dateSwims = model.swims.map((s, i) => (s.swimmerId === 'S' ? { ...s, date: `2026-03-${String(10 + (i % 3)).padStart(2, '0')}`, seasonId: '2025-26' } : s));
    const fx: Fx = { ...base, model: { ...model, swims: dateSwims, recordRange: { kind: 'dates', from: '2025-09-01', to: '2026-06-30' } } };
    const proposal = await built(fx, { objective: { kind: 'robust', recentSwims: 5, minSwims: 3 } });
    expect(proposal.evaluation.robustOwnPoints).not.toBeNull();
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    // Normal seeds: the explanation names S's best 100 fly (42.00), and the lineup carries no pin.
    const x = unusual(proposal.explanations).find((u) => u.eventKey === E3) as Unusual;
    expect(x.seed).toBe(4200);
    expect(proposal.lineup.entries.every((e) => e.kind !== 'individual' || e.seedSwimId === null)).toBe(true);
    // Its place and points are the proposal's normal-seed rows, not the robust ones.
    const row = proposal.evaluation.results.events.find((e) => e.eventKey === E3)?.rows.find((r) => r.swimmerId === 'S');
    expect([x.place, x.points]).toEqual([row?.place, row?.points]);
  });

  it('6 marginalPointsStayOwnPointsInMarginAndGoalSeek: the mode ranks by margin, but an entry adds its own points', async () => {
    // Rival E (R4): S's 2nd place in the 100 fly pushes R4 from 2nd to 3rd, so the margin gain (own + rival loss) is larger than the own gain.
    const fx = world();
    const margin = await built(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'E' } } });
    expect(margin.explanations).toEqual(expected(fx, margin, { maxInd: 2 }));
    const x = unusual(margin.explanations).find((u) => u.eventKey === E3) as Unusual;
    const without = scoreMeet(fx.model, lineup(...margin.lineup.entries.filter((e) => entryKey(e) !== x.entryKey)), margin.tagsForScoring, fx.rules, SOURCING);
    const ownGain = ownTotal(margin.evaluation.results) - ownTotal(without);
    const rivalLoss = (without.teams.find((t) => t.teamId === 'E') as { points: number }).points - (margin.evaluation.results.teams.find((t) => t.teamId === 'E') as { points: number }).points;
    expect(rivalLoss).toBeGreaterThan(0);
    expect(x.marginalPoints).toBe(ownGain);
    expect(x.marginalPoints).not.toBe(ownGain + rivalLoss);
    // Goal seek: the same facts.
    const goal = await built(fx, { objective: { kind: 'goal-seek', target: { kind: 'total', points: ownTotal(margin.evaluation.results) } } });
    expect(goal.explanations).toEqual(expected(fx, goal, { maxInd: 2 }));
  });

  it('7 rosterAddFacts: a swimmer the proposal adds gets spotsAfter and marginalPoints, and a diver counts a fraction of a spot', async () => {
    // W is untagged and alone in the 100 breast for his team. D is a tagged diver. S, T, D and the new W are on the roster after the add.
    const extra: Spec[] = [
      { id: 'W', team: 'A', swims: { [E4]: one(3700) } },
      { id: 'R8', team: 'I', swims: { [E4]: one(4500) } },
      { id: 'N', team: 'A', swims: {} },
      { id: 'D', team: 'A', swims: { [DIVE]: one(25000) } },
      { id: 'R6', team: 'G', swims: { [DIVE]: one(24000) } },
      { id: 'R7', team: 'H', swims: { [DIVE]: one(23000) } },
    ];
    const base = world({ extra, extraTags: [...tags('A', ['D']), ...tags('G', ['R6']), ...tags('H', ['R7']), ...tags('I', ['R8'])], events: [E1, E2, E3, E4, DIVE], current: [ind('G', 'R6', DIVE), ind('H', 'R7', DIVE), ind('I', 'R8', E4)] });
    // N is tagged a non-scorer: he is on the team but takes no scoring spot.
    const fx: Fx = { ...base, tags: [...base.tags, { teamId: 'A', swimmerId: 'N', role: 'non-scorer' as const }] };
    const proposal = await built(fx);
    expect(proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['W']);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const add = adds(proposal.explanations)[0] as RosterAdd;
    // Pinned S and T, the diver D and the new W: three full spots and one diver at a third of a spot (denominator 3).
    expect(add.spotsAfter).toEqual({ numerator: 3 * 3 + 1, denominator: 3 });
    expect(add.marginalPoints).toBeGreaterThan(0);
    // The spots are the ones scoreMeet counts: rescored under a roster limit of 1, its violation carries the same fraction.
    const tight = requireComplete({ ...(builtinRulePreset('nsisc', 4) as RulePreset), scorers: { ...(builtinRulePreset('nsisc', 4) as RulePreset).scorers, scoringTeamSize: set(1) } });
    const rescored = scoreMeet(fx.model, proposal.lineup, proposal.tagsForScoring, tight, SOURCING);
    const violation = rescored.violations.find((v) => v.kind === 'scoring_team_size' && v.teamId === 'A');
    expect(violation?.kind === 'scoring_team_size' && violation.spots).toEqual(add.spotsAfter);
  });

  it('7b rosterSpots: a swimmer who dives and swims a relay is a full spot, and a diver alone a fraction', () => {
    const dive = ind('A', 'D1', DIVE);
    const both = ind('A', 'D2', DIVE);
    const l = lineup(dive, both, relay('A', 'A', ['D2', 'x', 'y', 'z']));
    expect(rosterSpots(l, ['D1', 'D2', 'P'], { numerator: 1, denominator: 3 }, [meetEvent(DIVE)])).toEqual({ numerator: 2 * 3 + 1, denominator: 3 });
    expect(rosterSpots(l, ['P'], { numerator: 1, denominator: 3 }, [meetEvent(DIVE)])).toEqual({ numerator: 3, denominator: 3 });
  });


  it('7c aJoinedSwimmerIsExplainedToo: a free swimmer the proposal adds gets a roster_add and his own unusual entries', async () => {
    // S is untagged now. He joins, and his 100 fly entry is as unusual as it was when he was pinned.
    const pinned = world();
    const fx: Fx = { ...pinned, tags: pinned.tags.filter((t) => t.swimmerId !== 'S') };
    const proposal = await built(fx);
    expect(proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['S']);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    expect(proposal.explanations.map((x) => x.kind)).toEqual(['roster_add', 'unusual_event']);
    expect(unusual(proposal.explanations)[0]?.eventKey).toBe(E3);
  });

  it('7d twoAddsAreSortedBySwimmerId: roster adds come first, by swimmer id', async () => {
    // W1 and W2 are untagged, and each is alone in one event for the team. Both join.
    const extra: Spec[] = [
      { id: 'W2', team: 'A', swims: { [E4]: one(3700) } },
      { id: 'W1', team: 'A', swims: { [E5]: one(3600) } },
      { id: 'R8', team: 'I', swims: { [E4]: one(4500), [E5]: one(4400) } },
    ];
    const fx = world({ extra, extraTags: tags('I', ['R8']), events: [E1, E2, E3, E4, E5], current: [ind('I', 'R8', E4), ind('I', 'R8', E5)] });
    const proposal = await built(fx);
    expect(proposal.rosterAdds.map((a) => a.swimmerId).sort()).toEqual(['W1', 'W2']);
    expect(adds(proposal.explanations).map((a) => a.swimmerId)).toEqual(['W1', 'W2']);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const kinds = proposal.explanations.map((x) => x.kind);
    expect(kinds.slice(0, 2)).toEqual(['roster_add', 'roster_add']);
  });

  it('8 relaysGetNoUnusualEvent: an own relay in the proposal is never explained as an unusual event', async () => {
    // U1 to U4 are pinned own relay legs (a flat-start swim and flying splits). X1 to X4 swim the rival relay.
    const legs = (ids: readonly string[], team: string, base: number): Spec[] => ids.map((id, i) => ({ id, team, swims: { [E1]: [{ time: base + i * 20, id: `${id}:${E1}` }] } }));
    const own = ['U1', 'U2', 'U3', 'U4'];
    const rival = ['X1', 'X2', 'X3', 'X4'];
    const fx = world({
      // U4 is by far the fastest leg, so the squad needs him.
      extra: [...legs(own.slice(0, 3), 'A', 4700), ...legs(['U4'], 'A', 3000), ...legs(rival, 'J', 4500)],
      // U4 is untagged: the proposal adds him for the relay.
      extraTags: [...tags('A', own.slice(0, 3)), ...tags('J', rival)],
      events: [E1, E2, E3, RELAY],
      current: [relay('J', 'A', rival)],
    });
    const proposal = await built(fx);
    const ownRelays = proposal.lineup.entries.filter((e) => e.kind === 'relay' && e.teamId === 'A');
    expect(ownRelays.length).toBeGreaterThan(0);
    expect(proposal.rosterAdds.map((a) => a.swimmerId)).toEqual(['U4']);
    // His roster_add counts the relay: without him the squad is gone.
    expect((adds(proposal.explanations)[0] as RosterAdd).marginalPoints).toBeGreaterThan(0);
    expect(proposal.explanations.some((x) => x.kind === 'unusual_event')).toBe(true);
    for (const x of unusual(proposal.explanations)) {
      expect(x.eventKey).not.toBe(RELAY);
      expect(x.entryKey.startsWith('i|')).toBe(true);
    }
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
  });

  it('9 theLocalSearchProposalIsExplained: a proposal from the fallback has the same explanations', async () => {
    const fx = world();
    const timesOut: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });
    const result = await run(request(fx), timesOut);
    expect(result.kind === 'improved' && result.proposal.method).toBe('local-search');
    if (result.kind !== 'improved') return;
    expect(result.proposal.explanations).toEqual(expected(fx, result.proposal, { maxInd: 2 }));
  });

  it('10 currentInfeasibleAlternativeIsExplained: the alternative of a current_infeasible result carries explanations', async () => {
    // S is entered in three events now, over the cap of 2: the current lineup breaks a hard rule. The alternative swims E1 and E3.
    const fx = world({ current: [ind('A', 'S', E1), ind('A', 'S', E2), ind('A', 'S', E3)] });
    const result = await run(request(fx));
    expect(result.kind).toBe('current_infeasible');
    if (result.kind !== 'current_infeasible' || result.alternative === null) throw new Error('no alternative');
    expect(result.alternative.explanations).toEqual(expected(fx, result.alternative, { maxInd: 2 }));
    expect(unusual(result.alternative.explanations).length).toBeGreaterThan(0);
  });

  it('11 explanationsChangeNothingElse: with explain switched off the lineup, evaluation, proof and every other field are the same', async () => {
    const fx = world();
    const strip = (r: AutoBuildResult): unknown => {
      const copy = JSON.parse(JSON.stringify(r)) as { proposal?: { explanations?: unknown }; proof: { timings?: unknown; solves: { ms?: unknown }[] } };
      if (copy.proposal !== undefined) copy.proposal.explanations = [];
      delete copy.proof.timings;
      for (const s of copy.proof.solves) delete s.ms;
      return copy;
    };
    const on = await autoBuild(request(fx), nodeMipSolve());
    switchedOff.off = true;
    let off: AutoBuildResult;
    try {
      off = await autoBuild(request(fx), nodeMipSolve());
    } finally {
      switchedOff.off = false;
    }
    expect(on.kind === 'improved' && on.proposal.explanations.length).toBeGreaterThan(0);
    expect(off.kind === 'improved' && off.proposal.explanations).toEqual([]);
    expect(strip(on)).toEqual(strip(off));
  });

  it('11b theRequestIsNotMutated: explaining reads the request and the proposal and writes neither', async () => {
    const fx = world();
    const frozen = (o: unknown): unknown => {
      if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o as Record<string, unknown>)) frozen(v);
      }
      return o;
    };
    frozen(fx.model);
    frozen(fx.lineup);
    frozen(fx.tags);
    frozen(fx.rules);
    const proposal = await built(fx);
    expect(proposal.explanations.length).toBeGreaterThan(0);
  });

  it('12 anEntryRemovedFromThePlacesIsNotExplained: an unusual entry with no place has nothing to say', async () => {
    // S is kept in the 100 breast with T2, who is faster: the cap of 1 removes S from the places. S ranks that event last, so it is unusual,
    // but it has no place, so it gets no explanation. With three entries his best three are E2, E1 and E3, so nothing else is unusual.
    const extra: Spec[] = [
      { id: 'T2', team: 'A', swims: { [E4]: one(4000) } },
      { id: 'R8', team: 'I', swims: { [E4]: one(4500) } },
      { id: 'R9', team: 'K', swims: { [E4]: one(4600) } },
    ];
    const fx = world({
      maxInd: 4,
      extra,
      sMore: { [E4]: one(5000) },
      extraTags: [...tags('A', ['T2']), ...tags('I', ['R8']), ...tags('K', ['R9'])],
      events: [E1, E2, E3, E4],
      current: [ind('A', 'S', E4), ind('A', 'T2', E4), ind('I', 'R8', E4), ind('K', 'R9', E4)],
    });
    const proposal = await built(fx);
    const kept = proposal.evaluation.results.events.find((e) => e.eventKey === E4)?.rows.find((r) => r.swimmerId === 'S');
    expect(kept?.place).toBeNull();
    expect(proposal.lineup.entries).toContainEqual(ind('A', 'S', E4));
    expect(proposal.explanations).toEqual([]);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 4 }));
  });

  it('13 anEntryOfAnotherGenderIsNotExplained: a woman tagged on the own team stays as entered and is not ranked', async () => {
    // The request builds the men. The own team also has a woman with an entry, and the other team a woman with one.
    const women: Spec[] = [
      { id: 'WS', team: 'A', gender: 'Women', swims: { [E1]: one(4800) } },
      { id: 'WR', team: 'B', gender: 'Women', swims: { [E1]: one(4900) } },
    ];
    const base = world({ extra: women, extraTags: [...tags('A', ['WS']), ...tags('B', ['WR'])], current: [ind('A', 'WS', E1, null, 'Women'), ind('B', 'WR', E1, null, 'Women')] });
    const withWomen: Fx = { ...base, model: { ...base.model, events: [...base.model.events, meetEvent(E1, 'Women')] } };
    const proposal = await built(withWomen);
    expect(proposal.lineup.entries).toContainEqual(ind('A', 'WS', E1, null, 'Women'));
    expect(proposal.explanations).toEqual(expected(withWomen, proposal, { maxInd: 2 }));
    expect(proposal.explanations.every((x) => x.kind !== 'unusual_event' || x.swimmerId !== 'WS')).toBe(true);
    expect(unusual(proposal.explanations).length).toBeGreaterThan(0);
  });

  it('14 oneSwimmerTwoUnusualEntries: the entries come in entry-key order, and each lists the higher-ranked events he skipped in ranking order', async () => {
    // S swims E3 and E4 only: teammates T (E2) and T6 (E1) are entered ahead of him and hold the cap of 1 in the two events he ranks first.
    const extra: Spec[] = [
      { id: 'T6', team: 'A', swims: { [E1]: one(3950) } },
      { id: 'R8', team: 'I', swims: { [E4]: one(4300) } },
      { id: 'R9', team: 'K', swims: { [E4]: one(4350) } },
    ];
    const fx = world({
      extra,
      sMore: { [E4]: one(4400) },
      extraTags: [...tags('A', ['T6']), ...tags('I', ['R8']), ...tags('K', ['R9'])],
      events: [E1, E2, E3, E4],
      current: [ind('A', 'T6', E1), ind('I', 'R8', E4), ind('K', 'R9', E4)],
    });
    const proposal = await built(fx);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const xs = unusual(proposal.explanations);
    expect(xs.map((x) => x.eventKey)).toEqual([E4, E3]);
    expect(xs.map((x) => x.skipped.map((s) => s.eventKey))).toEqual([[E2, E1], [E2, E1]]);
  });

  it('14b twoSwimmersAreExplainedInSwimmerOrder, and an own teammate ahead is not an other team', async () => {
    // Cap 2: S2 and S both score in the 100 free and the 100 fly, behind R1 in the fly. T and T4 hold the two scoring places in the 100 back.
    const extra: Spec[] = [
      { id: 'S2', team: 'A', swims: { [E1]: one(3990), [E2]: one(4090), [E3]: one(4190) } },
      { id: 'T4', team: 'A', swims: { [E2]: one(3950) } },
    ];
    const fx = world({ cap: 2, extra, extraTags: tags('A', ['S2', 'T4']), current: [ind('A', 'T4', E2)] });
    const proposal = await built(fx);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    expect(unusual(proposal.explanations).map((x) => [x.swimmerId, x.eventKey])).toEqual([['S', E3], ['S2', E3]]);
    // S is 3rd in the fly behind R1 and his own teammate S2: only R1 is another team.
    const s = unusual(proposal.explanations).find((x) => x.swimmerId === 'S') as Unusual;
    expect([s.place, s.otherTeamsAhead]).toEqual([3, 1]);
  });

  it('15 aTieIsNeitherAheadNorBehind: an other-team entry with the same time shares the place and counts in neither direction', async () => {
    // R4 swims 42.00 like S: they share 2nd. R1 is ahead. R5 (46.00) is the next other-team entry behind.
    const fx = world({ r4: 4200 });
    const proposal = await built(fx);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const x = unusual(proposal.explanations).find((u) => u.eventKey === E3) as Unusual;
    expect(x.place).toBe(2);
    expect(x.otherTeamsAhead).toBe(1);
    expect(x.nextOtherTeamBehind).toEqual({ teamId: 'F', seed: 4600 });
  });

  it('16 aSkippedEventCanHavePositiveMarginalPoints: in margin mode the solver prefers the event that hurts the rival', async () => {
    // No T. S is 2nd alone in both E2 (behind R3) and E3 (behind R1), so E2 ranks first by key. Against rival E, his E3 entry also pushes R4
    // down a place, so margin mode swims E1 and E3 and skips E2, which would have added 17 own points. He is at his entry cap.
    const base = world({ extra: [{ id: 'R3', team: 'C', swims: { [E2]: one(3800) } }], extraTags: tags('C', ['R3']), current: [ind('C', 'R3', E2)] });
    const fx: Fx = {
      ...base,
      model: { ...base.model, swims: base.model.swims.filter((s) => s.swimmerId !== 'T') },
      lineup: lineup(...base.lineup.entries.filter((e) => e.kind !== 'individual' || e.swimmerId !== 'T')),
      tags: base.tags.filter((t) => t.swimmerId !== 'T'),
    };
    const proposal = await built(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'E' } } });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const x = unusual(proposal.explanations).find((u) => u.eventKey === E3) as Unusual;
    expect(x.skipped).toEqual([{ eventKey: E2, placeAlone: 2, marginalPoints: 17, binding: 'entry_cap' }]);
  });

  it('17 aDroppedEntryThatNamedASeedSwimIsRankedOnThatSwim: placeAlone, marginalPoints and binding of a skipped event read one seed', async () => {
    // S's current 100 back entry names a slow swim (46.50: 2nd alone behind R1, where his best 41.00 is 1st). The solver drops that entry (T holds the
    // event and S needs his two entries for E1 and E3). The event is skipped, and every number about it uses the entry that was there.
    const fx = world({ sE2: [{ time: 4100 }, { time: 4650, id: 'S:slow' }], current: [ind('A', 'S', E2, 'S:slow')] });
    const proposal = await built(fx);
    expect(proposal.entryChanges).toContainEqual({ kind: 'removed', entryKey: entryKey(ind('A', 'S', E2)), why: 'replaced' });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const x = unusual(proposal.explanations).find((u) => u.eventKey === E3) as Unusual;
    // On the named swim S is 2nd alone in E2 (17 points): tied with E3 on place and points, E2 ranks first by key. On his best swim he would be 1st.
    expect(x.skipped).toEqual([{ eventKey: E2, placeAlone: 2, marginalPoints: 0, binding: 'entry_cap' }]);
  });

  it('17b theNamedSeedReachesMarginalPoints: with a hand-built proposal that drops the named entry, adding it back is valued on that swim', () => {
    // No T. S's current 100 back entry names a slow swim (46.50, 2nd alone behind R1). The proposal swims S in E1 and E3 only. Adding the named
    // entry back would score 2nd (17 points); on his best swim (41.00) it would score 1st (20). The cap of 2 entries is why it is skipped.
    const base = world({ sE2: [{ time: 4100 }, { time: 4650, id: 'S:slow' }], current: [ind('A', 'S', E2, 'S:slow')] });
    const fx: Fx = {
      ...base,
      model: { ...base.model, swims: base.model.swims.filter((s) => s.swimmerId !== 'T') },
      lineup: lineup(...base.lineup.entries.filter((e) => e.kind !== 'individual' || e.swimmerId !== 'T')),
      tags: base.tags.filter((t) => t.swimmerId !== 'T'),
    };
    const req = request(fx);
    const problem = buildProblem(req, { ...checkRules(fx.rules), load: loadRuleOf(null) }, scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING));
    const entries = [...fx.lineup.entries.filter((e) => !(e.kind === 'individual' && e.teamId === 'A')), ind('A', 'S', E1), ind('A', 'S', E3)];
    const results = scoreMeet(fx.model, lineup(...entries), fx.tags, fx.rules, SOURCING);
    const proposal: AutoBuildProposal = {
      lineup: lineup(...entries),
      rosterAdds: [],
      rosterRemoves: [],
      tagsForScoring: fx.tags,
      entryChanges: [],
      changeCount: 0,
      evaluation: { objective: ownTotal(results), ownPoints: ownTotal(results), rival: null, robustOwnPoints: null, penaltyPoints: 0, results, load: null },
      explanations: [],
      newWarnings: [],
      method: 'mip',
    };
    Object.assign(lastRun, { maxOwn: true, status: 'proven_optimal' });
    const out = explain(problem, proposal, { status: 'proven_optimal', candidate: () => true });
    expect(out).toEqual(expected(fx, proposal, { maxInd: 2 }));
    expect(unusual(out).map((x) => x.skipped)).toEqual([[{ eventKey: E2, placeAlone: 2, marginalPoints: 17, binding: 'entry_cap' }]]);
  });

  it('18 bindingStrictDiverRule: a diver at the scoring-team size cannot swim a non-dive event, and the explanation says so', async () => {
    // Size 3 spots (9 thirds). S and T are full spots (6), the divers D3 and D5 a third each: 8. D3 swims the 100 free best of all (39.00), but a swimmer
    // with a non-dive entry is a full spot, so 6 + 3 + 1 = 10 is over. His 1-metre dive (3rd alone) is the unusual entry, and the free is skipped.
    const extra: Spec[] = [
      { id: 'D3', team: 'A', swims: { [E1]: one(3900), [DIVE]: one(22000) } },
      { id: 'D5', team: 'A', swims: { [DIVE3]: one(21000) } },
      { id: 'R6', team: 'G', swims: { [DIVE]: one(24000) } },
      { id: 'R7', team: 'H', swims: { [DIVE]: one(23000) } },
    ];
    const fx = world({
      size: 3,
      extra,
      extraTags: [...tags('A', ['D3', 'D5']), ...tags('G', ['R6']), ...tags('H', ['R7'])],
      events: [E1, E2, E3, DIVE, DIVE3],
      current: [ind('A', 'D3', DIVE), ind('A', 'D5', DIVE3), ind('G', 'R6', DIVE), ind('H', 'R7', DIVE)],
    });
    const proposal = await built(fx);
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2, size: 3 }));
    const d3 = unusual(proposal.explanations).find((x) => x.swimmerId === 'D3') as Unusual;
    expect(d3.eventKey).toBe(DIVE);
    expect(d3.skipped.map((s) => [s.eventKey, s.binding])).toEqual([[E1, 'strict_diver_rule']]);
    // With a roster limit of 4 spots the size does not block him.
    const roomy: Fx = { ...fx, rules: rulesOf({ maxInd: 2, size: 4 }) };
    const open = await built(roomy);
    for (const x of unusual(open.explanations)) for (const s of x.skipped) expect(s.binding).not.toBe('strict_diver_rule');
  });

  it('18b bindingOrderSessionLoadBeatsStrictDiverRule: when the session limit and the strict diver rule both block the entry, it is "session_load"', async () => {
    // The same world as 18. A respect limit of one race per session, with diving counted, puts D3's dive and the free in one session: that is a real limit,
    // and it comes before the strict diver rule. Every other event has its own session, so no one else is held back.
    const extra: Spec[] = [
      { id: 'D3', team: 'A', swims: { [E1]: one(3900), [DIVE]: one(22000) } },
      { id: 'D5', team: 'A', swims: { [DIVE3]: one(21000) } },
      { id: 'R6', team: 'G', swims: { [DIVE]: one(24000) } },
      { id: 'R7', team: 'H', swims: { [DIVE]: one(23000) } },
    ];
    const fx = world({
      size: 3,
      extra,
      extraTags: [...tags('A', ['D3', 'D5']), ...tags('G', ['R6']), ...tags('H', ['R7'])],
      events: [E1, E2, E3, DIVE, DIVE3],
      current: [ind('A', 'D3', DIVE), ind('A', 'D5', DIVE3), ind('G', 'R6', DIVE), ind('H', 'R7', DIVE)],
    });
    const day = (eventKey: string, d: number): ScheduledEvent => ({ eventKey, gender: 'both', format: { kind: 'timed-final', session: { day: d, slot: 'evening' } } });
    const load: Load = {
      schedule: schedule(day(E1, 1), day(DIVE, 1), day(E2, 2), day(E3, 3), day(DIVE3, 4)),
      preference: { mode: 'respect', maxRacesPerSession: set(1), diving: set('counts' as const) },
    };
    const proposal = await built(fx, { load });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2, size: 3, load }));
    const d3 = unusual(proposal.explanations).find((x) => x.swimmerId === 'D3') as Unusual;
    expect(d3.skipped.map((s) => [s.eventKey, s.binding])).toEqual([[E1, 'session_load']]);
  });

  it('19 bindingLoadPenalty: in prefer mode, a third race that costs more than it adds is "load_penalty", not "teammates"', async () => {
    // No T. S is 1st alone in all three events (E2, E3, E1 by key), entered in E1 and E3 now, and the sessions allow two races. A third race (E2) would
    // add 20 points and cost 25: the solver keeps two. W joins in a fourth event, so the proposal improves.
    const base = world({
      maxInd: 'unlimited',
      sE3: one(3700),
      extra: [
        { id: 'W', team: 'A', swims: { [E4]: one(3700) } },
        { id: 'R8', team: 'I', swims: { [E4]: one(4500) } },
      ],
      extraTags: tags('I', ['R8']),
      events: [E1, E2, E3, E4],
      current: [ind('A', 'S', E1), ind('A', 'S', E3), ind('I', 'R8', E4)],
    });
    const fx: Fx = {
      ...base,
      model: { ...base.model, swims: base.model.swims.filter((s) => s.swimmerId !== 'T') },
      lineup: lineup(...base.lineup.entries.filter((e) => e.kind !== 'individual' || e.swimmerId !== 'T')),
      tags: base.tags.filter((t) => t.swimmerId !== 'T'),
    };
    const load: Load = { schedule: schedule(timedFinal(E1), timedFinal(E2), timedFinal(E3), timedFinal(E4)), preference: { mode: 'prefer', maxRacesPerSession: set(2), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(25) } };
    const proposal = await built(fx, { load });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 'unlimited', load }));
    const s = unusual(proposal.explanations).find((x) => x.swimmerId === 'S') as Unusual;
    expect(s.eventKey).toBe(E1);
    expect(s.skipped).toEqual([{ eventKey: E2, placeAlone: 1, marginalPoints: 20, binding: 'load_penalty' }]);
    // A penalty below the gain takes the third race.
    const cheap: Load = { schedule: load.schedule, preference: { mode: 'prefer', maxRacesPerSession: set(2), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(5) } };
    const taken = await built(fx, { load: cheap });
    expect(taken.lineup.entries).toContainEqual(ind('A', 'S', E2));
  });

  it('19b theLoadPenaltyIsTheExtraCost: with a hand-built proposal that already pays a penalty, the new race is judged on its own extra cost', () => {
    // No T. The sessions allow one race and an extra race costs 15. The proposal swims S in E1 and E3: one extra race, 15 already paid. Adding E2 adds 20
    // points and costs 15 more, so it is worth taking: the skip is "search_limit" (max-own), not "load_penalty" (the solver would have taken it, so only a hand-built proposal is here).
    // A tie (cost 20 against 20 points) is "load_penalty": the entry is not worth it.
    const base = world({ maxInd: 'unlimited', sE3: one(3700), events: [E1, E2, E3], current: [ind('A', 'S', E1), ind('A', 'S', E3)] });
    const fx: Fx = {
      ...base,
      model: { ...base.model, swims: base.model.swims.filter((s) => s.swimmerId !== 'T') },
      lineup: lineup(...base.lineup.entries.filter((e) => e.kind !== 'individual' || e.swimmerId !== 'T')),
      tags: base.tags.filter((t) => t.swimmerId !== 'T'),
    };
    const sched = schedule(timedFinal(E1), timedFinal(E2), timedFinal(E3));
    Object.assign(lastRun, { maxOwn: true, status: 'proven_optimal' });
    const run = (cost: number): readonly AutoBuildExplanation[] => {
      const load: Load = { schedule: sched, preference: { mode: 'prefer', maxRacesPerSession: set(1), diving: set('excluded' as const), penaltyPointsPerExtraRace: set(cost) } };
      const problem = buildProblem(request(fx, { load }), { ...checkRules(fx.rules), load: loadRuleOf(load) }, scoreMeet(fx.model, fx.lineup, fx.tags, fx.rules, SOURCING));
      const entries = [...fx.lineup.entries.filter((e) => !(e.kind === 'individual' && e.teamId === 'A')), ind('A', 'S', E1), ind('A', 'S', E3)];
      const results = scoreMeet(fx.model, lineup(...entries), fx.tags, fx.rules, SOURCING);
      const ran = sessionLoad(fx.model, lineup(...entries), results, load.schedule, load.preference, fx.rules);
      const proposal: AutoBuildProposal = {
        lineup: lineup(...entries),
        rosterAdds: [],
        rosterRemoves: [],
        tagsForScoring: fx.tags,
        entryChanges: [],
        changeCount: 0,
        evaluation: { objective: ownTotal(results) - cost, ownPoints: ownTotal(results), rival: null, robustOwnPoints: null, penaltyPoints: cost, results, load: ran },
        explanations: [],
        newWarnings: [],
        method: 'mip',
      };
      const out = explain(problem, proposal, { status: 'proven_optimal', candidate: () => true });
      expect(out).toEqual(expected(fx, proposal, { maxInd: 'unlimited', load }));
      return out;
    };
    const skipped = (out: readonly AutoBuildExplanation[]): readonly Unusual["skipped"][number][] => unusual(out).flatMap((x) => x.skipped);
    expect(skipped(run(15)).map((s) => [s.eventKey, s.marginalPoints, s.binding])).toEqual([[E2, 20, 'search_limit']]);
    expect(skipped(run(20)).map((s) => [s.eventKey, s.marginalPoints, s.binding])).toEqual([[E2, 20, 'load_penalty']]);
    expect(skipped(run(25)).map((s) => [s.eventKey, s.marginalPoints, s.binding])).toEqual([[E2, 20, 'load_penalty']]);
  });

  it('21a bindingMarginTrap: in margin mode the event the solver passed over for the rival is blocked by the entry cap, which is a real limit', async () => {
    // The 12.6 trap. S swims the 100 free (1st alone, 20 points) or the 100 back (3rd, 16 points, but it takes 13 points from rival R). One entry only.
    const specs: Spec[] = [
      { id: 'S', team: 'A', swims: { [E1]: one(4700), [E2]: one(4700) } },
      ...['r1', 'r2'].map((id, i): Spec => ({ id, team: 'R', swims: { [E1]: one(4800 + i * 100) } })),
      ...Array.from({ length: 13 }, (_, k): Spec => ({ id: `rb${k + 1}`, team: 'R', swims: { [E2]: one(k + 1 <= 2 ? 4400 + (k + 1) * 100 : 4700 + (k + 1 - 2) * 100) } })),
    ];
    const rIds = specs.filter((s) => s.team === 'R').map((s) => s.id);
    const fx: Fx = {
      model: buildModel(specs, [E1, E2]),
      lineup: lineup(...specs.filter((s) => s.team === 'R').flatMap((s) => Object.keys(s.swims).map((e) => ind('R', s.id, e)))),
      tags: [...tags('A', ['S']), ...tags('R', rIds)],
      rules: rulesOf({ cap: 20, maxInd: 1 }),
    };
    const proposal = await built(fx, { objective: { kind: 'margin', rival: { kind: 'team', teamId: 'R' } } });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 1 }));
    const x = unusual(proposal.explanations).find((u) => u.swimmerId === 'S') as Unusual;
    expect(x.eventKey).toBe(E2);
    expect(x.skipped).toEqual([{ eventKey: E1, placeAlone: 1, marginalPoints: 20, binding: 'entry_cap' }]);
  });

  it('21b bindingObjectiveRobust: a volatile swimmer is kept off the event where a consistent teammate scores on the robust swims', async () => {
    // P is consistent in the 100 free (robust 43.20), Q is volatile there (best 40.00, robust 49.50). Per-event cap 1. Q swims the 100 back (2nd).
    // Robust mode enters P in the free: with Q beside him he adds nothing on the robust swims. On the normal seeds Q would take the free from P
    // (3 more own points), so the teammates are not why he is skipped: the robust objective is.
    const series = (id: string, times: readonly number[], eventKey: string): readonly SwimSpec[] => times.map((time, i) => ({ time, id: `${id}:${eventKey}:${i}` }));
    const specs: Spec[] = [
      { id: 'P', team: 'A', swims: { [E1]: series('P', [4300, 4310, 4320, 4330, 4340], E1) } },
      { id: 'Q', team: 'A', swims: { [E1]: series('Q', [4000, 4900, 5100, 4950, 5000], E1), [E2]: series('Q', [4400, 4400, 4410, 4390, 4400], E2) } },
      { id: 'R1', team: 'B', swims: { [E1]: one(4100) } },
      { id: 'R2', team: 'D', swims: { [E2]: one(4600) } },
      { id: 'R3', team: 'C', swims: { [E2]: one(4300) } },
    ];
    const model = buildModel(specs, [E1, E2]);
    const dated = model.swims.map((s, i) => (s.swimmerId === 'P' || s.swimmerId === 'Q' ? { ...s, date: `2026-03-${String(10 + (i % 5)).padStart(2, '0')}`, seasonId: '2025-26' } : s));
    const fx: Fx = {
      model: { ...model, swims: dated, recordRange: { kind: 'dates', from: '2025-09-01', to: '2026-06-30' } },
      lineup: lineup(ind('B', 'R1', E1), ind('D', 'R2', E2), ind('C', 'R3', E2)),
      tags: [...tags('A', ['P', 'Q']), ...tags('B', ['R1']), ...tags('D', ['R2']), ...tags('C', ['R3'])],
      rules: rulesOf({ maxInd: 2 }),
    };
    const proposal = await built(fx, { objective: { kind: 'robust', recentSwims: 5, minSwims: 3 } });
    // `objective` needs a proven optimum and a pair in the candidate columns: both hold here.
    expect(lastRun).toEqual({ maxOwn: false, status: 'proven_optimal' });
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2 }));
    const x = unusual(proposal.explanations).find((u) => u.swimmerId === 'Q') as Unusual;
    expect(x.eventKey).toBe(E2);
    expect(x.skipped).toEqual([{ eventKey: E1, placeAlone: 1, marginalPoints: 3, binding: 'objective' }]);
    // The same world with a solver that times out: the local search keeps the proof short of proven, so the same skip is the search and not the objective.
    const timesOut: MipSolve = async () => ({ status: 'Time limit reached', objective: 0, columns: {}, incumbent: null, dualBound: null });
    const slow = await run(request(fx, { objective: { kind: 'robust', recentSwims: 5, minSwims: 3 } }), timesOut);
    expect(slow.kind).toBe('improved');
    if (slow.kind !== 'improved') return;
    expect(lastRun.status).not.toBe('proven_optimal');
    expect(slow.proposal.explanations).toEqual(expected(fx, slow.proposal, { maxInd: 2 }));
    const y = unusual(slow.proposal.explanations).find((u) => u.swimmerId === 'Q') as Unusual;
    expect(y.skipped.map((s) => [s.eventKey, s.binding])).toEqual([[E1, 'search_limit']]);
  });

  it('21d bindingSearchLimitFrozenPair: in robust mode a pair with too few dated swims is never entered, so its skip is "search_limit"', async () => {
    // The world of 21b, but Q has two dated swims in the 100 free (minSwims is 3): the pair is frozen. On the normal seeds he would still beat P there.
    const series = (id: string, times: readonly number[], eventKey: string): readonly SwimSpec[] => times.map((time, i) => ({ time, id: `${id}:${eventKey}:${i}` }));
    const specs: Spec[] = [
      { id: 'P', team: 'A', swims: { [E1]: series('P', [4300, 4310, 4320, 4330, 4340], E1) } },
      { id: 'Q', team: 'A', swims: { [E1]: series('Q', [4000, 4900], E1), [E2]: series('Q', [4400, 4400, 4410, 4390, 4400], E2) } },
      { id: 'R1', team: 'B', swims: { [E1]: one(4100) } },
      { id: 'R2', team: 'D', swims: { [E2]: one(4600) } },
      { id: 'R3', team: 'C', swims: { [E2]: one(4300) } },
    ];
    const model = buildModel(specs, [E1, E2]);
    const dated = model.swims.map((s, i) => (s.swimmerId === 'P' || s.swimmerId === 'Q' ? { ...s, date: `2026-03-${String(10 + (i % 5)).padStart(2, '0')}`, seasonId: '2025-26' } : s));
    const fx: Fx = {
      model: { ...model, swims: dated, recordRange: { kind: 'dates', from: '2025-09-01', to: '2026-06-30' } },
      lineup: lineup(ind('B', 'R1', E1), ind('D', 'R2', E2), ind('C', 'R3', E2)),
      tags: [...tags('A', ['P', 'Q']), ...tags('B', ['R1']), ...tags('D', ['R2']), ...tags('C', ['R3'])],
      rules: rulesOf({ maxInd: 2 }),
    };
    const proposal = await built(fx, { objective: { kind: 'robust', recentSwims: 5, minSwims: 3 } });
    expect(lastRun.status).toBe('proven_optimal');
    expect(proposal.explanations).toEqual(expected(fx, proposal, { maxInd: 2, outside: ['Q|' + E1] }));
    const x = unusual(proposal.explanations).find((u) => u.swimmerId === 'Q') as Unusual;
    expect(x.skipped).toEqual([{ eventKey: E1, placeAlone: 1, marginalPoints: 3, binding: 'search_limit' }]);
  });

  it('21c bindingObjectiveGoalSeek: a goal seek keeps the entry it has and skips a better event that would cost a change', async () => {
    // S is in the 100 fly now (3rd, 16 points). His 100 free is 2nd (17 points), so it ranks above the fly. The target needs W's 20 points
    // from a fourth event: S's free alone (17) would not reach it, and the goal seek spends its one change on W.
    const base = world({
      maxInd: 2,
      sE3: one(4400),
      sMore: { [E1]: one(4450) },
      extra: [
        { id: 'W', team: 'A', swims: { [E4]: one(3700) } },
        { id: 'R8', team: 'I', swims: { [E4]: one(4500) } },
      ],
      extraTags: [...tags('A', ['W']), ...tags('I', ['R8'])],
      events: [E1, E2, E3, E4],
      current: [ind('A', 'S', E3), ind('I', 'R8', E4)],
    });
    const now = ownTotal(scoreMeet(base.model, base.lineup, base.tags, base.rules, SOURCING));
    const objective = { kind: 'goal-seek' as const, target: { kind: 'total' as const, points: now + 20 } };
    const proposal = await built(base, { objective });
    expect(lastRun).toEqual({ maxOwn: false, status: 'proven_optimal' });
    expect(proposal.explanations).toEqual(expected(base, proposal, { maxInd: 2 }));
    const x = unusual(proposal.explanations).find((u) => u.swimmerId === 'S') as Unusual;
    expect(x.eventKey).toBe(E3);
    expect(x.skipped).toEqual([
      { eventKey: E2, placeAlone: 1, marginalPoints: 0, binding: 'teammates' },
      { eventKey: E1, placeAlone: 2, marginalPoints: 17, binding: 'objective' },
    ]);
    // The same proposal read with what the search knew: a proof that is not proven, or a pair outside the candidate columns, is the search and not the objective.
    const problem = buildProblem(request(base, { objective }), { ...checkRules(base.rules), load: loadRuleOf(null) }, scoreMeet(base.model, base.lineup, base.tags, base.rules, SOURCING));
    const read = (status: 'proven_optimal' | 'gap' | 'unknown', candidate: (e: MeetEvent, id: string) => boolean): string[][] =>
      (unusual(explain(problem, proposal, { status, candidate })).find((u) => u.swimmerId === 'S') as Unusual).skipped.map((s) => [s.eventKey, s.binding]);
    const all = (): boolean => true;
    expect(read('proven_optimal', all)).toEqual([[E2, 'teammates'], [E1, 'objective']]);
    expect(read('gap', all)).toEqual([[E2, 'teammates'], [E1, 'search_limit']]);
    expect(read('unknown', all)).toEqual([[E2, 'teammates'], [E1, 'search_limit']]);
    expect(read('proven_optimal', (e, id) => !(id === 'S' && e.eventKey === E1))).toEqual([[E2, 'teammates'], [E1, 'search_limit']]);
  });

  it('20 explainMs: theexplanation time is a number with a request clock and null without one', async () => {
    const fx = world();
    const without = await autoBuild(request(fx), nodeMipSolve());
    expect(without.kind === 'improved' && without.proof.timings.explainMs).toBeNull();
    let now = 0;
    const stepping = await autoBuild(request(fx, { clock: () => (now += 1) }), nodeMipSolve());
    // The clock moves one step per read and explain reads it twice, so the span is one step.
    expect(stepping.kind === 'improved' && stepping.proof.timings.explainMs).toBe(1);
    const real = await autoBuild(request(fx, { clock: () => performance.now() }), nodeMipSolve());
    expect(real.kind === 'improved' && (real.proof.timings.explainMs as number) >= 0).toBe(true);
  });
});
