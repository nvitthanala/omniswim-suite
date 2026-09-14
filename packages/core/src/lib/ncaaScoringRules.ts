/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * NCAA Swimming & Diving **Rule 7 (Scoring)** — point tables as data, and a pure
 * engine that applies them to one event.
 *
 * ## Provenance (CLAUDE.md § "Data provenance")
 *
 * Every number in this file is transcribed verbatim from:
 *
 *   NCAA Swimming & Diving Rules — Rule 7, Scoring
 *   https://meets.swimdna.org/media/ncaascoring.pdf
 *   sha256 5b98f8f69470606ea179b053b86d7fb4451f61a874c0fff5d8d18b369d6bb92e
 *   4 pages, 120,928 bytes, retrieved 2026-09-06
 *
 * The PDF is archived at `data/scoring_rules/sources/ncaascoring.pdf` alongside a
 * verbatim text extraction (`ncaascoring.rule7.txt`) and `manifest.json`. Each
 * table below quotes the rule sentence it came from. `tests/ncaaScoringRules.test.ts`
 * snapshots the tables as literals, so an upstream edition change breaks CI rather
 * than drifting silently.
 *
 * Nothing here is interpolated, extrapolated or estimated. Where the rulebook does
 * not publish a value (Rule 7-6-6's finals split; Rule 7-6-7's >24 tables; the
 * invitational table, which Rule 7-4 leaves to the host), this module reports it
 * absent or throws — it never guesses. See {@link NcaaFinalsStructure} and
 * {@link NcaaUnsourcedRuleError}.
 *
 * ## Relationship to the existing scoring pipeline
 *
 * This is a **separate, parallel** capability. `ScoringSettings` / `scoringTheory.ts`
 * / `scoringDefaults.ts` model a flat "top-N points table" for championship-style
 * meets (the NSISC preset and friends) and are deliberately untouched. Rule 7 is
 * meet-type-conditional in a way that model cannot express, so it gets its own types.
 *
 * ## Two places this implementation contradicts `plans/2026-09-06/02-data-model-and-scoring.md` §3
 *
 * That plan doc summarised Rule 7 before it was transcribed, and got two things
 * wrong. This file follows the rulebook, not the summary:
 *
 * 1. **DQ does bump the field up.** The doc says "places below are *not* bumped up".
 *    Rule 7-7-1 says the opposite, in the same words it uses for exhibition swims:
 *    "All other competitors may advance in position and shall score according to the
 *    places they achieve with the disqualified competitor(s) removed from
 *    consideration. Any remaining places and points shall be lost from the meet."
 *    What is lost is the *trailing* place — the one nobody is left to fill — not the
 *    DQ'd swimmer's place. See {@link NcaaEventScore.lostPlaces}.
 * 2. **No-show / forfeit is a meet-level state, not an entry-level one.** Rule 7-1-3
 *    is about a *team* failing to appear or being withdrawn, and the 11-0 forfeit
 *    score is a whole-dual-meet score. It is therefore modelled by
 *    {@link resolveNcaaDualMeetOutcome}, not by a flag on an entry.
 */

// ---------------------------------------------------------------------------
// Errors — pipelines fail loudly, never silently default
// ---------------------------------------------------------------------------

/** Base class for every failure this module raises, so callers can catch the family. */
export class NcaaScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NcaaScoringError';
  }
}

/**
 * Thrown when the caller asks for a value the NCAA has not published. Distinct from
 * {@link NcaaScoringError} so "we have no source for this" can never be confused with
 * "your input was malformed" — the repo's absent-vs-empty rule at the type level.
 */
export class NcaaUnsourcedRuleError extends NcaaScoringError {
  /** Rule citation whose text stops short of the value asked for. */
  readonly citation: string;

  constructor(message: string, citation: string) {
    super(message);
    this.name = 'NcaaUnsourcedRuleError';
    this.citation = citation;
  }
}

/** Thrown when the entry list handed to the engine is internally inconsistent. */
export class NcaaScoringInputError extends NcaaScoringError {
  constructor(message: string) {
    super(message);
    this.name = 'NcaaScoringInputError';
  }
}

// ---------------------------------------------------------------------------
// Format identifiers
// ---------------------------------------------------------------------------

/**
 * A meet format, in the sense Rule 7 branches on it. This is the axis that selects a
 * point table; per `02-data-model-and-scoring.md` §2 it must be captured at import
 * time, never inferred downstream from the results themselves.
 *
 * `championship-N` is the qualifying **field** size (how many competitors qualify for
 * the finals), not the number of scoring places — for 12, 16, 18 and 24 those are the
 * same number, but the distinction is what Rule 7-6 is actually keyed on.
 */
export type NcaaMeetFormat =
  /** Rule 7-1-1 — dual meet, six lanes or more. */
  | 'dual-six-lanes-or-more'
  /** Rule 7-1-2 — dual meet, five lanes or fewer. */
  | 'dual-five-lanes-or-fewer'
  /** Rule 7-1-4 — dual *diving* meet, either team with three or fewer divers. */
  | 'dual-diving-three-or-fewer'
  /** Rule 7-1-4 — dual *diving* meet, either team with four or five divers. */
  | 'dual-diving-four-or-five'
  /** Rule 7-1-4 — dual *diving* meet, both teams with six or more divers. */
  | 'dual-diving-six-or-more'
  /** Rule 7-2 — double-dual, triangular or quadrangular (one table covers all three). */
  | 'double-dual-tri-quad'
  /** Rule 7-3 — relay meet; the 14-10-8-6-4-2 table applies to *all* events. */
  | 'relay-meet'
  /** Rule 7-4 — invitational; the host publishes the table, so one must be supplied. */
  | 'invitational-host-published'
  /** Rule 7-6-1 — championships, six competitors qualify. */
  | 'championship-6'
  /** Rule 7-6-2 — championships, eight competitors qualify. */
  | 'championship-8'
  /** Rule 7-6-3 — championships, 12 competitors qualify. */
  | 'championship-12'
  /** Rule 7-6-4 — championships, 16 competitors qualify. */
  | 'championship-16'
  /** Rule 7-6-5 — championships, 18 competitors qualify. */
  | 'championship-18'
  /** Rule 7-6-6 — championships, 24 competitors qualify. */
  | 'championship-24';

/** Every format id, in rulebook order. Safe to iterate for UI pickers. */
export const NCAA_MEET_FORMATS: readonly NcaaMeetFormat[] = [
  'dual-six-lanes-or-more',
  'dual-five-lanes-or-fewer',
  'dual-diving-three-or-fewer',
  'dual-diving-four-or-five',
  'dual-diving-six-or-more',
  'double-dual-tri-quad',
  'relay-meet',
  'invitational-host-published',
  'championship-6',
  'championship-8',
  'championship-12',
  'championship-16',
  'championship-18',
  'championship-24',
] as const;

/** Qualifying field sizes Rule 7-6 publishes a table for. */
export const NCAA_CHAMPIONSHIP_FIELD_SIZES = [6, 8, 12, 16, 18, 24] as const;

export type NcaaChampionshipFieldSize = (typeof NCAA_CHAMPIONSHIP_FIELD_SIZES)[number];

/**
 * Map a qualifying field size to its format id.
 *
 * Throws {@link NcaaUnsourcedRuleError} for any other size. Rule 7-6-7 says a field
 * larger than 24 "shall model the pattern reflected in Rules 7-6-3, 7-6-4, 7-6-5 and
 * 7-6-6" but publishes no table — so there is nothing to return, and inventing one by
 * continuing the pattern is exactly the fabrication this repo forbids.
 */
export function ncaaChampionshipFormatForFieldSize(fieldSize: number): NcaaMeetFormat {
  switch (fieldSize) {
    case 6:
      return 'championship-6';
    case 8:
      return 'championship-8';
    case 12:
      return 'championship-12';
    case 16:
      return 'championship-16';
    case 18:
      return 'championship-18';
    case 24:
      return 'championship-24';
    default:
      throw new NcaaUnsourcedRuleError(
        `NCAA Rule 7-6 publishes championship point tables only for qualifying fields of ` +
          `${NCAA_CHAMPIONSHIP_FIELD_SIZES.join(', ')} competitors; ${fieldSize} is not sourced. ` +
          `Rule 7-6-7 directs fields larger than 24 to "model the pattern" of Rules 7-6-3 ` +
          `through 7-6-6 but publishes no table, so none is implemented.`,
        'NCAA Rule 7-6-7'
      );
  }
}

// ---------------------------------------------------------------------------
// Point tables
// ---------------------------------------------------------------------------

/** Individual vs relay — Rule 7 publishes a separate table for each, per format. */
export type NcaaEventKind = 'individual' | 'relay';

/**
 * One published point table.
 *
 * `places[i]` is the value for place `i + 1`. Values are transcribed exactly as
 * printed, **including a trailing zero** where the rulebook prints one (Rule 7-1-1's
 * "9-4-3-2-1-0" really is six values). A place past the end of the array scores 0 —
 * mechanically the same as a printed trailing zero, so both spellings are safe.
 */
export interface NcaaPointTable {
  readonly places: readonly number[];
  /**
   * How many entries from one team may score in this event, or `null` where the rule
   * states no cap. Rule 7-1-1: "with only the best three contestants from each team
   * scoring"; "with only the best two relays from each team scoring".
   */
  readonly maxScorersPerTeam: number | null;
  /** Rule citation, e.g. `'NCAA Rule 7-1-1'`. */
  readonly citation: string;
  /** Verbatim sentence this table was transcribed from. */
  readonly rule: string;
}

/**
 * Stands in for a table the NCAA does not publish. Rule 7-4: "The scoring of place
 * values in invitational meets shall be established and published in advance by the
 * host institution." There is no NCAA default to fall back on, so this carries no
 * numbers — the host's table must be supplied per event.
 */
export interface NcaaHostPublishedTable {
  readonly kind: 'host-published';
  readonly citation: string;
  readonly rule: string;
}

export type NcaaTableSlot = NcaaPointTable | NcaaHostPublishedTable;

export function isNcaaHostPublishedTable(slot: NcaaTableSlot): slot is NcaaHostPublishedTable {
  return 'kind' in slot && slot.kind === 'host-published';
}

// ---------------------------------------------------------------------------
// Finals structure
// ---------------------------------------------------------------------------

/** Which final an entry swam in. */
export type NcaaFinalTier = 'championship' | 'consolation';

/**
 * A final and the inclusive place range it contests.
 *
 * Rule 7-6-8 (Consolation Limits): "A competitor in a consolation final cannot
 * advance, either by time or by disqualification in the championships final, to any
 * place higher than the highest place being contested in the consolation final." That
 * cap is `firstPlace` — the pool boundary is load-bearing, not cosmetic.
 */
export interface NcaaFinalPool {
  readonly final: NcaaFinalTier;
  readonly firstPlace: number;
  readonly lastPlace: number;
}

/**
 * The single pool a format without a consolation final scores from — and the pool a
 * time-final event scores from in any format (Rule 5-7-4-a). `lastPlace` is the length
 * of the point table, since every place the table publishes is contested by the one field.
 */
function singlePool(placeCount: number): readonly NcaaFinalPool[] {
  return [{ final: 'championship', firstPlace: 1, lastPlace: placeCount }];
}

/**
 * How a format's places are divided between finals.
 *
 * - `single-pool` — one field decides every place (duals, tri/quad, relay meets, and
 *   the 6- and 8-competitor championships, which have no consolation final).
 * - `split` — Rule 7-6 assigns disjoint place ranges to separate finals, and they are
 *   **never merged or re-ranked by raw time across the two**.
 * - `unsourced-split` — the table is published but the split is not. Scoring a
 *   multi-final event in such a format throws.
 */
export type NcaaFinalsStructure =
  | { readonly kind: 'single-pool' }
  | {
      readonly kind: 'split';
      readonly pools: readonly NcaaFinalPool[];
      /**
       * `explicit` — the rule names the place range for each final in so many words.
       * `derived-from-heat-size` — the rule states the scoring competitors per heat
       * and the qualifying field size, and the ranges follow from those two published
       * numbers by division. Still sourced; flagged so a reviewer can see which is which.
       */
      readonly provenance: 'explicit' | 'derived-from-heat-size';
      readonly citation: string;
      readonly rule: string;
    }
  | {
      readonly kind: 'unsourced-split';
      readonly citation: string;
      readonly reason: string;
    };

// ---------------------------------------------------------------------------
// Per-format rulesets — the transcribed data
// ---------------------------------------------------------------------------

export interface NcaaFormatRuleset {
  readonly format: NcaaMeetFormat;
  readonly label: string;
  readonly individual: NcaaTableSlot;
  /** `null` where the format contests no relays at all (the diving dual tables). */
  readonly relay: NcaaTableSlot | null;
  readonly finals: NcaaFinalsStructure;
}

const SINGLE_POOL: NcaaFinalsStructure = { kind: 'single-pool' };

const HOST_PUBLISHED: NcaaHostPublishedTable = {
  kind: 'host-published',
  citation: 'NCAA Rule 7-4',
  rule:
    'The scoring of place values in invitational meets shall be established and ' +
    'published in advance by the host institution.',
};

/**
 * Rule 7 point tables, keyed by format.
 *
 * Source: https://meets.swimdna.org/media/ncaascoring.pdf
 * (sha256 5b98f8f69470606ea179b053b86d7fb4451f61a874c0fff5d8d18b369d6bb92e)
 */
export const NCAA_FORMAT_RULESETS: Readonly<Record<NcaaMeetFormat, NcaaFormatRuleset>> = {
  // Rule 7-1-1: "When using six lanes or more, the scoring of place values in dual
  // meets shall be: relays, 11-4-2-0, with only the best two relays from each team
  // scoring; individual events, 9-4-3-2-1-0, with only the best three contestants
  // from each team scoring."
  'dual-six-lanes-or-more': {
    format: 'dual-six-lanes-or-more',
    label: 'Dual meet — six lanes or more',
    individual: {
      places: [9, 4, 3, 2, 1, 0],
      maxScorersPerTeam: 3,
      citation: 'NCAA Rule 7-1-1',
      rule:
        'When using six lanes or more, the scoring of place values in dual meets shall be: ' +
        'relays, 11-4-2-0, with only the best two relays from each team scoring; individual ' +
        'events, 9-4-3-2-1-0, with only the best three contestants from each team scoring.',
    },
    relay: {
      places: [11, 4, 2, 0],
      maxScorersPerTeam: 2,
      citation: 'NCAA Rule 7-1-1',
      rule:
        'When using six lanes or more, the scoring of place values in dual meets shall be: ' +
        'relays, 11-4-2-0, with only the best two relays from each team scoring; individual ' +
        'events, 9-4-3-2-1-0, with only the best three contestants from each team scoring.',
    },
    finals: SINGLE_POOL,
  },

  // Rule 7-1-2: "When using five lanes or fewer, the scoring of place values in dual
  // meets shall be: relays, 7-0; individual events, 5-3-1-0, with only the best two
  // contestants from each team scoring."
  //
  // Note the asymmetry, transcribed as printed: the rule states a per-team cap for
  // individual events and states none for relays. It is not restated from 7-1-1, so
  // `maxScorersPerTeam` is null here rather than 2 — an absent rule, not a copied one.
  'dual-five-lanes-or-fewer': {
    format: 'dual-five-lanes-or-fewer',
    label: 'Dual meet — five lanes or fewer',
    individual: {
      places: [5, 3, 1, 0],
      maxScorersPerTeam: 2,
      citation: 'NCAA Rule 7-1-2',
      rule:
        'When using five lanes or fewer, the scoring of place values in dual meets shall be: ' +
        'relays, 7-0; individual events, 5-3-1-0, with only the best two contestants from ' +
        'each team scoring.',
    },
    relay: {
      places: [7, 0],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-1-2',
      rule:
        'When using five lanes or fewer, the scoring of place values in dual meets shall be: ' +
        'relays, 7-0; individual events, 5-3-1-0, with only the best two contestants from ' +
        'each team scoring.',
    },
    finals: SINGLE_POOL,
  },

  // Rule 7-1-4: "In dual diving meets when either team has three or fewer total
  // participants per gender, the scoring of individual event place values shall be
  // 7-5-4-3-2-1, with only the best three contestants from each team scoring."
  'dual-diving-three-or-fewer': {
    format: 'dual-diving-three-or-fewer',
    label: 'Dual diving meet — a team with three or fewer divers',
    individual: {
      places: [7, 5, 4, 3, 2, 1],
      maxScorersPerTeam: 3,
      citation: 'NCAA Rule 7-1-4',
      rule:
        'In dual diving meets when either team has three or fewer total participants per ' +
        'gender, the scoring of individual event place values shall be 7-5-4-3-2-1, with ' +
        'only the best three contestants from each team scoring.',
    },
    relay: null,
    finals: SINGLE_POOL,
  },

  // Rule 7-1-4: "In dual diving meets when either team has four or five total
  // participants per gender, the scoring of individual event place values shall be
  // 9-7-6-5-3-2-1, with only the best four contestants from each team scoring."
  'dual-diving-four-or-five': {
    format: 'dual-diving-four-or-five',
    label: 'Dual diving meet — a team with four or five divers',
    individual: {
      places: [9, 7, 6, 5, 3, 2, 1],
      maxScorersPerTeam: 4,
      citation: 'NCAA Rule 7-1-4',
      rule:
        'In dual diving meets when either team has four or five total participants per ' +
        'gender, the scoring of individual event place values shall be 9-7-6-5-3-2-1, with ' +
        'only the best four contestants from each team scoring.',
    },
    relay: null,
    finals: SINGLE_POOL,
  },

  // Rule 7-1-4: "In dual diving meets when both teams have six or more total
  // participants per gender, the scoring of individual event place values shall be
  // 16-13-12-11-10-9-7-5-4-3-2-1, with only the best six contestants from each team
  // scoring."
  'dual-diving-six-or-more': {
    format: 'dual-diving-six-or-more',
    label: 'Dual diving meet — both teams with six or more divers',
    individual: {
      places: [16, 13, 12, 11, 10, 9, 7, 5, 4, 3, 2, 1],
      maxScorersPerTeam: 6,
      citation: 'NCAA Rule 7-1-4',
      rule:
        'In dual diving meets when both teams have six or more total participants per ' +
        'gender, the scoring of individual event place values shall be ' +
        '16-13-12-11-10-9-7-5-4-3-2-1, with only the best six contestants from each team ' +
        'scoring.',
    },
    relay: null,
    finals: SINGLE_POOL,
  },

  // Rule 7-2: "In double-dual, triangular or quadrangular meets regardless of the
  // number of heats, the scoring shall be 9-4-3-2-1 for individual events with no team
  // scoring more than three individuals, and 11-4-2 for relays with no team scoring
  // more than two relay teams."
  'double-dual-tri-quad': {
    format: 'double-dual-tri-quad',
    label: 'Double-dual, triangular or quadrangular meet',
    individual: {
      places: [9, 4, 3, 2, 1],
      maxScorersPerTeam: 3,
      citation: 'NCAA Rule 7-2',
      rule:
        'In double-dual, triangular or quadrangular meets regardless of the number of heats, ' +
        'the scoring shall be 9-4-3-2-1 for individual events with no team scoring more than ' +
        'three individuals, and 11-4-2 for relays with no team scoring more than two relay teams.',
    },
    relay: {
      places: [11, 4, 2],
      maxScorersPerTeam: 2,
      citation: 'NCAA Rule 7-2',
      rule:
        'In double-dual, triangular or quadrangular meets regardless of the number of heats, ' +
        'the scoring shall be 9-4-3-2-1 for individual events with no team scoring more than ' +
        'three individuals, and 11-4-2 for relays with no team scoring more than two relay teams.',
    },
    finals: SINGLE_POOL,
  },

  // Rule 7-3: "The scoring of place values in relay meets shall be 14-10-8-6-4-2 for
  // all events." One table, both event kinds — hence the same values under `individual`.
  'relay-meet': {
    format: 'relay-meet',
    label: 'Relay meet',
    individual: {
      places: [14, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-3',
      rule: 'The scoring of place values in relay meets shall be 14-10-8-6-4-2 for all events.',
    },
    relay: {
      places: [14, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-3',
      rule: 'The scoring of place values in relay meets shall be 14-10-8-6-4-2 for all events.',
    },
    finals: SINGLE_POOL,
  },

  'invitational-host-published': {
    format: 'invitational-host-published',
    label: 'Invitational meet — host-published table',
    individual: HOST_PUBLISHED,
    relay: HOST_PUBLISHED,
    finals: SINGLE_POOL,
  },

  // Rule 7-6-1: "When six competitors qualify for the finals of a championships meet,
  // the scoring of place values shall be: relays, 14-10-8-6-4-2; individual events,
  // 7-5-4-3-2-1."
  //
  // No consolation final is described for a six-competitor field, so one pool.
  'championship-6': {
    format: 'championship-6',
    label: 'Championships — six competitors qualify',
    individual: {
      places: [7, 5, 4, 3, 2, 1],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-1',
      rule:
        'When six competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, 14-10-8-6-4-2; individual events, 7-5-4-3-2-1.',
    },
    relay: {
      places: [14, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-1',
      rule:
        'When six competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, 14-10-8-6-4-2; individual events, 7-5-4-3-2-1.',
    },
    finals: SINGLE_POOL,
  },

  // Rule 7-6-2: "When eight competitors qualify for the finals of a championships meet,
  // the scoring of place values shall be: relays, 18-14-12-10-8-6-4-2; individual
  // events, 9-7-6-5-4-3-2-1."
  //
  // No consolation final is described for an eight-competitor field, so one pool. The
  // championship/consolation split first appears at 12 (Rule 7-6-3).
  'championship-8': {
    format: 'championship-8',
    label: 'Championships — eight competitors qualify',
    individual: {
      places: [9, 7, 6, 5, 4, 3, 2, 1],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-2',
      rule:
        'When eight competitors qualify for the finals of a championships meet, the scoring ' +
        'of place values shall be: relays, 18-14-12-10-8-6-4-2; individual events, ' +
        '9-7-6-5-4-3-2-1.',
    },
    relay: {
      places: [18, 14, 12, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-2',
      rule:
        'When eight competitors qualify for the finals of a championships meet, the scoring ' +
        'of place values shall be: relays, 18-14-12-10-8-6-4-2; individual events, ' +
        '9-7-6-5-4-3-2-1.',
    },
    finals: SINGLE_POOL,
  },

  // Rule 7-6-3: "When 12 competitors qualify for the finals of a championships meet,
  // the scoring of place values shall be: relays, 32-26-24-22-20-18-14-10-8-6-4-2;
  // individual events, 16-13-12-11-10-9-7-5-4-3-2-1.
  // Except in time final events (see Rule 5-7-4-a), points for first through sixth
  // place shall be awarded solely on the basis of a championships final. Points for
  // seventh through 12th place shall be awarded solely on the basis of a consolation
  // final."
  'championship-12': {
    format: 'championship-12',
    label: 'Championships — 12 competitors qualify',
    individual: {
      places: [16, 13, 12, 11, 10, 9, 7, 5, 4, 3, 2, 1],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-3',
      rule:
        'When 12 competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, 32-26-24-22-20-18-14-10-8-6-4-2; individual events, ' +
        '16-13-12-11-10-9-7-5-4-3-2-1.',
    },
    relay: {
      places: [32, 26, 24, 22, 20, 18, 14, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-3',
      rule:
        'When 12 competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, 32-26-24-22-20-18-14-10-8-6-4-2; individual events, ' +
        '16-13-12-11-10-9-7-5-4-3-2-1.',
    },
    finals: {
      kind: 'split',
      provenance: 'explicit',
      pools: [
        { final: 'championship', firstPlace: 1, lastPlace: 6 },
        { final: 'consolation', firstPlace: 7, lastPlace: 12 },
      ],
      citation: 'NCAA Rule 7-6-3',
      rule:
        'Except in time final events (see Rule 5-7-4-a), points for first through sixth place ' +
        'shall be awarded solely on the basis of a championships final. Points for seventh ' +
        'through 12th place shall be awarded solely on the basis of a consolation final.',
    },
  },

  // Rule 7-6-4: "When 16 competitors qualify for the finals of a championships meet,
  // the scoring of place values shall be: relays,
  // 40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2; individual events,
  // 20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1.
  // Except in time final events (see Rule 5-7-4-a), points for first through eighth
  // place shall be awarded solely on the basis of a championships final. Points for
  // ninth through 16th place shall be awarded solely on the basis of a consolation final."
  'championship-16': {
    format: 'championship-16',
    label: 'Championships — 16 competitors qualify',
    individual: {
      places: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-4',
      rule:
        'When 16 competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, 40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2; ' +
        'individual events, 20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1.',
    },
    relay: {
      places: [40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-4',
      rule:
        'When 16 competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, 40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2; ' +
        'individual events, 20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1.',
    },
    finals: {
      kind: 'split',
      provenance: 'explicit',
      pools: [
        { final: 'championship', firstPlace: 1, lastPlace: 8 },
        { final: 'consolation', firstPlace: 9, lastPlace: 16 },
      ],
      citation: 'NCAA Rule 7-6-4',
      rule:
        'Except in time final events (see Rule 5-7-4-a), points for first through eighth place ' +
        'shall be awarded solely on the basis of a championships final. Points for ninth ' +
        'through 16th place shall be awarded solely on the basis of a consolation final.',
    },
  },

  // Rule 7-6-5: "When 18 competitors qualify for the finals of a championships meet,
  // (nine scoring competitors per heat), the scoring of place values shall be: relays,
  // 44-38-36-34-32-30-28-26-24-20-16-14-12-10-8-6-4-2; individual events,
  // 22-19-18-17-16-15-14-13-12-10-8-7-6-5-4-3-2-1."
  //
  // Unlike 7-6-3 and 7-6-4, this article does not spell out the place range of each
  // final. It does publish the heat size — "nine scoring competitors per heat" — and
  // the field size, 18. Two heats of nine gives championship 1-9 and consolation 10-18
  // by division of two published numbers, so the split is marked
  // `derived-from-heat-size` rather than `explicit`: sourced, but one step removed.
  'championship-18': {
    format: 'championship-18',
    label: 'Championships — 18 competitors qualify',
    individual: {
      places: [22, 19, 18, 17, 16, 15, 14, 13, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-5',
      rule:
        'When 18 competitors qualify for the finals of a championships meet, (nine scoring ' +
        'competitors per heat), the scoring of place values shall be: relays, ' +
        '44-38-36-34-32-30-28-26-24-20-16-14-12-10-8-6-4-2; individual events, ' +
        '22-19-18-17-16-15-14-13-12-10-8-7-6-5-4-3-2-1.',
    },
    relay: {
      places: [44, 38, 36, 34, 32, 30, 28, 26, 24, 20, 16, 14, 12, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-5',
      rule:
        'When 18 competitors qualify for the finals of a championships meet, (nine scoring ' +
        'competitors per heat), the scoring of place values shall be: relays, ' +
        '44-38-36-34-32-30-28-26-24-20-16-14-12-10-8-6-4-2; individual events, ' +
        '22-19-18-17-16-15-14-13-12-10-8-7-6-5-4-3-2-1.',
    },
    finals: {
      kind: 'split',
      provenance: 'derived-from-heat-size',
      pools: [
        { final: 'championship', firstPlace: 1, lastPlace: 9 },
        { final: 'consolation', firstPlace: 10, lastPlace: 18 },
      ],
      citation: 'NCAA Rule 7-6-5',
      rule:
        'When 18 competitors qualify for the finals of a championships meet, (nine scoring ' +
        'competitors per heat) ...',
    },
  },

  // Rule 7-6-6: "When 24 competitors qualify for the finals of a championships meet,
  // the scoring of place values shall be: relays,
  // 64-56-54-52-50-48-46-44-40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2; individual
  // events, 32-28-27-26-25-24-23-22-20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1."
  //
  // The tables are published; the finals split is NOT. Article 6 states no place
  // ranges and no heat size, and Article 7's "model the pattern" applies to fields
  // *larger* than 24, not to 24 itself. The obvious reading — three heats of eight —
  // would be an inference, so it is not encoded. Scoring a multi-final event in this
  // format throws {@link NcaaUnsourcedRuleError}; a time-final event (one pool by rule)
  // scores normally, since the table itself is sourced.
  'championship-24': {
    format: 'championship-24',
    label: 'Championships — 24 competitors qualify',
    individual: {
      places: [32, 28, 27, 26, 25, 24, 23, 22, 20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-6',
      rule:
        'When 24 competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, ' +
        '64-56-54-52-50-48-46-44-40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2; individual ' +
        'events, 32-28-27-26-25-24-23-22-20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1.',
    },
    relay: {
      places: [64, 56, 54, 52, 50, 48, 46, 44, 40, 34, 32, 30, 28, 26, 24, 22, 18, 14, 12, 10, 8, 6, 4, 2],
      maxScorersPerTeam: null,
      citation: 'NCAA Rule 7-6-6',
      rule:
        'When 24 competitors qualify for the finals of a championships meet, the scoring of ' +
        'place values shall be: relays, ' +
        '64-56-54-52-50-48-46-44-40-34-32-30-28-26-24-22-18-14-12-10-8-6-4-2; individual ' +
        'events, 32-28-27-26-25-24-23-22-20-17-16-15-14-13-12-11-9-7-6-5-4-3-2-1.',
    },
    finals: {
      kind: 'unsourced-split',
      citation: 'NCAA Rule 7-6-6',
      reason:
        'Rule 7-6-6 publishes the 24-competitor point tables but does not state which place ' +
        'range each final contests, and unlike Rule 7-6-5 it names no per-heat scoring size. ' +
        'Splitting the field (e.g. three heats of eight) would be an inference, not a ' +
        'transcription, so it is left unsourced. Score 24-competitor events as time finals, ' +
        'or supply the host meet’s published finals structure explicitly.',
    },
  },
};

/** Look up a format's ruleset. Throws on an unknown id rather than defaulting. */
export function ncaaRulesetForFormat(format: NcaaMeetFormat): NcaaFormatRuleset {
  const ruleset = NCAA_FORMAT_RULESETS[format];
  if (!ruleset) {
    throw new NcaaScoringInputError(
      `Unknown NCAA meet format "${String(format)}". Known formats: ${NCAA_MEET_FORMATS.join(', ')}.`
    );
  }
  return ruleset;
}

/**
 * Resolve the point table for one event.
 *
 * `hostPublishedTable` is required for `invitational-host-published` (Rule 7-4 leaves
 * the table to the host, so there is nothing to default to) and is accepted for any
 * other format as a deliberate, caller-supplied override of the NCAA table.
 */
export function resolveNcaaPointTable(
  format: NcaaMeetFormat,
  eventKind: NcaaEventKind,
  hostPublishedTable?: NcaaPointTable
): NcaaPointTable {
  const ruleset = ncaaRulesetForFormat(format);
  const slot = eventKind === 'relay' ? ruleset.relay : ruleset.individual;

  // Checked before the override: "this format contests no relays" is a structural fact
  // about the meet, not a missing table a host could publish their way out of.
  if (slot === null) {
    throw new NcaaScoringInputError(
      `Format "${format}" (${ruleset.label}) contests no relay events, so it has no relay ` +
        `point table. Rule 7-1-4 covers diving dual meets only.`
    );
  }

  if (hostPublishedTable) {
    assertValidPointTable(hostPublishedTable);
    return hostPublishedTable;
  }

  if (isNcaaHostPublishedTable(slot)) {
    throw new NcaaUnsourcedRuleError(
      `${slot.citation}: "${slot.rule}" The NCAA publishes no invitational point table, so ` +
        `one must be supplied via the \`hostPublishedTable\` option. There is no default to ` +
        `fall back on.`,
      slot.citation
    );
  }
  return slot;
}

function assertValidPointTable(table: NcaaPointTable): void {
  if (!Array.isArray(table.places) || table.places.length === 0) {
    throw new NcaaScoringInputError('A point table must list at least one place value.');
  }
  for (const [index, value] of table.places.entries()) {
    if (!Number.isFinite(value) || value < 0) {
      throw new NcaaScoringInputError(
        `Point table value for place ${index + 1} is ${String(value)}; place values must be ` +
          `finite and non-negative.`
      );
    }
  }
  if (table.maxScorersPerTeam !== null) {
    if (!Number.isInteger(table.maxScorersPerTeam) || table.maxScorersPerTeam < 1) {
      throw new NcaaScoringInputError(
        `maxScorersPerTeam must be a positive integer or null (no cap in the rule); got ` +
          `${String(table.maxScorersPerTeam)}.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Entry input
// ---------------------------------------------------------------------------

/**
 * Why an entry does or does not score. Each value is a distinct, explicitly-declared
 * state — never inferred from a time, a place, or a missing field.
 *
 * - `scoring` — swam and is eligible for points.
 * - `exhibition` — Rule 7-10-1: "Exhibition swims shall not be scored in any event.
 *   All competitors who are not designated by their coaches to be exhibition swimmers
 *   shall score according to the places they achieve with the exhibition swimmers
 *   removed from consideration."
 * - `disqualified` — Rule 7-7: the DQ scores nothing and everyone behind advances.
 * - `did-not-compete` — Rule 7-9: "No competitor may score points in an event in which
 *   the competitor does not compete." A scratch or no-swim never occupied a place.
 *
 * A team-level no-show or forfeit is **not** one of these; it is a meet-level state.
 * See {@link resolveNcaaDualMeetOutcome}.
 */
export type NcaaEntryStatus = 'scoring' | 'exhibition' | 'disqualified' | 'did-not-compete';

/** One entry (an athlete's swim, or a team's relay unit) in a single event. */
export interface NcaaScoringEntry {
  /** Unique within the event; used to match output rows back to input. */
  readonly id: string;
  /** Scoring team. Compared by exact string, so normalise upstream if needed. */
  readonly team: string;
  /**
   * 1-based finish rank **within this entry's final**, counting every entry that swam
   * — exhibition swims included, because the rulebook removes them from consideration
   * only when awarding places, not from the race.
   *
   * Tied entries share a rank. Both common conventions work: standard competition
   * ranking (`1, 2, 2, 4`) and dense ranking (`1, 2, 2, 3`) produce identical output,
   * because the engine re-ranks from scratch. `did-not-compete` entries may use any
   * positive rank; they are dropped before ranking.
   */
  readonly finishRank: number;
  /** Defaults to `'scoring'`. */
  readonly status?: NcaaEntryStatus;
  /**
   * Which final this entry swam in. Required for every entry when the format splits
   * finals and the event is not a time final; must be omitted or `'championship'`
   * otherwise. Never guessed from the finish rank.
   */
  readonly final?: NcaaFinalTier;
}

/** Options for {@link computeNcaaEventScoring}. */
export interface NcaaScoringOptions {
  /**
   * Rule 7-6-3/7-6-4 both begin "Except in time final events (see Rule 5-7-4-a)". When
   * true, the event is scored as one pool ranked across the whole field even in a
   * format that otherwise splits finals — and the consolation cap does not apply,
   * because there is no consolation final.
   */
  readonly timeFinal?: boolean;
  /**
   * The host's table, for `invitational-host-published` (Rule 7-4) or as a deliberate
   * override elsewhere. Supplying this for an NCAA-tabled format replaces the NCAA table.
   */
  readonly hostPublishedTable?: NcaaPointTable;
  /**
   * How a finisher beyond their team's `maxScorersPerTeam` affects the entries behind them.
   *
   * - `'holds-place'` (default) — the over-cap finisher keeps the place they achieved
   *   and scores 0; entries behind them do **not** move up, and that place's points are
   *   lost from the meet.
   * - `'removed-from-consideration'` — the over-cap finisher is treated like an
   *   exhibition swim: dropped before places are computed, so entries behind them advance.
   *
   * The default is the literal reading of the rulebook. Rule 7-1-1 says only "with
   * only the best three contestants from each team scoring" — it does not say "removed
   * from consideration", the phrase Rules 7-7-1 and 7-10-1 use precisely where they DO
   * intend re-ranking. The alternative is exposed because that inference is the one
   * genuinely arguable point in this module; flip it deliberately, with a source.
   */
  readonly overCapBehavior?: 'holds-place' | 'removed-from-consideration';
}

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

/**
 * Why an entry scored zero (or took no place). `null` means the entry took a place and
 * received that place's value — which may itself legitimately be 0, e.g. sixth place in
 * Rule 7-1-1's 9-4-3-2-1-0. A zero with a reason and a zero from the table are
 * different facts, and are kept distinguishable.
 */
export type NcaaScoringReason =
  | 'disqualified'
  | 'exhibition'
  | 'did-not-compete'
  | 'over-team-scorer-cap'
  | 'place-outside-point-table';

export interface NcaaScoredEntry {
  readonly id: string;
  readonly team: string;
  readonly status: NcaaEntryStatus;
  /** The final this entry swam in, or `null` when the event was scored as one pool. */
  readonly final: NcaaFinalTier | null;
  /**
   * Place awarded after removing entries not under consideration, or `null` when the
   * entry took no place at all (exhibition, did-not-compete, disqualified).
   */
  readonly place: number | null;
  /**
   * The consecutive places a tie occupies, inclusive, when this entry is part of one;
   * `null` when it is not tied. Rule 7-8 divides the combined value of these places.
   */
  readonly tiedPlaces: readonly number[] | null;
  readonly points: number;
  readonly reason: NcaaScoringReason | null;
}

/** A place that was contested but whose points nobody received. */
export interface NcaaLostPlace {
  readonly place: number;
  readonly points: number;
  readonly final: NcaaFinalTier | null;
  readonly cause: 'no-eligible-finisher' | 'over-team-scorer-cap';
}

export interface NcaaTeamTotal {
  readonly team: string;
  readonly points: number;
}

export interface NcaaEventScore {
  readonly format: NcaaMeetFormat;
  readonly eventKind: NcaaEventKind;
  readonly table: NcaaPointTable;
  /** The pools places were drawn from. One entry when the event scored as a single pool. */
  readonly pools: readonly NcaaFinalPool[];
  /** One row per input entry, in input order. */
  readonly entries: readonly NcaaScoredEntry[];
  /** Team totals, highest first, ties broken by team name. Rounded to 6 decimals. */
  readonly teamTotals: readonly NcaaTeamTotal[];
  /**
   * Rule 7-7: "Any remaining places and points shall be lost from the meet." Populated
   * only for pools that had at least one entry.
   */
  readonly lostPlaces: readonly NcaaLostPlace[];
  readonly pointsAwarded: number;
  readonly pointsLost: number;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** Kills float noise from tie division without disturbing exact halves. */
function roundPoints(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function pointsForPlace(table: NcaaPointTable, place: number): number {
  const value = table.places[place - 1];
  return value === undefined ? 0 : value;
}

/**
 * Resolve the finals pools this event scores from.
 *
 * `placeCount` bounds the single-pool case — pass the resolved table's `places.length`
 * (as {@link computeNcaaEventScoring} does) so `lastPlace` is a real number rather than
 * an open range. Omitted, the single pool's `lastPlace` is
 * `Number.MAX_SAFE_INTEGER`, meaning "every place the table publishes".
 *
 * @throws {NcaaUnsourcedRuleError} when a format's table is published but its finals
 *   split is not (Rule 7-6-6) and the caller has not declared the event a time final.
 */
export function resolveNcaaFinalPools(
  format: NcaaMeetFormat,
  opts: { timeFinal?: boolean; placeCount?: number } = {}
): readonly NcaaFinalPool[] {
  const ruleset = ncaaRulesetForFormat(format);
  const finals = ruleset.finals;

  if (opts.timeFinal === true || finals.kind === 'single-pool') {
    return singlePool(opts.placeCount ?? Number.MAX_SAFE_INTEGER);
  }
  if (finals.kind === 'unsourced-split') {
    throw new NcaaUnsourcedRuleError(`${finals.citation}: ${finals.reason}`, finals.citation);
  }
  return finals.pools;
}

interface RankedRow {
  readonly entry: NcaaScoringEntry;
  readonly index: number;
}

/**
 * Score one event under an NCAA Rule 7 point table.
 *
 * Pure and network-free. The pipeline, in the order the rulebook applies it:
 *
 * 1. **Remove from consideration** every entry that is not `scoring` — exhibition
 *    swims (Rule 7-10-1), disqualifications (Rule 7-7) and non-competitors (Rule 7-9).
 *    All three use the same mechanism: the rulebook says the remaining competitors
 *    "score according to the places they achieve with [them] removed from
 *    consideration". An exhibition swim therefore never consumes a scoring slot, and a
 *    DQ does not freeze the field behind it.
 * 2. **Split by final.** Each pool is ranked and awarded independently; places are never
 *    merged or re-ranked by raw time across two finals (Rules 7-6-3, 7-6-4). A
 *    consolation swimmer can therefore never reach a place the championship final
 *    contests, which is Rule 7-6-8's consolation cap falling straight out of the model
 *    rather than being bolted on.
 * 3. **Award places** within each pool from that pool's `firstPlace`, splitting ties
 *    evenly across the places they occupy (Rule 7-8).
 * 4. **Apply the per-team scorer cap** (Rule 7-1-1, 7-1-2, 7-1-4, 7-2), see
 *    {@link NcaaScoringOptions.overCapBehavior}.
 * 5. **Record lost places** — contested places nobody received points for.
 *
 * @throws {NcaaScoringInputError} on duplicate ids, a non-positive finish rank, a
 *   missing or contradictory `final`, or a relay event in a diving-dual format.
 * @throws {NcaaUnsourcedRuleError} when the format's table or finals split is not
 *   published by the NCAA.
 */
export function computeNcaaEventScoring(
  format: NcaaMeetFormat,
  eventKind: NcaaEventKind,
  entries: readonly NcaaScoringEntry[],
  opts: NcaaScoringOptions = {}
): NcaaEventScore {
  const ruleset = ncaaRulesetForFormat(format);
  const table = resolveNcaaPointTable(format, eventKind, opts.hostPublishedTable);
  const pools = resolveNcaaFinalPools(format, {
    timeFinal: opts.timeFinal,
    placeCount: table.places.length,
  });
  const splitsFinals = pools.length > 1;
  const overCapBehavior = opts.overCapBehavior ?? 'holds-place';

  // --- Validate input. Fail loudly; never repair. ---
  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.id)) {
      throw new NcaaScoringInputError(
        `Duplicate entry id "${entry.id}" in one event; entry ids must be unique.`
      );
    }
    seenIds.add(entry.id);

    if (!Number.isInteger(entry.finishRank) || entry.finishRank < 1) {
      throw new NcaaScoringInputError(
        `Entry "${entry.id}" has finishRank ${String(entry.finishRank)}; it must be a ` +
          `positive integer (1 = first to touch within its final).`
      );
    }

    if (splitsFinals) {
      if (entry.final === undefined) {
        throw new NcaaScoringInputError(
          `Format "${format}" (${ruleset.label}) awards places from separate finals ` +
            `(${pools.map(p => `${p.final} ${p.firstPlace}-${p.lastPlace}`).join(', ')}), so ` +
            `entry "${entry.id}" must declare which final it swam in. It is never inferred ` +
            `from the finish rank. Pass \`timeFinal: true\` for a time-final event ` +
            `(Rule 5-7-4-a).`
        );
      }
      if (!pools.some(pool => pool.final === entry.final)) {
        throw new NcaaScoringInputError(
          `Entry "${entry.id}" declares final "${entry.final}", which format "${format}" does ` +
            `not contest. Contested finals: ${pools.map(p => p.final).join(', ')}.`
        );
      }
    } else if (entry.final !== undefined && entry.final !== 'championship') {
      throw new NcaaScoringInputError(
        `Entry "${entry.id}" declares final "${entry.final}", but ` +
          (opts.timeFinal === true
            ? `this event was scored as a time final (Rule 5-7-4-a), which has one pool.`
            : `format "${format}" (${ruleset.label}) contests a single pool of places.`)
      );
    }
  }

  // --- Award places, pool by pool. ---
  const awarded = new Map<string, { place: number; tiedPlaces: number[]; rawPoints: number }>();
  const lostPlaces: NcaaLostPlace[] = [];
  const poolLabel = (pool: NcaaFinalPool): NcaaFinalTier | null => (splitsFinals ? pool.final : null);

  for (const pool of pools) {
    const inPool = entries
      .map((entry, index): RankedRow => ({ entry, index }))
      .filter(row => (splitsFinals ? row.entry.final === pool.final : true));
    if (inPool.length === 0) continue;

    // Step 1 — remove from consideration.
    const considered = inPool.filter(row => (row.entry.status ?? 'scoring') === 'scoring');

    // Step 3 — award places from the pool's first place, splitting ties.
    considered.sort((a, b) => a.entry.finishRank - b.entry.finishRank || a.index - b.index);

    let nextPlace = pool.firstPlace;
    let cursor = 0;
    while (cursor < considered.length) {
      const rank = considered[cursor].entry.finishRank;
      let end = cursor;
      while (end + 1 < considered.length && considered[end + 1].entry.finishRank === rank) end += 1;
      const groupSize = end - cursor + 1;

      const tiedPlaces: number[] = [];
      let combined = 0;
      for (let offset = 0; offset < groupSize; offset += 1) {
        const place = nextPlace + offset;
        tiedPlaces.push(place);
        // A place past the pool's last place is not contested by this final, so it
        // carries no points — Rule 7-6-8's cap in the other direction.
        combined += place > pool.lastPlace ? 0 : pointsForPlace(table, place);
      }
      const share = combined / groupSize;

      for (let offset = 0; offset < groupSize; offset += 1) {
        const row = considered[cursor + offset];
        awarded.set(row.entry.id, {
          place: tiedPlaces[offset],
          tiedPlaces: groupSize > 1 ? tiedPlaces : [tiedPlaces[offset]],
          rawPoints: share,
        });
      }

      nextPlace += groupSize;
      cursor = end + 1;
    }

    // Step 5 (part 1) — places this pool contested that nobody was left to fill.
    //
    // Bounded by the entries actually presented, not by the table alone: a six-place
    // table with only four entries in the pool never contested places five and six, so
    // they were not "lost". Only a place a known entry vacated is reported — absent
    // rather than assumed, since the caller may simply not have handed us that lane.
    //
    // Bounded by entries that occupied a lane, which is *not* the same set as
    // `considered` above. A disqualified or exhibition entry still swam and still
    // occupied a place — Rule 7-7/7-10's "removed from consideration, others may
    // advance" presumes a real lane existed to advance into. A `did-not-compete`
    // entry is the one status that "never occupied a place" (Rule 7-9, see
    // NcaaEntryStatus's doc comment) — counting it here would fabricate a lost
    // place for a lane nobody was ever assigned.
    const contestedInPool = inPool.filter(row => (row.entry.status ?? 'scoring') !== 'did-not-compete');
    const lastContested = Math.min(pool.lastPlace, pool.firstPlace + contestedInPool.length - 1);
    for (let place = nextPlace; place <= lastContested; place += 1) {
      const value = pointsForPlace(table, place);
      if (value > 0) {
        lostPlaces.push({
          place,
          points: value,
          final: poolLabel(pool),
          cause: 'no-eligible-finisher',
        });
      }
    }
  }

  // Step 4 — per-team scorer cap. Applied after places are awarded, in place order, so
  // "best N" means best by place and not by input order.
  const capped = new Set<string>();
  if (table.maxScorersPerTeam !== null) {
    const byTeam = new Map<string, RankedRow[]>();
    entries.forEach((entry, index) => {
      if (!awarded.has(entry.id)) return;
      const list = byTeam.get(entry.team);
      if (list) list.push({ entry, index });
      else byTeam.set(entry.team, [{ entry, index }]);
    });

    for (const rows of byTeam.values()) {
      rows.sort((a, b) => {
        const pa = awarded.get(a.entry.id)!.place;
        const pb = awarded.get(b.entry.id)!.place;
        return pa - pb || a.index - b.index;
      });
      for (const row of rows.slice(table.maxScorersPerTeam)) capped.add(row.entry.id);
    }
  }

  if (capped.size > 0 && overCapBehavior === 'removed-from-consideration') {
    // Re-run with the over-cap entries demoted to non-scoring, so the field behind them
    // advances. One extra pass is enough: an entry promoted into a scoring place by the
    // re-run belongs to a team that was, by construction, under its cap.
    const demoted = entries.map(entry =>
      capped.has(entry.id) ? { ...entry, status: 'did-not-compete' as NcaaEntryStatus } : entry
    );
    const rerun = computeNcaaEventScoring(format, eventKind, demoted, {
      ...opts,
      overCapBehavior: 'holds-place',
    });
    return {
      ...rerun,
      entries: rerun.entries.map(scored =>
        capped.has(scored.id)
          ? {
              ...scored,
              status: entries.find(e => e.id === scored.id)?.status ?? 'scoring',
              reason: 'over-team-scorer-cap',
            }
          : scored
      ),
    };
  }

  // --- Assemble output rows in input order. ---
  const scored: NcaaScoredEntry[] = entries.map(entry => {
    const status = entry.status ?? 'scoring';
    const final = splitsFinals ? (entry.final ?? null) : null;
    const award = awarded.get(entry.id);

    if (!award) {
      const reason: NcaaScoringReason =
        status === 'disqualified'
          ? 'disqualified'
          : status === 'exhibition'
            ? 'exhibition'
            : 'did-not-compete';
      return { id: entry.id, team: entry.team, status, final, place: null, tiedPlaces: null, points: 0, reason };
    }

    const tiedPlaces = award.tiedPlaces.length > 1 ? award.tiedPlaces : null;

    if (capped.has(entry.id)) {
      return {
        id: entry.id,
        team: entry.team,
        status,
        final,
        place: award.place,
        tiedPlaces,
        points: 0,
        reason: 'over-team-scorer-cap',
      };
    }

    const outsideTable = award.rawPoints === 0 && award.place > table.places.length;
    return {
      id: entry.id,
      team: entry.team,
      status,
      final,
      place: award.place,
      tiedPlaces,
      points: award.rawPoints,
      reason: outsideTable ? 'place-outside-point-table' : null,
    };
  });

  // Step 5 (part 2) — points forfeited to the per-team cap are also lost from the meet.
  if (overCapBehavior === 'holds-place') {
    for (const entry of scored) {
      if (entry.reason !== 'over-team-scorer-cap' || entry.place === null) continue;
      const value = pointsForPlace(table, entry.place);
      if (value > 0) {
        lostPlaces.push({
          place: entry.place,
          points: value,
          final: entry.final,
          cause: 'over-team-scorer-cap',
        });
      }
    }
  }

  const totals = new Map<string, number>();
  for (const entry of scored) totals.set(entry.team, (totals.get(entry.team) ?? 0) + entry.points);
  const teamTotals: NcaaTeamTotal[] = [...totals.entries()]
    .map(([team, points]) => ({ team, points: roundPoints(points) }))
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));

  lostPlaces.sort((a, b) => a.place - b.place);

  return {
    format,
    eventKind,
    table,
    pools,
    entries: scored,
    teamTotals,
    lostPlaces,
    pointsAwarded: roundPoints(scored.reduce((sum, e) => sum + e.points, 0)),
    pointsLost: roundPoints(lostPlaces.reduce((sum, p) => sum + p.points, 0)),
  };
}

// ---------------------------------------------------------------------------
// Meet-level outcomes (Rule 7-1-3)
// ---------------------------------------------------------------------------

/**
 * A dual meet's outcome, as Rule 7-1-3 states it. These are two genuinely different
 * states with different recorded results, so they are two explicit inputs — never one
 * inferred from the other, and never inferred from an empty results list.
 */
export type NcaaDualMeetOutcomeInput =
  /** The meet happened; score it event by event with {@link computeNcaaEventScoring}. */
  | { readonly kind: 'contested' }
  /**
   * Rule 7-1-3: "No contest is recorded if a team fails to contact the host institution
   * or arrive at the site within 30 minutes after the scheduled start time of the meet.
   * There is no resulting score."
   */
  | { readonly kind: 'no-contest'; readonly absentTeam: string; readonly hostTeam: string }
  /**
   * Rule 7-1-3: "If a coach removes his or her team from competition for any reason, a
   * forfeit shall be declared. The numerical score to be recorded for a dual meet that
   * is forfeited is 11-0."
   */
  | { readonly kind: 'forfeit'; readonly forfeitingTeam: string; readonly opposingTeam: string };

export interface NcaaDualMeetOutcome {
  readonly kind: NcaaDualMeetOutcomeInput['kind'];
  /**
   * Whether a numerical score is recorded at all. `false` for a no contest — which is
   * absent, not 0-0. A 0-0 score would be a fabricated result.
   */
  readonly scoreRecorded: boolean;
  /** `null` whenever no score is recorded, and for a contested meet (score the events). */
  readonly score: readonly NcaaTeamTotal[] | null;
  readonly citation: string;
  readonly rule: string;
}

const RULE_7_1_3 =
  'No contest is recorded if a team fails to contact the host institution or arrive at the ' +
  'site within 30 minutes after the scheduled start time of the meet. There is no resulting ' +
  'score. If a coach removes his or her team from competition for any reason, a forfeit shall ' +
  'be declared. The numerical score to be recorded for a dual meet that is forfeited is 11-0.';

/** Resolve a dual meet's recorded score for a no-show or forfeit. Pure. */
export function resolveNcaaDualMeetOutcome(input: NcaaDualMeetOutcomeInput): NcaaDualMeetOutcome {
  switch (input.kind) {
    case 'contested':
      return {
        kind: 'contested',
        scoreRecorded: false,
        score: null,
        citation: 'NCAA Rule 7-1-3',
        rule: RULE_7_1_3,
      };
    case 'no-contest':
      return {
        kind: 'no-contest',
        scoreRecorded: false,
        score: null,
        citation: 'NCAA Rule 7-1-3',
        rule: RULE_7_1_3,
      };
    case 'forfeit':
      return {
        kind: 'forfeit',
        scoreRecorded: true,
        score: [
          { team: input.opposingTeam, points: 11 },
          { team: input.forfeitingTeam, points: 0 },
        ],
        citation: 'NCAA Rule 7-1-3',
        rule: RULE_7_1_3,
      };
    default: {
      const exhaustive: never = input;
      throw new NcaaScoringInputError(
        `Unknown dual meet outcome ${JSON.stringify(exhaustive)}.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Meet aggregation
// ---------------------------------------------------------------------------

/**
 * Sum team points across several scored events. Totals are rounded to 6 decimals once,
 * at the end, so a three-way tie's thirds still add back to a whole point.
 */
export function aggregateNcaaTeamTotals(
  events: readonly NcaaEventScore[]
): readonly NcaaTeamTotal[] {
  const totals = new Map<string, number>();
  for (const event of events) {
    for (const entry of event.entries) {
      totals.set(entry.team, (totals.get(entry.team) ?? 0) + entry.points);
    }
  }
  return [...totals.entries()]
    .map(([team, points]) => ({ team, points: roundPoints(points) }))
    .sort((a, b) => b.points - a.points || a.team.localeCompare(b.team));
}
