/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The scoring entry point: recruit placement, meet place field and `calculatePoints`.
// Split out of `utils.ts`, which still re-exports every name from here.

import { Gender, ScorerRosterOverride, SwimmerResult, ScoringSettings } from '../types';
import { buildScorerRosterLookup, ScorerRosterLookup, usesScorerRoster } from './scorerRoster';
// Dependency-free by design — see the module header there. Importing
// `cutlineUtils` here instead would create a cycle (it imports this file).
import { courseOfRecordFromEventLabel } from './cutlineEventNames';
import { itemAt } from './indexedAccess';
import { effectivePdfPlacePointsMode, mergeScoringSettings } from './scoringDefaults';
// A leaf module (types + cutlineEventNames only), so no cycle. `rosterCatalog`
// itself imports this file, which is why its helpers are not used here.
import { swimEventIdentity } from './bestTimeEligibility';
import { convertTimeToSeconds, formatSecondsToTime } from './timeFormat';
import { eventMeetSortKey, sortEventsByMeetOrder } from './eventLabels';
import {
  classifyRoundTier,
  isChampionshipGenderEvent,
  isOutsideScoredProgram,
  parseRankInt,
  isRelayResult,
  roundTierSort,
  isDivingEvent,
} from './scoringRules';
import { type TeamMeetState, seedAbRelayLegsIntoPool } from './meetPool';
import { runIndividualScoringForEvent } from './individualScoring';
import { scoreRelaysInEvent } from './relayScoring';

export type CalculatePointsOptions = {
  scorerRosterOverrides?: ScorerRosterOverride[];
  /** Forwarded to mergeScoringSettings (NSISC roster coercion vs PDF lock). */
  conferenceForMerge?: string;
  /** When omitted, non-recruit rows from `results` are used for PDF-place auto-detect. */
  resultsForPdfHint?: SwimmerResult[];
  /**
   * Last event number the meet scored, from `OfficialTeamScores.eventThrough`
   * ("Team Rankings - Through Event N"). Rows in higher-numbered events earn no
   * team points. Overrides `ScoringSettings.scoredEventNumberMax`; omit both to
   * score every event.
   */
  scoredEventNumberMax?: number;
};

/** Per-row points from HyTek PDF when PDF-place scoring is active (see usePdfPlacePoints). */
function pdfPlacePointsForRow(row: SwimmerResult, scoredEventNumberMax?: number): number {
  if (row.isExhibition) return 0;
  if (isOutsideScoredProgram(row.event, scoredEventNumberMax)) return 0;
  if (row.isTimeTrial && !isChampionshipGenderEvent(row.event)) return 0;
  const pp = row.pdfPoints;
  if (pp != null && Number.isFinite(pp) && pp >= 0) return pp;
  return 0;
}

/**
 * Meet rows an injected recruit is placed against: individual swims in the same
 * event, same gender, that reached a scored round.
 */
function recruitComparators(
  pdfResults: SwimmerResult[],
  event: string | undefined,
  gender: Gender | undefined
): SwimmerResult[] {
  return pdfResults.filter(
    r =>
      !isRelayResult(r) &&
      r.event === event &&
      (r.gender == null || gender == null || r.gender === gender) &&
      ['A', 'B', 'FIN'].includes(classifyRoundTier(r.roundSwam))
  );
}

/**
 * Places one field of rows, fastest first, sharing a place ONLY on an exact
 * time tie (standard competition ranking: 1, 2, 2, 4). `Infinity` — NT and DQ —
 * compares equal to itself, so those rows share the tail place exactly as they
 * did when each was ranked on its own.
 */
function placeFieldByTime(field: SwimmerResult[]): Map<SwimmerResult, number> {
  const sorted = [...field].sort(
    (a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time)
  );
  const places = new Map<SwimmerResult, number>();
  let place = 0;
  let prevSec = Number.NaN;
  sorted.forEach((row, i) => {
    const sec = convertTimeToSeconds(row.time);
    if (i === 0 || sec !== prevSec) place = i + 1;
    prevSec = sec;
    places.set(row, place);
  });
  return places;
}

/**
 * Assign championship-round placements to injected recruit rows.
 *
 * TWO RULES, both about not inventing a dead heat. `scoreIndividualsInEvent`
 * groups by event + round + rank and splits the place ladder across whatever it
 * finds there, so any two rows this function puts on one rank are scored as a
 * tie — and a fabricated tie pays fractional points (thirds, twentieths) that
 * no scoring table can award.
 *
 * 1. A ROW THAT ALREADY CARRIES A PLACEMENT KEEPS IT. `projectRanksInField`
 *    ranks the whole what-if field — meet rows, plan rows and recruit rows
 *    together — in one pass, so on a projected workspace every row arrives here
 *    already placed against the full field. Re-deriving a recruit's place from a
 *    SUBSET of that field (the meet rows alone) threw that answer away and put
 *    different times on one place. Rank 0 means "not placed yet"; a positive
 *    rank means "placed", and placed is not the same as unplaced.
 *
 * 2. ROWS THAT STILL NEED A PLACE ARE PLACED AGAINST EACH OTHER, not only
 *    against the meet rows. Ranking each recruit on its own gave every recruit
 *    sharing an insertion slot the same place, and on a roster-only workspace —
 *    no meet rows, so no comparators at all — gave EVERY recruit place 1, so one
 *    event scored as one N-way tie (plans/2026-08-14/12 §2, open since
 *    2026-08-16). Only an exact time tie shares a place now.
 *
 * `roundSwam: 'A Final'` on a newly placed row is unchanged: for tier A the
 * scoring index is `rank - 1`, i.e. the rank is read as an overall place, which
 * is what this function assigns. It agrees with `projectRanksInField`'s
 * A/B/Preliminaries banding place for place.
 *
 * STILL OPEN — a recruit can still collide with a MEET row. The meet rows keep
 * the places the meet gave them, so a recruit placed 7th shares a rank with the
 * real 7th finisher and the two are scored as a dead heat. It cannot arise while
 * the field is projected (`projectRanksInField` re-places everyone, and rule 1
 * then keeps that answer), so no saved workspace reaches it; deleting every
 * planned entry from a meet workspace that also holds recruits does — measured
 * 2026-09-02 on Blank Workspace 1 men, 18 such placements, e.g. River Paulk
 * 19.42 (recruit) tied with Sam Ragsdell 20.22 (meet row) for 18.5 points each.
 * Closing it means deciding that injected recruits re-place the meet field,
 * which is a projection-gating change, not a placement one.
 */
export function prepareRecruitsForScoring(
  pdfResults: SwimmerResult[],
  recruits: SwimmerResult[]
): SwimmerResult[] {
  if (!recruits.length) return [];

  // Rule 1 — only rows with no placement need one.
  const unplaced = recruits.filter(r => parseRankInt(r.rank) == null);
  if (unplaced.length === 0) return recruits;

  // Rule 2 — one field per (event, gender), holding the meet rows AND every
  // unplaced recruit in it, placed in a single pass.
  const fields = new Map<string, SwimmerResult[]>();
  for (const r of unplaced) {
    const key = `${String(r.event ?? '')}|||${r.gender ?? ''}`;
    const held = fields.get(key);
    if (held) held.push(r);
    else fields.set(key, [r]);
  }

  const placeByRow = new Map<SwimmerResult, number>();
  for (const group of fields.values()) {
    // Each field was created with `[r]`, so a field is never empty.
    const sample = itemAt(group, 0);
    const field = [...recruitComparators(pdfResults, sample.event, sample.gender), ...group];
    for (const [row, place] of placeFieldByTime(field)) {
      if (!placeByRow.has(row)) placeByRow.set(row, place);
    }
  }

  return recruits.map(recruit => {
    if (parseRankInt(recruit.rank) != null) return recruit;
    const place = placeByRow.get(recruit);
    if (place == null) {
      // Unreachable by construction: every unplaced row is in exactly one field.
      // Raised rather than defaulted — the old `rank > 0 ? rank : 1` fallback IS
      // the collapse this function now exists to prevent.
      throw new Error(
        `prepareRecruitsForScoring: no place derived for ${recruit.name} in ${recruit.event}`
      );
    }
    return { ...recruit, roundSwam: 'A Final', rank: place };
  });
}

/**
 * One meet label per event key, from one gender's meet rows.
 *
 * Several labels can name one event: a separately numbered prelims or finals
 * variant, or a post-meet extra such as `Event 939 Boys 100 Yard Breaststroke`
 * beside the program's `Event 26 Men 100 Yard Breaststroke`. The rule: the label
 * with the MOST rows (the fuller field, the scored final), then the LOWEST
 * HyTek event number, then the lexicographically smallest label. The choice
 * does not depend on row order.
 *
 * `keyOf` returns `null` for a row that names no event of interest. This is the
 * rule `buildMeetEventLabelIndex` (eventIdentity.ts) applies with the canonical
 * program label as the key, and the one {@link buildMeetPlaceField} applies with
 * the event identity; both call this function so the two cannot drift.
 */
export function chooseMeetEventLabels(
  results: readonly SwimmerResult[] | undefined,
  keyOf: (row: SwimmerResult) => string | null
): Map<string, string> {
  // key -> (meet label -> row count)
  const counts = new Map<string, Map<string, number>>();
  for (const r of results ?? []) {
    const key = keyOf(r);
    if (!key) continue;
    let byLabel = counts.get(key);
    if (!byLabel) {
      byLabel = new Map();
      counts.set(key, byLabel);
    }
    byLabel.set(r.event, (byLabel.get(r.event) ?? 0) + 1);
  }

  const index = new Map<string, string>();
  for (const [key, byLabel] of counts) {
    let bestLabel: string | undefined;
    let bestCount = -1;
    let bestSortKey = Number.POSITIVE_INFINITY;
    for (const [label, count] of byLabel) {
      const sortKey = eventMeetSortKey(label);
      const better =
        count > bestCount ||
        (count === bestCount && sortKey < bestSortKey) ||
        (count === bestCount && sortKey === bestSortKey && (bestLabel == null || label < bestLabel));
      if (better) {
        bestLabel = label;
        bestCount = count;
        bestSortKey = sortKey;
      }
    }
    if (bestLabel != null) index.set(key, bestLabel);
  }
  return index;
}

/** Where a time would finish in a loaded meet's results for one event. */
export interface MeetPlace {
  /**
   * Standard competition ranking against the event's scored field: one more
   * than the number of rows strictly faster, so an exact tie shares the place.
   */
  place: number;
  /** Rows the time was placed against. */
  fieldSize: number;
  /** The meet's own label for the event. */
  meetEvent: string;
}

/** A loaded meet's scored fields, ready to answer "where would this time finish?". */
export interface MeetPlaceField {
  /** Event identities (see `swimEventIdentity`) the meet holds a scored field for. */
  readonly events: ReadonlySet<string>;
  /**
   * The place `seconds` (SCY) would take in the meet's field for `event`, or
   * `null` when the meet holds no scored field for that event, when every row
   * of the field is excluded, or when `seconds` is not a usable time.
   *
   * `isSameSwimmer` leaves the swimmer's own meet rows out of the field: a
   * swimmer does not race their own result, and the scoring path drops that
   * row too once another row for the same swimmer and event enters.
   */
  placeFor(
    event: string,
    seconds: number,
    isSameSwimmer?: (row: SwimmerResult) => boolean
  ): MeetPlace | null;
}

/**
 * The event a meet row can place a time in, or `null`.
 *
 * Relays, dives and time trials never do. Neither does a row whose label names
 * a metric course: the times this field is asked about are SCY, and an SCY time
 * among metre swims has no place. Meet rows are yards in every meet this repo
 * has loaded, so this refuses a case rather than handling one.
 */
function meetPlaceEventKey(row: SwimmerResult): string | null {
  if (isRelayResult(row) || row.isTimeTrial) return null;
  if (isDivingEvent(row.event)) return null;
  const course = courseOfRecordFromEventLabel(row.event);
  if (course != null && course !== 'SCY') return null;
  return swimEventIdentity(row.event);
}

/**
 * Index one gender's loaded meet results so a time can be placed in them.
 *
 * This is the placement an injected recruit row gets in
 * {@link prepareRecruitsForScoring}, asked for one time at a time: the field
 * is {@link recruitComparators} (individual rows of that gender in a scored
 * round: A final, B final or a timed final), and the place comes from
 * {@link placeFieldByTime}. An event is matched by `swimEventIdentity`, so
 * `50 Free`, `50 Freestyle` and `Event 8 Men 50 Yard Freestyle` are one event;
 * when two meet labels share an identity, {@link chooseMeetEventLabels} picks
 * one, as the what-if remap does.
 *
 * `null` when the rows hold no scored individual field at all: no meet is
 * loaded, or the loaded meet's rounds are all unscored. That is "no meet to
 * rank against", never "last place".
 */
export function buildMeetPlaceField(
  results: readonly SwimmerResult[] | undefined,
  gender: Gender
): MeetPlaceField | null {
  const rows = [...(results ?? [])];
  const fields = new Map<string, { meetEvent: string; rows: SwimmerResult[] }>();
  for (const [identity, meetEvent] of chooseMeetEventLabels(rows, meetPlaceEventKey)) {
    const field = recruitComparators(rows, meetEvent, gender);
    if (field.length > 0) fields.set(identity, { meetEvent, rows: field });
  }
  if (fields.size === 0) return null;

  return {
    events: new Set(fields.keys()),
    placeFor(event, seconds, isSameSwimmer) {
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      const held = fields.get(swimEventIdentity(event));
      if (!held) return null;
      const field = isSameSwimmer ? held.rows.filter(r => !isSameSwimmer(r)) : held.rows;
      if (field.length === 0) return null;
      // The probe is built the way `buildCatalogEntryResult` builds a scored
      // catalog row: its time is the SCY seconds, formatted.
      const probe: SwimmerResult = {
        id: 'meet-place-probe',
        rank: 0,
        name: '',
        classYear: 'UNKNOWN',
        team: '',
        time: formatSecondsToTime(seconds),
        points: 0,
        event: held.meetEvent,
        gender,
      };
      const place = placeFieldByTime([...field, probe]).get(probe);
      if (place == null) {
        // Unreachable: the probe is in the field it was placed in.
        throw new Error(`buildMeetPlaceField: no place derived for ${event}`);
      }
      return { place, fieldSize: field.length, meetEvent: held.meetEvent };
    },
  };
}

/**
 * PDF place-points mode (`usePdfPlacePoints`): score every non-recruit row
 * straight from its own `pdfPoints` column and never through the scorer
 * functions below, then interleave recruit rows into the display order by
 * time — recruits always score 0 in this mode.
 */
function scoreWithPdfPlacePoints(
  results: SwimmerResult[],
  pdfResultsPre: SwimmerResult[],
  merged: ScoringSettings
): SwimmerResult[] {
  const recruitResults = results.filter(r => r.isRecruit);
  const pdfResults = pdfResultsPre;
  const sortedPdf = [...pdfResults].sort((a, b) => {
    const tw = roundTierSort(a.roundSwam) - roundTierSort(b.roundSwam);
    if (tw !== 0) return tw;
    const ra = parseRankInt(a.rank) ?? 9999;
    const rb = parseRankInt(b.rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time);
  });
  const scoredById = new Map<string, SwimmerResult>();
  for (const r of pdfResults) {
    scoredById.set(r.id, { ...r, points: pdfPlacePointsForRow(r, merged.scoredEventNumberMax) });
  }
  const sorted: SwimmerResult[] = [];
  let pdfIdx = 0;
  recruitResults.sort((a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time));
  for (const recruit of recruitResults) {
    const recTime = convertTimeToSeconds(recruit.time);
    // `pdfIdx < sortedPdf.length` is tested first, so the read is in range.
    while (pdfIdx < sortedPdf.length && convertTimeToSeconds(itemAt(sortedPdf, pdfIdx).time) <= recTime) {
      const p = itemAt(sortedPdf, pdfIdx);
      sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
      pdfIdx++;
    }
    sorted.push({ ...recruit, rank: 0, points: 0 });
  }
  while (pdfIdx < sortedPdf.length) {
    const p = itemAt(sortedPdf, pdfIdx);
    sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
    pdfIdx++;
  }
  return sorted;
}

type CalculatePointsEventMode = {
  useMeetWideIndividualPool: boolean;
  relayPoolRule: boolean;
  processEventsChronologically: boolean;
};

/**
 * Which event-scoring dispatch `calculatePoints` needs. A meet-wide scorer
 * pool (`scorerCapScope: 'meet'`), a per-event individual/relay cap, a
 * roster-gated meet, or relay-pool eligibility all require scoring every
 * event in meet order (chronological); every preset written before
 * 2026-09-20 has none of these set and takes the independent per-event path.
 */
function resolveEventProcessingMode(merged: ScoringSettings): CalculatePointsEventMode {
  const maxIndivCap = merged.maxIndividualScorersPerTeam ?? 999;
  const maxRelayCap = merged.maxRelaysScoringPerTeam ?? 999;
  /** 18-scorer pool across the full meet (NSISC); only when scorerCapScope is 'meet'. */
  const useMeetWideIndividualPool = merged.scorerCapScope === 'meet' && maxIndivCap < 999;
  const relayPoolRule = merged.relayEligibleFromScorerPool === true && !usesScorerRoster(merged);
  const processEventsChronologically =
    useMeetWideIndividualPool ||
    relayPoolRule ||
    maxRelayCap < 999 ||
    maxIndivCap < 999 ||
    usesScorerRoster(merged);
  return { useMeetWideIndividualPool, relayPoolRule, processEventsChronologically };
}

/**
 * Score every event in `scoringPool`, in meet order. The independent path
 * (no meet-wide pool, no caps, no roster gate — every preset written before
 * 2026-09-20) scores each event's individuals and relays back to back with
 * no shared pool. The chronological path scores ALL of an event's
 * individuals before its relays, and — when relay legs draw from the
 * meet-wide pool too — seeds A/B relay legs into that pool between the two,
 * so an early relay is never evaluated against a still-empty pool.
 */
function scoreScoringPoolByEvent(
  scoringPool: SwimmerResult[],
  merged: ScoringSettings,
  meetStates: Map<string, TeamMeetState>,
  mode: CalculatePointsEventMode,
  rosterLookup: ScorerRosterLookup | undefined
): Map<string, SwimmerResult> {
  const scoredById = new Map<string, SwimmerResult>();
  const byEvent = new Map<string, SwimmerResult[]>();
  for (const r of scoringPool) {
    if (!byEvent.has(r.event)) byEvent.set(r.event, []);
    byEvent.get(r.event)!.push(r);
  }
  const sortedEvents = sortEventsByMeetOrder(Array.from(byEvent.keys()));

  if (!mode.processEventsChronologically) {
    for (const event of sortedEvents) {
      const evRows = byEvent.get(event)!;
      const indiv = evRows.filter(r => !isRelayResult(r));
      const relays = evRows.filter(r => isRelayResult(r));
      for (const row of runIndividualScoringForEvent(indiv, merged, meetStates, false, rosterLookup)) {
        scoredById.set(row.id, row);
      }
      for (const row of scoreRelaysInEvent(relays, merged, meetStates, false, rosterLookup)) {
        scoredById.set(row.id, row);
      }
    }
    return scoredById;
  }

  const runIndividuals = (event: string) => {
    const evRows = byEvent.get(event)!;
    const indiv = evRows.filter(r => !isRelayResult(r));
    for (const row of runIndividualScoringForEvent(
      indiv,
      merged,
      meetStates,
      mode.useMeetWideIndividualPool,
      rosterLookup
    )) {
      scoredById.set(row.id, row);
    }
  };
  const runRelays = (event: string) => {
    const evRows = byEvent.get(event)!;
    for (const row of scoreRelaysInEvent(
      evRows.filter(r => isRelayResult(r)),
      merged,
      meetStates,
      mode.useMeetWideIndividualPool,
      rosterLookup
    )) {
      scoredById.set(row.id, row);
    }
  };

  if (mode.relayPoolRule) {
    for (const event of sortedEvents) {
      runIndividuals(event);
      seedAbRelayLegsIntoPool(
        (byEvent.get(event) ?? []).filter(r => isRelayResult(r)),
        merged,
        meetStates
      );
      runRelays(event);
    }
  } else {
    for (const event of sortedEvents) {
      runIndividuals(event);
      runRelays(event);
    }
  }

  return scoredById;
}

/**
 * Preserve recruit interleave order (by time vs PDF) for display; recruits
 * score 0 unless `scoringPool` (in the caller) already carried them through
 * the event dispatch above.
 */
function interleaveRecruitsWithScoredResults(
  pdfResults: SwimmerResult[],
  recruitResults: SwimmerResult[],
  scoredById: Map<string, SwimmerResult>
): SwimmerResult[] {
  const sortedPdf = [...pdfResults].sort((a, b) => {
    const tw = roundTierSort(a.roundSwam) - roundTierSort(b.roundSwam);
    if (tw !== 0) return tw;
    const ra = parseRankInt(a.rank) ?? 9999;
    const rb = parseRankInt(b.rank) ?? 9999;
    if (ra !== rb) return ra - rb;
    return convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time);
  });

  const sorted: SwimmerResult[] = [];
  let pdfIdx = 0;
  recruitResults.sort((a, b) => convertTimeToSeconds(a.time) - convertTimeToSeconds(b.time));
  for (const recruit of recruitResults) {
    const recTime = convertTimeToSeconds(recruit.time);
    // `pdfIdx < sortedPdf.length` is tested first, so the read is in range.
    while (pdfIdx < sortedPdf.length && convertTimeToSeconds(itemAt(sortedPdf, pdfIdx).time) <= recTime) {
      const p = itemAt(sortedPdf, pdfIdx);
      sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
      pdfIdx++;
    }
    sorted.push(scoredById.get(recruit.id) ?? { ...recruit, rank: 0, points: 0 });
  }
  while (pdfIdx < sortedPdf.length) {
    const p = itemAt(sortedPdf, pdfIdx);
    sorted.push(scoredById.get(p.id) ?? { ...p, points: 0 });
    pdfIdx++;
  }

  return sorted;
}

export function calculatePoints(
  results: SwimmerResult[],
  settings?: ScoringSettings,
  options?: CalculatePointsOptions
): SwimmerResult[] {
  const pdfResultsPre = results.filter(r => !r.isRecruit);
  const hint = options?.resultsForPdfHint ?? pdfResultsPre;
  const merged = mergeScoringSettings(settings, {
    conference: options?.conferenceForMerge,
    resultsForPdfHint: hint,
  });
  // Meet-scoped, so it arrives with the call rather than with the conference
  // preset. An explicit option wins over a value already on the settings.
  if (options?.scoredEventNumberMax != null) {
    merged.scoredEventNumberMax = options.scoredEventNumberMax;
  }
  const usePdfScoring = effectivePdfPlacePointsMode(merged, hint);

  if (usePdfScoring) {
    return scoreWithPdfPlacePoints(results, pdfResultsPre, merged);
  }

  const mode = resolveEventProcessingMode(merged);

  const pdfResults = results.filter(r => !r.isRecruit);
  const recruitResults = results.filter(r => r.isRecruit);
  const preparedRecruits = prepareRecruitsForScoring(pdfResults, recruitResults);
  const scoringPool = [...pdfResults, ...preparedRecruits];

  const rosterLookup = usesScorerRoster(merged)
    ? buildScorerRosterLookup(scoringPool, merged, options?.scorerRosterOverrides)
    : undefined;

  const meetStates = new Map<string, TeamMeetState>();
  const scoredById = scoreScoringPoolByEvent(scoringPool, merged, meetStates, mode, rosterLookup);

  for (const r of scoringPool) {
    if (!scoredById.has(r.id)) scoredById.set(r.id, { ...r, points: 0 });
  }

  return interleaveRecruitsWithScoredResults(pdfResults, recruitResults, scoredById);
}
