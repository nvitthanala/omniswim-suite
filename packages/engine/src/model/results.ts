/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Results and `scoreMeet` (plans/2026-10-25/D2-ENGINE-API.md, 3.8), P2.
 *
 * `scoreMeet` ranks each event's field from the lineup's seed times, hands the rows to the legacy
 * scorer (`calculatePoints`) through `toLegacyScoringSettings`, and folds the points back into a
 * `Results`. It adds no scoring rule of its own.
 *
 * ## Synthetic legacy keys
 * The legacy scorer keys swimmers by name and teams by team name (`scorerRosterKey`,
 * `overCapRowIds`, `relayEntryLegSignature`). Display names can collide: two swimmers called
 * "Alex Kim" on one team would merge into one athlete. Every legacy row therefore carries
 * `sw:<swimmerId>` as its name and `tm:<teamId>` as its team. `scoreMeet` refuses two ids that
 * normalize to the same key.
 *
 * ## Ranking
 * The field is ranked by hundredths (a dive by score, descending), then by `scoring.ties`:
 * - `'split'`: equal values share a rank (standard competition ranking), and the legacy scorer
 *   splits the places of a tie group between the tied entries (`tiedPlaceShare`).
 * - `'ordered'`: every entry takes its own place, and a tie is broken by lineup order (a stable
 *   sort). No points are split. This is SwimCloud's rule: its event sort is a stable `orderBy`, and
 *   places come from position (plans/2026-10-25/02-SIMULATOR-RECON.md, "P2: how the simulator ranks ties").
 * The rows the legacy scorer receives always carry the ranks chosen here.
 *
 * ## Tags
 * A tag throws under `'points_pool'`: the legacy scorer ignores a tag there, and a silent ignore
 * would be a plausible, wrong lineup. Under `'roster'` the tags are the scoring roster (next section).
 *
 * ## Roster eligibility (P3.core-b; README R9, R24, R28, R37, R41, R65, R70 to R72)
 * Under `scorers.eligibility: 'roster'` the scoring roster of a team is the swimmers the coach tagged
 * `'scorer'`, and nobody else (R65). Swimming a relay does not add an untagged swimmer (R71). The
 * `autoRules` marks (an A or B final, a relay leg, a split timed final) are not evaluated. That follows R71
 * and the model: a lineup has no rounds, so no entry can show a swimmer made an A final. It is not a skipped
 * rule. `scoreMeet` scores every entry as one timed final (D2 section 9, P3.core-b item 7).
 * - A team and gender with entries and no `'scorer'` tag is refused (`scoring_roster_missing`), never scored as
 *   zeros (R65). The opponents' rosters come from the caller (R70).
 * - A tag for an unknown team or swimmer, a swimmer of another team, a swimmer who is not on the roster, and two
 *   roles for one swimmer each throw.
 * - `'exhibition'` role: the swimmer's swims leave the places (NCAA Rule 7-10-1, R72) with reason
 *   `'exhibition'`. A relay with an exhibition leg is an exhibition relay.
 * - Every other entry of an untagged or `'non-scorer'` swimmer is a non-scorer entry, and so is a relay with a leg
 *   off the scoring roster when `scorers.relayLegsMustBeScorers` is true (R37). `scoring.nonScorerPlacement`
 *   decides (R41, and the same rule for relays):
 *   - `'removed-from-consideration'`: the entry leaves the places, like an exhibition entry, and the entries behind
 *     it move up. Reason `'non_scorer'`, `place: null`.
 *   - `'holds-place'`: the entry keeps its place, scores 0, and takes its share of a tie. Reason `'non_scorer'`.
 *   A non-scorer entry takes no per-event scorer slot and no scoring-relay slot.
 * - The per-event caps and the relay limit run on the field without the exhibition entries and the removed
 *   non-scorers.
 * - Scoring-team size (`scorers.scoringTeamSize`, R24): per team and gender, every tagged scorer takes a full spot,
 *   except a swimmer whose only entries are diving, who takes `scorers.diverWeight` of one. A relay swimmer takes a
 *   full spot (R28). An over-size roster adds a `scoring_team_size` violation and is scored as tagged: it is never
 *   trimmed and the engine never picks who drops.
 * - Entry limits count every entry, as under `'points_pool'`: scorer, non-scorer and exhibition alike, including the legs of an
 *   exhibition relay and of a relay removed by `scorers.relayOverCap` (README R75, which corrects R74). The roster only
 *   decides who scores and who may swim a scoring relay. That is `entries.exhibitionCounts: true`, the NSISC value. A
 *   preset that sets it to false leaves every row with `notScoredReason: 'exhibition'` out of the entry limits, in
 *   either eligibility mode (NCAA Rule 5-5-1, README R72).
 * The legacy scorer only awards the table points here. `scoreMeet` hands it a copy of the preset with the roster
 * gate, the team pool and every cap switched off (`pointsOnlyRules`), because it would build its own roster from
 * the rows it sees. `scoreMeet` zeroes the held entries itself, after the tie shares are split.
 *
 * ## Over-cap entries
 * A per-team per-event scorer cap (`scorers.perEventScorerCap`, and `divingPerEventScorerCap` when it has
 * its own rule) has an over-cap rule:
 * - `'holds-place'`: the over-cap entry keeps its place and scores 0 (`notScoredReason` `event_scorer_cap`).
 *   Nobody behind it moves up.
 * - `'removed-from-consideration'`: the over-cap entry leaves the places, as an exhibition swimmer does
 *   (`ncaaScoringRules.ts` re-runs without it; `rankAsIfExhibitionAbsent`). The cap is applied to the ranks of
 *   the full field, in place order, as under `'holds-place'`. The field is then ranked again without the
 *   removed entries, under the same `scoring.ties` rule, and only the rest reach the legacy scorer. In a
 *   `'split'` tie group the removed entry leaves the group: its tie-mates share one place fewer. A removed
 *   entry stays in `Results` with `place: null`, `points: 0`, `scored: false` and `notScoredReason:
 *   'removed_over_event_cap'`. That reason tells it apart from `no_time` (also `place: null`) and from a placed
 *   entry that earned 0.
 * - A relay over `scorers.scoringRelaysPerTeamPerEvent` has its own rule, `scorers.relayOverCap` (README R67).
 *   Which relays are over the limit is the same under both values: the cap is applied to the ranks of the full
 *   field, in place order, and a relay ranked past the point table takes no cap slot (relayScoring.ts).
 *   - `'holds-place'`: the relay keeps its place and scores 0 (`notScoredReason` `relay_scorer_cap`). Nobody
 *     behind it moves up. This is SwimCloud's rule.
 *   - `'exhibition'`: the relay leaves the places like an exhibition entry. It goes through the same removal as a
 *     removed individual entry: the field is ranked again without it, under the same `scoring.ties` rule, and
 *     the relays behind it move up. The row stays in `Results` with `place: null`, `points: 0`, `scored: false`
 *     and `notScoredReason: 'exhibition'`.
 *   A relay ranked past the point table in the full field takes no cap slot, so it is not chosen even when the
 *   removal moves it into the table. That is a known gap (D2 section 9, P3.relay-overcap).
 * - A relay leg of kind `flyover-estimate` throws (P4).
 *
 * A flat-start swim on leg 2 to 4 scores, with a `basis_position` violation. SwimCloud's aggregate free
 * relay does exactly this: it reorders the legs after it picks them, so a flat-start time can sit on
 * a flying leg (D2 8.12). The violation says so, and the points stay SwimCloud's.
 * - A relay split outside SCY throws: the split conversion statement is P4.
 *
 * Every row is scored as an `A Final`, so the legacy place index equals `rank - 1`. This is a label
 * for the legacy scorer, not a statement about how the meet was swum.
 */
import { Gender as LegacyGender } from '../types';
import type { SwimmerResult } from '../types';
import { calculatePoints } from '../lib/calculatePoints';
import { normalizeEventForCutline } from '../lib/cutlineEventNames';
import { normalizeSwimmerName } from '../lib/swimmerNames';
import { capAllows } from '../rules/cap';
import type { Cap } from '../rules/cap';
import { RulePresetError } from '../rules/cap';
import { toLegacyScoringSettings } from '../rules/legacyBridge';
import type { CompleteRulePreset, DivingPerEventScorerCap, EngineScorerAutoRules, PerEventScorerCap, TieRule } from '../rules/rulePreset';
import type { ConversionSettings } from '../sourcing/convert';
import type { SessionRef } from '../planner/types';
import { formatHundredths } from './primitives';
import type { EventKey, Gender, Hundredths, SwimmerId, TeamId } from './primitives';
import type { Setting } from './provenance';
import type { Lineup, LineupDisplay, LineupEntry, RelayEntry, ScorerRole, ScorerTag } from './lineup';
import { entryKey } from './lineup';
import type { MeetEvent, MeetModel, MeetSwim, MeetSwimmer, RelaySplit } from './meet';

export type NotScoredReason =
  /**
   * Roster eligibility: the entry is a non-scorer entry (README R41): its swimmer is untagged or tagged `'non-scorer'`,
   * or a relay has a leg off the scoring roster (R37). Under `nonScorerPlacement: 'removed-from-consideration'` the
   * entry left the places (`place` is `null`). Under `'holds-place'` it keeps its place and earns 0.
   */
  | 'non_scorer'
  | 'scoring_team_full'
  | 'event_scorer_cap'
  | 'relay_scorer_cap'
  /**
   * The entry was over its team's per-event scorer cap under an over-cap rule of
   * `'removed-from-consideration'`, so it left the places (`place` is `null`) and the entries behind it
   * moved up. A placed entry that earned 0 never carries this reason.
   */
  | 'removed_over_event_cap'
  /**
   * The entry left the places (`place` is `null`) and the entries behind it moved up, as an exhibition entry does:
   * a relay over `scorers.scoringRelaysPerTeamPerEvent` under `scorers.relayOverCap: 'exhibition'` (README R67), or,
   * under roster eligibility, an entry of a swimmer tagged `'exhibition'` or a relay with such a leg (Rule 7-10-1, R72).
   */
  | 'exhibition'
  | 'outside_point_table'
  | 'no_time'
  | 'time_trial';

export interface ResultRow {
  readonly entryKey: string;
  readonly teamId: TeamId;
  /** `null` for a relay entry. */
  readonly swimmerId: SwimmerId | null;
  /**
   * The rank in the field, or `null` when the entry has no place: it has no time (`notScoredReason`
   * `'no_time'`), or it was removed from the places (`'removed_over_event_cap'`, or `'exhibition'` for a relay). A removed entry is
   * not in the ranking, so the places of the rest are numbered without it. `notScoredReason` says
   * which `null` it is.
   */
  readonly place: number | null;
  readonly points: number;
  /** `points > 0`. */
  readonly scored: boolean;
  /** Absent when the entry scored, or when the reason is not derived. Never guessed. */
  readonly notScoredReason?: NotScoredReason;
}

export type Violation =
  | {
      readonly kind: 'entry_cap';
      readonly swimmerId: SwimmerId;
      readonly which: 'individual' | 'relay' | 'total';
      readonly count: number;
      readonly limit: number;
    }
  | {
      readonly kind: 'session_load';
      readonly swimmerId: SwimmerId;
      readonly session: SessionRef;
      readonly races: number;
      readonly limit: number;
    }
  | {
      readonly kind: 'relay_leg';
      readonly entryKey: string;
      readonly leg: 1 | 2 | 3 | 4;
      /**
       * `off_scoring_roster` (README R77) is a warning: under roster eligibility with `scorers.relayLegsMustBeScorers`
       * false, the relay stays on the scoring roster although this leg is not tagged a scorer. A relay that
       * `scorers.relayOverCap: 'exhibition'` removes does not score and gets no such warning.
       */
      readonly reason: 'wrong_gender' | 'duplicate_swimmer' | 'event_mismatch' | 'basis_position' | 'off_scoring_roster';
    }
  /**
   * Roster eligibility, a warning (README R78): a swimmer tagged a scorer has no entry in the meet. The swimmer still
   * takes a full scoring-roster spot, because no entry shows whether the swimmer is a diver.
   */
  | {
      readonly kind: 'scorer_without_entry';
      readonly teamId: TeamId;
      readonly gender: Gender;
      readonly swimmerId: SwimmerId;
    }
  /**
   * `entries.relaySwimmerOncePerEvent` is `true` (NCAA Rule 5-7-1-g, README R72): a swimmer is on more than one of a team's
   * relay entries in one event. `entryKeys` lists those relays in lineup order. The relays still score as entered.
   * The model has no rounds, so every relay counts as a timed-final relay. Two legs of one relay are `relay_leg`
   * `duplicate_swimmer`, not this.
   */
  | {
      readonly kind: 'relay_swimmer_repeated';
      readonly teamId: TeamId;
      readonly swimmerId: SwimmerId;
      readonly eventKey: EventKey;
      readonly gender: Gender;
      readonly entryKeys: readonly string[];
    }
  /**
   * `entries.nonScoringRelaysAllowed` is `false` (README R42, NSISC): a team has more relay entries in one event than
   * `scorers.scoringRelaysPerTeamPerEvent`. One violation per team, event and gender. `entryKeys` lists every relay of
   * the team in that event in lineup order, so nothing picks which one is "the 3rd". `count` is more than `limit`. How
   * the extra relays score is `scorers.relayOverCap`, and is not changed.
   */
  | {
      readonly kind: 'relay_entries_over_limit';
      readonly teamId: TeamId;
      readonly eventKey: EventKey;
      readonly gender: Gender;
      readonly entryKeys: readonly string[];
      readonly count: number;
      readonly limit: number;
    }
  /**
   * Roster eligibility: a team's tagged scorers take more than `scorers.scoringTeamSize` spots. The roster is scored as
   * tagged. `scorers` are the tagged swimmers who take a full spot, `divers` those who take `scorers.diverWeight` of
   * one. `spots` is `scorers + divers * diverWeight` as an exact fraction (not reduced). It is more than `limit`.
   */
  | {
      readonly kind: 'scoring_team_size';
      readonly teamId: TeamId;
      readonly gender: Gender;
      readonly scorers: number;
      readonly divers: number;
      readonly spots: { readonly numerator: number; readonly denominator: number };
      readonly limit: number;
    }
  | { readonly kind: 'unscheduled_event'; readonly eventKey: EventKey; readonly gender: Gender }
  | {
      readonly kind: 'pending_setting';
      readonly eventKey: EventKey;
      readonly gender: Gender;
      readonly setting: 'fastHeatSize' | 'smallFieldSession' | 'cFinal' | 'abFinalsScorersOnly' | 'individualPoints' | 'relayPoints' | 'diving';
    }
  | { readonly kind: 'seed_time_missing'; readonly entryKey: string; readonly eventKey: EventKey; readonly gender: Gender };

export interface Results {
  readonly payloadVersion: 1;
  /** Every team of the model, best first. A tie shares a rank. */
  readonly teams: readonly { readonly teamId: TeamId; readonly points: number; readonly rank: number }[];
  /** The events that have a lineup entry, in model order. Rows are in place order. */
  readonly events: readonly { readonly eventKey: EventKey; readonly gender: Gender; readonly rows: readonly ResultRow[] }[];
  readonly violations: readonly Violation[];
  /** Entered swimmers whose roster membership is `unknown`, sorted. */
  readonly rosterUnknown: readonly SwimmerId[];
  /** `scoreMeet` never sets this. A caller may attach names and times, and `stripResultsDisplay` removes them. */
  readonly display?: LineupDisplay;
}

export type ScoreMeetErrorCode =
  | 'meet_key_mismatch'
  /** No longer thrown (P3.core-b scores `'roster'`). It stays so existing callers still compile. */
  | 'roster_mode_unsupported'
  | 'tags_need_roster_mode'
  /** Roster eligibility: a team and gender with entries and no scorer tag. `teamIds` and `missingRosters` name them. */
  | 'scoring_roster_missing'
  /** Roster eligibility: one swimmer tagged with two different roles. */
  | 'duplicate_tag'
  /** Roster eligibility with a numeric `scoringTeamSize` and `scoringTeamScope: 'event'`: no source says what that means. */
  | 'team_size_scope_unsupported'
  | 'placement_unsupported'
  | 'name_collision'
  | 'unresolved_team'
  | 'unresolved_swimmer'
  | 'unresolved_event'
  | 'unresolved_swim'
  | 'unresolved_split'
  | 'team_mismatch'
  | 'gender_mismatch'
  | 'event_kind_mismatch'
  | 'roster_not_member'
  | 'duplicate_entry'
  | 'seed_mismatch'
  | 'leg_basis_unsupported'
  | 'leg_missing'
  | 'split_not_scy';

export class ScoreMeetError extends Error {
  readonly code: ScoreMeetErrorCode;
  /** The entry key or id the error is about, when it has one. */
  readonly subject: string | null;
  /** `scoring_roster_missing` only: the team ids with entries and no scorer tag, sorted. Empty for every other code. */
  readonly teamIds: readonly TeamId[];
  /** `scoring_roster_missing` only: each team and gender with entries and no scorer tag, sorted. Empty for every other code. */
  readonly missingRosters: readonly { readonly teamId: TeamId; readonly gender: Gender }[];

  constructor(
    code: ScoreMeetErrorCode,
    message: string,
    subject: string | null = null,
    missingRosters: readonly { readonly teamId: TeamId; readonly gender: Gender }[] = []
  ) {
    super(message);
    this.name = 'ScoreMeetError';
    this.code = code;
    this.subject = subject;
    this.missingRosters = missingRosters;
    this.teamIds = [...new Set(missingRosters.map((m) => m.teamId))].sort();
  }
}

const fail = (code: ScoreMeetErrorCode, message: string, subject: string | null = null): never => {
  throw new ScoreMeetError(code, message, subject);
};

/** The value of a setting a complete preset must hold. */
export function settled<T>(setting: Setting<T>, path: string): T {
  if (setting.state !== 'set') {
    throw new RulePresetError(path, 'pending', `${path}: pending; scoreMeet needs a complete preset`);
  }
  return setting.value;
}

/* -------------------------------------------------------------------------- */
/* Entry resolution                                                           */
/* -------------------------------------------------------------------------- */

interface Resolved {
  readonly entry: LineupEntry;
  readonly key: string;
  readonly event: MeetEvent;
  readonly gender: Gender;
  /** One id for an individual, the four leg ids for a relay. */
  readonly swimmerIds: readonly SwimmerId[];
  /** The seed value: hundredths of a second, or of a point for a dive. `null`: no time. */
  readonly value: Hundredths | null;
}

interface Index {
  readonly teams: ReadonlySet<TeamId>;
  readonly swimmers: ReadonlyMap<SwimmerId, MeetSwimmer>;
  readonly events: ReadonlyMap<string, MeetEvent>;
  readonly swims: ReadonlyMap<string, MeetSwim>;
  readonly swimsByKey: ReadonlyMap<string, readonly MeetSwim[]>;
  readonly splits: ReadonlyMap<string, RelaySplit>;
}

const eventId = (eventKey: EventKey, gender: Gender): string => `${gender}\u0000${eventKey}`;
const seedKey = (swimmerId: SwimmerId, eventKey: EventKey): string => `${swimmerId}\u0000${eventKey}`;

export function buildIndex(model: MeetModel): Index {
  const swimsByKey = new Map<string, MeetSwim[]>();
  for (const swim of model.swims) {
    const k = seedKey(swim.swimmerId, swim.eventKey);
    const bucket = swimsByKey.get(k);
    if (bucket) bucket.push(swim);
    else swimsByKey.set(k, [swim]);
  }
  return {
    teams: new Set(model.teams.map((t) => t.teamId)),
    swimmers: new Map(model.swimmers.map((s) => [s.swimmerId, s])),
    events: new Map(model.events.map((e) => [eventId(e.eventKey, e.gender), e])),
    swims: new Map(model.swims.map((s) => [s.swimId, s])),
    swimsByKey,
    splits: new Map(model.relaySplits.map((s) => [s.splitId, s])),
  };
}

/** The SCY value a swim states: hundredths, or `null` when the swim has no usable time. */
function scyValue(swim: MeetSwim): Hundredths | null {
  switch (swim.scy.kind) {
    case 'recorded-scy':
      return swim.recordedTime === null ? null : swim.recordedTime.hundredths;
    case 'converted':
      return swim.scy.hundredths;
    case 'not-convertible':
      return null;
  }
}

/** A swim the engine may pick without being told: not an extracted split, a typed-in time or an unconfirmed program swim (invariant 8). */
const isRankable = (swim: MeetSwim): boolean =>
  swim.flags.extractedSplit !== true && swim.flags.userInputted !== true && swim.flags.programUnconfirmed !== true;

function individualValue(entry: Extract<LineupEntry, { kind: 'individual' }>, key: string, event: MeetEvent, index: Index): Hundredths | null {
  if (entry.seedSwimId !== null) {
    const swim = index.swims.get(entry.seedSwimId);
    if (!swim) return fail('unresolved_swim', `${key}: seed swim "${entry.seedSwimId}" is not in the model`, key);
    // A pinned swim is used as stated, even a relay leadoff the model flags as an extracted split:
    // the lineup, not the engine, chose it. Only a swim of another swimmer or event is refused.
    if (swim.swimmerId !== entry.swimmerId || swim.eventKey !== entry.eventKey) {
      return fail('seed_mismatch', `${key}: seed swim "${swim.swimId}" belongs to ${swim.swimmerId} in ${swim.eventKey}`, key);
    }
    return scyValue(swim);
  }
  const candidates = (index.swimsByKey.get(seedKey(entry.swimmerId, entry.eventKey)) ?? []).filter(isRankable);
  let best: Hundredths | null = null;
  for (const swim of candidates) {
    const v = scyValue(swim);
    if (v === null) continue;
    // A dive scores higher-is-better; a time, lower-is-better.
    if (best === null || (event.kind === 'diving' ? v > best : v < best)) best = v;
  }
  return best;
}

/** Leg event keys a relay expects, in leg order: a medley relay swims back, breast, fly, free; a free relay, free. */
function expectedLegEvents(event: MeetEvent): readonly EventKey[] | null {
  if (event.distanceYards === null || event.distanceYards % 4 !== 0) return null;
  const legDistance = event.distanceYards / 4;
  const strokes = event.relayKind === 'medley' ? ['Backstroke', 'Breaststroke', 'Butterfly', 'Freestyle'] : ['Freestyle', 'Freestyle', 'Freestyle', 'Freestyle'];
  return strokes.map((stroke) => normalizeEventForCutline(`${legDistance} ${stroke}`));
}

interface LegRead {
  readonly value: Hundredths | null;
  readonly eventKey: EventKey | null;
  /** A flat-start swim on leg 2 to 4: legal in SwimCloud's aggregate relay, not on a real relay. */
  readonly offPosition?: true;
}

function readLeg(entry: RelayEntry, position: number, key: string, index: Index): LegRead {
  const leg = entry.legs[position];
  if (!leg) return fail('leg_missing', `${key}: leg ${position + 1} is missing`, key);
  const basis = leg.basis;
  switch (basis.kind) {
    case 'no-time':
      return { value: null, eventKey: null };
    case 'flyover-estimate':
      return fail('leg_basis_unsupported', `${key}: leg ${position + 1} uses a flyover estimate (P4)`, key);
    case 'flat-start-swim': {
      const swim = index.swims.get(basis.swimId);
      if (!swim) return fail('unresolved_swim', `${key}: leg ${position + 1} swim "${basis.swimId}" is not in the model`, key);
      if (swim.swimmerId !== leg.swimmerId) {
        return fail('seed_mismatch', `${key}: leg ${position + 1} swim "${swim.swimId}" belongs to ${swim.swimmerId}, not ${leg.swimmerId}`, key);
      }
      return { value: scyValue(swim), eventKey: swim.eventKey, ...(position === 0 ? {} : { offPosition: true as const }) };
    }
    case 'split': {
      const split = index.splits.get(basis.splitId);
      if (!split) return fail('unresolved_split', `${key}: leg ${position + 1} split "${basis.splitId}" is not in the model`, key);
      if (split.swimmerId !== leg.swimmerId) {
        return fail('seed_mismatch', `${key}: leg ${position + 1} split "${split.splitId}" belongs to ${split.swimmerId}, not ${leg.swimmerId}`, key);
      }
      if (split.course !== 'SCY') {
        return fail('split_not_scy', `${key}: leg ${position + 1} split "${split.splitId}" is ${split.course ?? 'of unknown course'}; converting splits arrives in P4`, key);
      }
      return { value: split.split.hundredths, eventKey: split.legEventKey };
    }
  }
}

interface Resolution {
  readonly resolved: readonly Resolved[];
  readonly violations: Violation[];
  readonly rosterUnknown: readonly SwimmerId[];
}

export function resolveLineup(model: MeetModel, lineup: Lineup, index: Index): Resolution {
  const resolved: Resolved[] = [];
  const violations: Violation[] = [];
  const seen = new Set<string>();
  const unknown = new Set<SwimmerId>();

  const member = (swimmerId: SwimmerId, teamId: TeamId, key: string): MeetSwimmer => {
    const swimmer = index.swimmers.get(swimmerId);
    if (!swimmer) return fail('unresolved_swimmer', `${key}: swimmer "${swimmerId}" is not in the model`, key);
    if (swimmer.teamId !== teamId) return fail('team_mismatch', `${key}: swimmer "${swimmerId}" is on team ${swimmer.teamId}, not ${teamId}`, key);
    if (swimmer.roster === 'not_member') return fail('roster_not_member', `${key}: swimmer "${swimmerId}" is not on the roster`, key);
    if (swimmer.roster === 'unknown') unknown.add(swimmerId);
    return swimmer;
  };

  for (const entry of lineup.entries) {
    const key = entryKey(entry);
    if (seen.has(key)) fail('duplicate_entry', `${key}: the lineup lists this entry twice`, key);
    seen.add(key);
    if (!index.teams.has(entry.teamId)) fail('unresolved_team', `${key}: team "${entry.teamId}" is not in the model`, key);
    const event = index.events.get(eventId(entry.eventKey, entry.gender));
    if (!event) fail('unresolved_event', `${key}: ${entry.gender} event "${entry.eventKey}" is not in the model`, key);
    const ev = event as MeetEvent;

    if (entry.kind === 'individual') {
      if (ev.kind === 'relay') fail('event_kind_mismatch', `${key}: "${entry.eventKey}" is a relay, not an individual event`, key);
      const swimmer = member(entry.swimmerId, entry.teamId, key);
      if (swimmer.gender !== entry.gender) fail('gender_mismatch', `${key}: ${swimmer.gender} swimmer in a ${entry.gender} entry`, key);
      resolved.push({ entry, key, event: ev, gender: entry.gender, swimmerIds: [entry.swimmerId], value: individualValue(entry, key, ev, index) });
      continue;
    }

    if (ev.kind !== 'relay') fail('event_kind_mismatch', `${key}: "${entry.eventKey}" is not a relay`, key);
    const expected = expectedLegEvents(ev);
    const legs: LegRead[] = [];
    const legSwimmers: SwimmerId[] = [];
    entry.legs.forEach((leg, i) => {
      const swimmer = member(leg.swimmerId, entry.teamId, key);
      const position = (i + 1) as 1 | 2 | 3 | 4;
      if (swimmer.gender !== entry.gender) violations.push({ kind: 'relay_leg', entryKey: key, leg: position, reason: 'wrong_gender' });
      if (legSwimmers.includes(leg.swimmerId)) violations.push({ kind: 'relay_leg', entryKey: key, leg: position, reason: 'duplicate_swimmer' });
      legSwimmers.push(leg.swimmerId);
      const read = readLeg(entry, i, key, index);
      legs.push(read);
      if (read.offPosition) violations.push({ kind: 'relay_leg', entryKey: key, leg: position, reason: 'basis_position' });
      // An unverifiable leg event (null) is flagged, not trusted: the leg may be a different stroke.
      if (read.value !== null && (expected === null || read.eventKey !== expected[i])) {
        violations.push({ kind: 'relay_leg', entryKey: key, leg: position, reason: 'event_mismatch' });
      }
    });
    const timed = legs.every((l) => l.value !== null);
    const total = timed ? legs.reduce((sum, l) => sum + (l.value as number), 0) : null;
    resolved.push({ entry, key, event: ev, gender: entry.gender, swimmerIds: legSwimmers, value: total });
  }

  return { resolved, violations, rosterUnknown: [...unknown].sort() };
}

/* -------------------------------------------------------------------------- */
/* Entry caps                                                                 */
/* -------------------------------------------------------------------------- */

function entryCapViolations(
  resolved: readonly Resolved[],
  caps: { individual: Cap; relay: Cap; total: Cap }
): Violation[] {
  const individual = new Map<SwimmerId, Set<string>>();
  const relay = new Map<SwimmerId, Set<string>>();
  for (const r of resolved) {
    for (const id of r.swimmerIds) {
      const bucket = r.entry.kind === 'individual' ? individual : relay;
      const set = bucket.get(id);
      if (set) set.add(r.key);
      else bucket.set(id, new Set([r.key]));
    }
  }
  const out: Violation[] = [];
  const ids = [...new Set([...individual.keys(), ...relay.keys()])].sort();
  for (const swimmerId of ids) {
    const ind = individual.get(swimmerId)?.size ?? 0;
    const rel = relay.get(swimmerId)?.size ?? 0;
    const check = (which: 'individual' | 'relay' | 'total', count: number, cap: Cap) => {
      if (!capAllows(cap, count)) out.push({ kind: 'entry_cap', swimmerId, which, count, limit: cap as number });
    };
    check('individual', ind, caps.individual);
    check('relay', rel, caps.relay);
    check('total', ind + rel, caps.total);
  }
  return out;
}

/**
 * The relay entry rules (README R72, R42). Both read every resolved relay entry: an exhibition relay, a relay without a
 * time and a relay that `scorers.relayOverCap: 'exhibition'` removes all count, whatever `entries.exhibitionCounts` says.
 * Without that, R42 could never fire under `relayOverCap: 'exhibition'`, because the over-limit relays are the removed ones.
 * An absent rule is not checked. Lineups are never trimmed.
 */
function relayEntryViolations(resolved: readonly Resolved[], rules: CompleteRulePreset): Violation[] {
  const { relaySwimmerOncePerEvent, nonScoringRelaysAllowed } = rules.entries;
  const once = relaySwimmerOncePerEvent === undefined ? false : settled(relaySwimmerOncePerEvent, 'entries.relaySwimmerOncePerEvent');
  const allowed = nonScoringRelaysAllowed === undefined ? true : settled(nonScoringRelaysAllowed, 'entries.nonScoringRelaysAllowed');
  const limit = settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent');
  const checkLimit = !allowed && limit !== 'unlimited';
  if (!once && !checkLimit) return [];

  const groups = new Map<string, { teamId: TeamId; eventKey: EventKey; gender: Gender; keys: string[]; bySwimmer: Map<SwimmerId, string[]> }>();
  for (const r of resolved) {
    if (r.entry.kind !== 'relay') continue;
    const id = JSON.stringify([r.entry.teamId, r.entry.eventKey, r.entry.gender]);
    let group = groups.get(id);
    if (!group) {
      group = { teamId: r.entry.teamId, eventKey: r.entry.eventKey, gender: r.entry.gender, keys: [], bySwimmer: new Map() };
      groups.set(id, group);
    }
    group.keys.push(r.key);
    // One relay lists a swimmer once here: two legs of one relay are `duplicate_swimmer`, not a repeat across relays.
    for (const swimmerId of new Set(r.swimmerIds)) {
      const list = group.bySwimmer.get(swimmerId);
      if (list) list.push(r.key);
      else group.bySwimmer.set(swimmerId, [r.key]);
    }
  }

  const repeated: Extract<Violation, { kind: 'relay_swimmer_repeated' }>[] = [];
  const over: Extract<Violation, { kind: 'relay_entries_over_limit' }>[] = [];
  for (const { teamId, eventKey, gender, keys, bySwimmer } of groups.values()) {
    if (checkLimit && keys.length > (limit as number)) {
      over.push({ kind: 'relay_entries_over_limit', teamId, eventKey, gender, entryKeys: keys, count: keys.length, limit: limit as number });
    }
    if (once) {
      for (const [swimmerId, entryKeys] of bySwimmer) {
        if (entryKeys.length > 1) repeated.push({ kind: 'relay_swimmer_repeated', teamId, swimmerId, eventKey, gender, entryKeys });
      }
    }
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byGroup = (
    a: { teamId: TeamId; eventKey: EventKey; gender: Gender },
    b: { teamId: TeamId; eventKey: EventKey; gender: Gender }
  ): number => compare(a.teamId, b.teamId) || compare(a.eventKey, b.eventKey) || compare(a.gender, b.gender);
  repeated.sort((a, b) => byGroup(a, b) || compare(a.swimmerId, b.swimmerId));
  over.sort(byGroup);
  return [...over, ...repeated];
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                    */
/* -------------------------------------------------------------------------- */

/** Standard competition ranking over `values`, already sorted best first: equal values share a rank. */
function rankSorted(values: readonly Hundredths[], ties: TieRule): number[] {
  const ranks: number[] = [];
  values.forEach((v, i) => {
    // 'ordered': every entry takes its own place, so equal values do not share a rank.
    ranks.push(ties === 'split' && i > 0 && v === values[i - 1] ? (ranks[i - 1] as number) : i + 1);
  });
  return ranks;
}

/* -------------------------------------------------------------------------- */
/* scoreMeet                                                                  */
/* -------------------------------------------------------------------------- */

const ROUND = 'A Final';
const legacyGender = (g: Gender): LegacyGender => (g === 'Men' ? LegacyGender.MEN : LegacyGender.WOMEN);
const legacySwimmer = (id: SwimmerId): string => `sw:${id}`;
const legacyTeam = (id: TeamId): string => `tm:${id}`;

function checkNameCollisions(model: MeetModel): void {
  const check = (ids: readonly string[], toKey: (id: string) => string, what: string) => {
    const seen = new Map<string, string>();
    for (const id of ids) {
      const k = normalizeSwimmerName(toKey(id));
      const other = seen.get(k);
      if (other !== undefined && other !== id) {
        fail('name_collision', `${what} ids "${other}" and "${id}" normalize to the same legacy key "${k}"`, id);
      }
      seen.set(k, id);
    }
  };
  check(model.swimmers.map((s) => s.swimmerId), legacySwimmer, 'swimmer');
  check(model.teams.map((t) => t.teamId), legacyTeam, 'team');
}

interface Tables {
  readonly individual: readonly number[];
  readonly diving: readonly number[];
  readonly relay: readonly number[];
}

export function pointTables(rules: CompleteRulePreset): Tables {
  const individual = settled(rules.scoring.individualPoints, 'scoring.individualPoints');
  const relayRule = settled(rules.scoring.relayPoints, 'scoring.relayPoints');
  const divingRule = settled(rules.scoring.divingPoints, 'scoring.divingPoints');
  return {
    individual,
    diving: divingRule.kind === 'table' ? divingRule.points : individual,
    relay: relayRule.kind === 'table' ? relayRule.points : individual.map((p) => p * relayRule.multiplier),
  };
}

interface IndividualCap {
  readonly cap: number;
  readonly overCap: 'holds-place' | 'removed-from-consideration';
}

/**
 * The per-event scorer cap that applies to an individual event, with its over-cap behavior, or `null`
 * for unlimited. Diving uses its own rule when it has one, the swimming rule otherwise.
 */
function individualCap(rules: CompleteRulePreset, event: MeetEvent): IndividualCap | null {
  const swimming = settled(rules.scorers.perEventScorerCap, 'scorers.perEventScorerCap');
  const diving = settled(rules.scorers.divingPerEventScorerCap, 'scorers.divingPerEventScorerCap');
  const rule = event.kind === 'diving' && diving.kind === 'own' ? diving : swimming;
  if (rule.cap === 'unlimited') return null;
  return { cap: rule.cap, overCap: rule.overCap };
}

/** The entries of each (gender, event), in lineup order. */
export function groupFields(resolved: readonly Resolved[]): Map<string, Resolved[]> {
  const fieldOf = new Map<string, Resolved[]>();
  for (const r of resolved) {
    const id = eventId(r.event.eventKey, r.gender);
    const bucket = fieldOf.get(id);
    if (bucket) bucket.push(r);
    else fieldOf.set(id, [r]);
  }
  return fieldOf;
}

/** The rank of every timed entry, by entry key. An entry with no time has no rank. */
export function rankFields(fieldOf: ReadonlyMap<string, readonly Resolved[]>, ties: TieRule): Map<string, number> {
  const rankOf = new Map<string, number>();
  for (const field of fieldOf.values()) {
    const timed = field.filter((r) => r.value !== null);
    const diving = (field[0] as Resolved).event.kind === 'diving';
    // A stable sort: entries of equal value keep lineup order. Under 'split' they share a rank, so order
    // does not move points. Under 'ordered' lineup order is the tiebreak, and it does.
    timed.sort((a, b) => (diving ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)));
    const ranks = rankSorted(timed.map((r) => r.value as number), ties);
    timed.forEach((r, i) => rankOf.set(r.key, ranks[i] as number));
  }
  return rankOf;
}

/** Legacy rows, one list per gender (the legacy scorer assumes one gender per call), scored by the legacy scorer. */
function legacyPoints(resolved: readonly Resolved[], rankOf: ReadonlyMap<string, number>, legacySettings: ReturnType<typeof toLegacyScoringSettings>): Map<string, number> {
  const rowsByGender = new Map<Gender, SwimmerResult[]>();
  const push = (gender: Gender, row: SwimmerResult) => {
    const bucket = rowsByGender.get(gender);
    if (bucket) bucket.push(row);
    else rowsByGender.set(gender, [row]);
  };
  for (const r of resolved) {
    const rank = rankOf.get(r.key);
    if (rank === undefined || r.value === null) continue;
    const base = {
      rank,
      classYear: '',
      team: legacyTeam(r.entry.teamId),
      time: formatHundredths(r.value),
      points: 0,
      event: r.event.eventKey,
      gender: legacyGender(r.gender),
      roundSwam: ROUND,
    };
    if (r.entry.kind === 'individual') {
      push(r.gender, { ...base, id: r.key, name: legacySwimmer(r.entry.swimmerId) });
    } else {
      // relayEntryGroupKey sorts relayNames to identify an entry. Keep the display/scorer row
      // names stable, but include the resolved key in this signature so separate lineup entries
      // with the same swimmers remain distinct in the frozen legacy scorer.
      const relayNames = r.swimmerIds.map((id) => ({ name: `${legacySwimmer(id)}|${r.key}`, year: '' }));
      r.swimmerIds.forEach((id, i) => {
        push(r.gender, { ...base, id: `${r.key}#${i}`, name: legacySwimmer(id), isRelay: true, relayNames, relayTeamTime: base.time });
      });
    }
  }
  const pointsById = new Map<string, number>();
  for (const rows of rowsByGender.values()) {
    for (const scored of calculatePoints(rows, legacySettings)) pointsById.set(scored.id, Number(scored.points));
  }
  return pointsById;
}

interface OverCap {
  /** Over the cap and holding its place: the legacy scorer zeroed it; this only names the reason. */
  readonly held: Set<string>;
  /**
   * Over the cap and removed from the places: an individual or diving entry whose over-cap rule is
   * `'removed-from-consideration'`, or a relay when `scorers.relayOverCap` is `'exhibition'`.
   */
  readonly removed: Set<string>;
}

/**
 * The entries over a per-team cap, from the ranks of the full field. `removed` holds the individual and
 * diving entries whose over-cap rule is `'removed-from-consideration'`, and the relays over their cap when
 * `scorers.relayOverCap` is `'exhibition'`. Every other over-cap entry is in `held`. Which entries are over
 * the cap does not depend on the treatment.
 */
function overCapKeys(
  fieldOf: ReadonlyMap<string, readonly Resolved[]>,
  rankOf: ReadonlyMap<string, number>,
  rules: CompleteRulePreset,
  tables: Tables,
  heldNonScorers: ReadonlySet<string> = new Set()
): OverCap {
  const relayCap = settled(rules.scorers.scoringRelaysPerTeamPerEvent, 'scorers.scoringRelaysPerTeamPerEvent');
  const relayOver = settled(rules.scorers.relayOverCap, 'scorers.relayOverCap') === 'exhibition' ? 'removed' : 'held';
  const held = new Set<string>();
  const removed = new Set<string>();
  for (const field of fieldOf.values()) {
    const sample = (field[0] as Resolved).event;
    // A non-scorer entry that holds its place is not a scorer: it takes no cap slot (roster eligibility).
    const timed = field.filter((r) => rankOf.has(r.key) && !heldNonScorers.has(r.key)).sort(byRank(rankOf));
    if (sample.kind === 'relay') {
      if (relayCap === 'unlimited') continue;
      const counts = new Map<TeamId, number>();
      for (const r of timed) {
        // Under 'holds-place' a relay past the table takes no cap slot (relayScoring.ts). Under 'exhibition'
        // every relay after a team's first `relayCap` may not score, wherever it finished, so all of them leave
        // the places: none can move into a place the removal opens (D2 9.8).
        if (relayOver === 'held' && (rankOf.get(r.key) as number) > tables.relay.length) continue;
        const used = counts.get(r.entry.teamId) ?? 0;
        if (used >= relayCap) (relayOver === 'removed' ? removed : held).add(r.key);
        else counts.set(r.entry.teamId, used + 1);
      }
    } else {
      const rule = individualCap(rules, sample);
      if (rule === null) continue;
      const over = rule.overCap === 'removed-from-consideration' ? removed : held;
      const admitted = new Map<TeamId, Set<SwimmerId>>();
      for (const r of timed) {
        const set = admitted.get(r.entry.teamId) ?? new Set<SwimmerId>();
        admitted.set(r.entry.teamId, set);
        const id = r.swimmerIds[0] as SwimmerId;
        if (set.has(id)) continue;
        if (set.size < rule.cap) set.add(id);
        else over.add(r.key);
      }
    }
  }
  return { held, removed };
}

function entryPoints(r: Resolved, place: number | null, pointsById: ReadonlyMap<string, number>): number {
  if (place === null) return 0;
  if (r.entry.kind === 'individual') return pointsById.get(r.key) as number;
  return r.swimmerIds.reduce((sum, _id, i) => sum + (pointsById.get(`${r.key}#${i}`) as number), 0);
}

function resultRow(
  r: Resolved,
  rankOf: ReadonlyMap<string, number>,
  pointsById: ReadonlyMap<string, number>,
  overCap: OverCap,
  tables: Tables,
  roster: RosterPlan | null
): ResultRow {
  const place = rankOf.get(r.key) ?? null;
  // Under roster eligibility the legacy scorer is uncapped and knows no roster: the engine zeroes what it holds.
  const zeroed = roster !== null && (roster.held.has(r.key) || overCap.held.has(r.key));
  const points = zeroed ? 0 : entryPoints(r, place, pointsById);
  const base = { entryKey: r.key, teamId: r.entry.teamId, swimmerId: r.entry.kind === 'individual' ? r.entry.swimmerId : null, place, points, scored: points > 0 };
  const rosterRemoved = roster?.removed.get(r.key);
  if (rosterRemoved !== undefined) return { ...base, notScoredReason: rosterRemoved };
  // A removed entry has no place and no points, like an entry with no time. Its own reason keeps the two apart:
  // an individual entry over its cap is `removed_over_event_cap`, a relay over its cap is `exhibition` (R67).
  if (overCap.removed.has(r.key)) return { ...base, notScoredReason: r.event.kind === 'relay' ? 'exhibition' : 'removed_over_event_cap' };
  if (points > 0) return base;
  if (place === null) return { ...base, notScoredReason: 'no_time' };
  if (roster?.held.has(r.key)) return { ...base, notScoredReason: 'non_scorer' };
  const table = r.event.kind === 'relay' ? tables.relay : r.event.kind === 'diving' ? tables.diving : tables.individual;
  if (place > table.length) return { ...base, notScoredReason: 'outside_point_table' };
  if (overCap.held.has(r.key)) return { ...base, notScoredReason: r.event.kind === 'relay' ? 'relay_scorer_cap' : 'event_scorer_cap' };
  return base;
}

const compareRows = (a: ResultRow, b: ResultRow): number =>
  (a.place ?? Infinity) - (b.place ?? Infinity) || (a.entryKey < b.entryKey ? -1 : a.entryKey > b.entryKey ? 1 : 0);

/** Every model team, best first. Teams with equal points share a rank (standard competition ranking). */
function rankTeams(model: MeetModel, events: readonly { readonly rows: readonly ResultRow[] }[]): Results['teams'] {
  const totals = new Map<TeamId, number>(model.teams.map((t) => [t.teamId, 0]));
  for (const e of events) for (const row of e.rows) totals.set(row.teamId, (totals.get(row.teamId) ?? 0) + row.points);
  const ordered = model.teams.map((t) => ({ teamId: t.teamId, points: totals.get(t.teamId) as number })).sort((a, b) => b.points - a.points);
  const teams: { teamId: TeamId; points: number; rank: number }[] = [];
  ordered.forEach((t, i) => {
    const previous = teams[i - 1];
    teams.push({ ...t, rank: previous !== undefined && previous.points === t.points ? previous.rank : i + 1 });
  });
  return teams;
}

/** The refusals that come before any scoring: a lineup for another meet, a size rule with no meaning, and a tag under `'points_pool'`. */
function checkScorable(model: MeetModel, lineup: Lineup, tags: readonly ScorerTag[], rules: CompleteRulePreset): void {
  if (lineup.meetKey !== model.meetKey) {
    fail('meet_key_mismatch', `the lineup is for meet "${lineup.meetKey}", the model for "${model.meetKey}"`);
  }
  const eligibility = settled(rules.scorers.eligibility, 'scorers.eligibility');
  if (eligibility === 'roster') {
    const size = settled(rules.scorers.scoringTeamSize, 'scorers.scoringTeamSize');
    if (size !== 'unlimited' && settled(rules.scorers.scoringTeamScope, 'scorers.scoringTeamScope') === 'event') {
      fail('team_size_scope_unsupported', 'scorers.scoringTeamSize is a number and scorers.scoringTeamScope is "event": no rule says what a per-event team size means under roster eligibility');
    }
    return;
  }
  if (tags.length > 0) {
    fail('tags_need_roster_mode', `${tags.length} tag(s) given, but the legacy scorer ignores a tag under "points_pool"`);
  }
}

/* -------------------------------------------------------------------------- */
/* Roster eligibility                                                         */
/* -------------------------------------------------------------------------- */

/** What the roster rules decided about the entries. Only built under `scorers.eligibility: 'roster'`. */
interface RosterPlan {
  /** Entries that leave the places, with the reason: exhibition, or a non-scorer under `'removed-from-consideration'`. */
  readonly removed: ReadonlyMap<string, 'non_scorer' | 'exhibition'>;
  /** Non-scorer entries that keep their place and score 0 (`nonScorerPlacement: 'holds-place'`). */
  readonly held: ReadonlySet<string>;
  /** The `scoring_team_size` violations. */
  readonly violations: readonly Violation[];
}

const teamGender = (teamId: TeamId, gender: Gender): string => `${teamId}\u0000${gender}`;
const byTeamThenGender = (
  a: { readonly teamId: TeamId; readonly gender: Gender },
  b: { readonly teamId: TeamId; readonly gender: Gender }
): number => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : a.gender < b.gender ? -1 : a.gender > b.gender ? 1 : 0);

/** The tags as one role per swimmer. Throws on a tag the model cannot place, and on two roles for one swimmer. */
function readTags(tags: readonly ScorerTag[], index: Index): Map<SwimmerId, ScorerRole> {
  const roles = new Map<SwimmerId, ScorerRole>();
  for (const t of tags) {
    const what = `tag for swimmer "${t.swimmerId}" on team "${t.teamId}"`;
    if (!index.teams.has(t.teamId)) fail('unresolved_team', `${what}: team is not in the model`, t.teamId);
    const swimmer = index.swimmers.get(t.swimmerId);
    if (!swimmer) return fail('unresolved_swimmer', `${what}: swimmer is not in the model`, t.swimmerId);
    if (swimmer.teamId !== t.teamId) fail('team_mismatch', `${what}: the swimmer is on team ${swimmer.teamId}`, t.swimmerId);
    if (swimmer.roster === 'not_member') fail('roster_not_member', `${what}: the swimmer is not on the roster`, t.swimmerId);
    const prior = roles.get(t.swimmerId);
    if (prior !== undefined && prior !== t.role) fail('duplicate_tag', `${what}: tagged both "${prior}" and "${t.role}"`, t.swimmerId);
    roles.set(t.swimmerId, t.role);
  }
  return roles;
}

/**
 * The scoring roster from the tags (R65, R71), the entries it makes non-scorer or exhibition, and the team-size
 * violations. Throws `scoring_roster_missing` for a team and gender with entries and no scorer tag.
 */
function planRoster(resolved: readonly Resolved[], tags: readonly ScorerTag[], rules: CompleteRulePreset, index: Index): RosterPlan {
  const roles = readTags(tags, index);
  const roleOf = (id: SwimmerId): ScorerRole | undefined => roles.get(id);

  // One scoring roster per team and gender, as the legacy roster is (`teamMeetStateKey`, `scorerRosterKey`).
  const scorers = new Map<string, { teamId: TeamId; gender: Gender; ids: SwimmerId[] }>();
  for (const [id, role] of roles) {
    if (role !== 'scorer') continue;
    const swimmer = index.swimmers.get(id) as MeetSwimmer;
    const key = teamGender(swimmer.teamId, swimmer.gender);
    const bucket = scorers.get(key);
    if (bucket) bucket.ids.push(id);
    else scorers.set(key, { teamId: swimmer.teamId, gender: swimmer.gender, ids: [id] });
  }

  const missing = new Map<string, { teamId: TeamId; gender: Gender }>();
  for (const r of resolved) {
    const key = teamGender(r.entry.teamId, r.gender);
    if (!scorers.has(key)) missing.set(key, { teamId: r.entry.teamId, gender: r.gender });
  }
  if (missing.size > 0) {
    const list = [...missing.values()].sort(byTeamThenGender);
    const named = list.map((m) => `${m.teamId} (${m.gender})`).join(', ');
    throw new ScoreMeetError('scoring_roster_missing', `no scoring roster tagged for ${named}: tag the scoring team before the meet is scored`, null, list);
  }

  const mustBeScorers = settled(rules.scorers.relayLegsMustBeScorers, 'scorers.relayLegsMustBeScorers');
  const holds = settled(rules.scoring.nonScorerPlacement, 'scoring.nonScorerPlacement') === 'holds-place';
  const removed = new Map<string, 'non_scorer' | 'exhibition'>();
  const held = new Set<string>();
  const warnings: Violation[] = [];
  for (const r of resolved) {
    const legRoles = r.swimmerIds.map(roleOf);
    if (legRoles.includes('exhibition')) {
      removed.set(r.key, 'exhibition');
      continue;
    }
    const onRoster = r.entry.kind === 'individual' ? legRoles[0] === 'scorer' : !mustBeScorers || legRoles.every((role) => role === 'scorer');
    if (onRoster) {
      // R77: the relay scores, and each leg off the scoring roster is named.
      if (r.entry.kind === 'relay') {
        legRoles.forEach((role, i) => {
          if (role !== 'scorer') warnings.push({ kind: 'relay_leg', entryKey: r.key, leg: (i + 1) as 1 | 2 | 3 | 4, reason: 'off_scoring_roster' });
        });
      }
      continue;
    }
    if (holds) held.add(r.key);
    else removed.set(r.key, 'non_scorer');
  }

  // R78: a tagged scorer with no entry. Sorted by team, gender, then swimmer id.
  const entered = new Set(resolved.flatMap((r) => r.swimmerIds));
  const noEntry: Extract<Violation, { kind: 'scorer_without_entry' }>[] = [];
  for (const { teamId, gender, ids } of scorers.values()) {
    for (const swimmerId of ids) if (!entered.has(swimmerId)) noEntry.push({ kind: 'scorer_without_entry', teamId, gender, swimmerId });
  }
  noEntry.sort((a, b) => byTeamThenGender(a, b) || (a.swimmerId < b.swimmerId ? -1 : a.swimmerId > b.swimmerId ? 1 : 0));

  return { removed, held, violations: [...warnings, ...noEntry, ...teamSizeViolations(resolved, scorers, rules)] };
}

/**
 * Over-size rosters (README R24, R9, R28). A tagged scorer takes a full spot, except a swimmer whose entries are all
 * diving, who takes `diverWeight` of one. The legacy rule is the precedent: a swimmer with an individual diving row is a
 * diver (`buildRosterMeta`). R28 says a relay swimmer takes a full spot, so a swimmer on any relay is not a diver. A
 * tagged swimmer with no entry is not known to be a diver, so takes a full spot (README R78, which `planRoster` warns of). The sums are whole numbers over the
 * weight's denominator, so no float decides a boundary.
 */
function teamSizeViolations(
  resolved: readonly Resolved[],
  scorers: ReadonlyMap<string, { teamId: TeamId; gender: Gender; ids: readonly SwimmerId[] }>,
  rules: CompleteRulePreset
): Violation[] {
  const limit = settled(rules.scorers.scoringTeamSize, 'scorers.scoringTeamSize');
  if (limit === 'unlimited') return [];
  const weight = settled(rules.scorers.diverWeight, 'scorers.diverWeight');
  const dives = new Set<SwimmerId>();
  const relays = new Set<SwimmerId>();
  for (const r of resolved) {
    if (r.entry.kind === 'relay') r.swimmerIds.forEach((id) => relays.add(id));
    else if (r.event.kind === 'diving') dives.add(r.entry.swimmerId);
  }
  const out: Extract<Violation, { kind: 'scoring_team_size' }>[] = [];
  for (const { teamId, gender, ids } of scorers.values()) {
    const divers = ids.filter((id) => dives.has(id) && !relays.has(id)).length;
    const full = ids.length - divers;
    const numerator = full * weight.denominator + divers * weight.numerator;
    if (numerator > limit * weight.denominator) {
      out.push({ kind: 'scoring_team_size', teamId, gender, scorers: full, divers, spots: { numerator, denominator: weight.denominator }, limit });
    }
  }
  return out.sort(byTeamThenGender);
}

/**
 * The rules the legacy scorer gets under roster eligibility: points by place and nothing else. The roster gate, the
 * team pool and every cap are off. Left on, the scorer would build its own roster from the rows (every row is labeled
 * an A Final, so it would mark everyone), pass every relay without a leg check (D2 F19), and trim a team that is over
 * its size. `scoreMeet` makes those decisions itself. The copy keeps the point tables, the half-rate relay rule and the
 * tie handling.
 */
function pointsOnlyRules(rules: CompleteRulePreset): CompleteRulePreset {
  const eligibility = rules.scorers.eligibility;
  if (eligibility.state !== 'set') return settled(eligibility, 'scorers.eligibility') as never;
  // Internal and never returned: every overridden value borrows the eligibility setting's provenance.
  const as = <T>(value: T): Setting<T> => ({ state: 'set', value, provenance: eligibility.provenance });
  return {
    ...rules,
    scorers: {
      ...rules.scorers,
      eligibility: as<'roster' | 'points_pool'>('points_pool'),
      autoRules: as<EngineScorerAutoRules | null>(null),
      scoringTeamSize: as<Cap>('unlimited'),
      scoringTeamScope: as<'meet' | 'event'>('event'),
      perEventScorerCap: as<PerEventScorerCap>({ cap: 'unlimited' }),
      divingPerEventScorerCap: as<DivingPerEventScorerCap>({ kind: 'same-as-swimming' }),
      scoringRelaysPerTeamPerEvent: as<Cap>('unlimited'),
      relayEligibleFromScorerPool: as(false),
    },
  } as CompleteRulePreset;
}

export function scoreMeet(
  model: MeetModel,
  lineup: Lineup,
  tags: readonly ScorerTag[],
  rules: CompleteRulePreset,
  // P2 reads nothing from the sourcing settings: each swim already carries its SCY statement. The
  // parameter is here so P4 (flyover, split window) adds no argument. Do not rely on it being unread.
  sourcing: ConversionSettings
): Results {
  void sourcing;
  checkScorable(model, lineup, tags, rules);
  const ties = settled(rules.scoring.ties, 'scoring.ties');
  const rosterMode = settled(rules.scorers.eligibility, 'scorers.eligibility') === 'roster';
  const legacySettings = toLegacyScoringSettings(rosterMode ? pointsOnlyRules(rules) : rules, { ranksAreDistinct: true });
  const tables = pointTables(rules);
  const entryCaps = {
    individual: settled(rules.entries.maxIndividualPerSwimmer, 'entries.maxIndividualPerSwimmer'),
    relay: settled(rules.entries.maxRelayPerSwimmer, 'entries.maxRelayPerSwimmer'),
    total: settled(rules.entries.maxTotalPerSwimmer, 'entries.maxTotalPerSwimmer'),
  };
  const exhibitionCounts = settled(rules.entries.exhibitionCounts, 'entries.exhibitionCounts');

  checkNameCollisions(model);
  const index = buildIndex(model);
  const { resolved, violations, rosterUnknown } = resolveLineup(model, lineup, index);

  const fieldOf = groupFields(resolved);
  // Roster eligibility: the exhibition entries and the removed non-scorers leave before any cap runs, so the caps
  // see the field of scoring-roster entries. Under 'points_pool' nothing leaves here and `kept` is `fieldOf`.
  const roster = rosterMode ? planRoster(resolved, tags, rules, index) : null;
  const leaving = roster === null ? new Set<string>() : new Set(roster.removed.keys());
  const kept = leaving.size === 0 ? fieldOf : withoutRemoved(fieldOf, leaving);
  const fullRankOf = rankFields(kept, ties);
  const overCap = overCapKeys(kept, fullRankOf, rules, tables, roster?.held);
  // 'removed-from-consideration' (and a relay under 'exhibition'): the over-cap entries leave the field, and the
  // rest are ranked again without them, so the entries behind move up. A removed entry has no rank. One pass is
  // enough for the selection, which is made on the full-field ranks (see the header for the relay edge case).
  // 'holds-place' skips this and keeps the full-field ranks.
  const removedKeys = overCap.removed.size === 0 ? leaving : new Set([...leaving, ...overCap.removed]);
  const rankOf = overCap.removed.size === 0 ? fullRankOf : rankFields(withoutRemoved(fieldOf, removedKeys), ties);
  const survivors = removedKeys.size === 0 ? resolved : resolved.filter((r) => !removedKeys.has(r.key));
  const pointsById = legacyPoints(survivors, rankOf, legacySettings);

  const events: { eventKey: EventKey; gender: Gender; rows: ResultRow[] }[] = [];
  for (const event of model.events) {
    const field = fieldOf.get(eventId(event.eventKey, event.gender));
    if (!field) continue;
    const rows = field.map((r) => resultRow(r, rankOf, pointsById, overCap, tables, roster)).sort(compareRows);
    events.push({ eventKey: event.eventKey, gender: event.gender, rows });
  }

  // `entries.exhibitionCounts` false: the exhibition entries leave the entry limits. Those are the entries of a
  // swimmer tagged 'exhibition', the relays with such a leg (every leg leaves), and the relays removed by
  // `scorers.relayOverCap: 'exhibition'`: exactly the rows with `notScoredReason: 'exhibition'`.
  const exhibitionKeys = exhibitionCounts
    ? null
    : new Set([
        ...[...(roster?.removed ?? [])].filter(([, why]) => why === 'exhibition').map(([key]) => key),
        ...resolved.filter((r) => r.event.kind === 'relay' && overCap.removed.has(r.key)).map((r) => r.key),
      ]);
  const counted = exhibitionKeys === null ? resolved : resolved.filter((r) => !exhibitionKeys.has(r.key));

  return {
    payloadVersion: 1,
    teams: rankTeams(model, events),
    events,
    violations: [...violations, ...entryCapViolations(counted, entryCaps), ...relayEntryViolations(resolved, rules), ...rosterViolations(roster, overCap)],
    rosterUnknown,
  };
}

/**
 * The roster's violations, without the R77 leg warnings of a relay that `scorers.relayOverCap: 'exhibition'` removed:
 * that relay does not score, so its off-roster legs need no warning.
 */
function rosterViolations(roster: RosterPlan | null, overCap: OverCap): readonly Violation[] {
  if (roster === null) return [];
  return roster.violations.filter((v) => !(v.kind === 'relay_leg' && v.reason === 'off_scoring_roster' && overCap.removed.has(v.entryKey)));
}

/** The fields without the removed entries. The best entry of a team is never over its cap, so no field empties. */
function withoutRemoved(fieldOf: ReadonlyMap<string, readonly Resolved[]>, removed: ReadonlySet<string>): Map<string, Resolved[]> {
  const out = new Map<string, Resolved[]>();
  for (const [id, field] of fieldOf) {
    const kept = field.filter((r) => !removed.has(r.key));
    if (kept.length > 0) out.set(id, kept);
  }
  return out;
}

function byRank(rankOf: ReadonlyMap<string, number>) {
  // The legacy order inside a rank: finish order, then the synthetic name (`placeOrderCompare`).
  return (a: Resolved, b: Resolved): number => {
    const ra = rankOf.get(a.key) as number;
    const rb = rankOf.get(b.key) as number;
    if (ra !== rb) return ra - rb;
    return legacySwimmer(a.swimmerIds[0] as SwimmerId).localeCompare(legacySwimmer(b.swimmerIds[0] as SwimmerId));
  };
}

/** The results without `display`. The key is removed, never set to `undefined`. */
export function stripResultsDisplay(r: Results): Results {
  const { display: _display, ...rest } = r;
  return rest;
}
