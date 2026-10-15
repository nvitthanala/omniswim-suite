/**
 * Conference championship programs: which relays a conference swims and the
 * order of events as the meet ran them, each tied to an archived primary source.
 *
 * DATA ONLY. Nothing imports this file yet: no scoring preset, optimizer or UI
 * reads it. It is not exported from `packages/core/src/index.ts`. The lead
 * decides how (and whether) to wire it in (plan item F6, decision U4).
 *
 * Rules (CLAUDE.md "Data provenance"):
 * - Every entry cites a source id from `data/relay-programs/sources/manifest.json`
 *   and the page of the archived PDF where each event is printed.
 * - A program is for ONE season. `season` is recorded on the data. Never use a
 *   program for another season as if it were current.
 * - A conference with no archived source has no entry here. Absence means
 *   "not on record", never "no relays".
 * - `data/relay-programs/sources/manifest.json` holds the url, sha256 and
 *   retrievedAt of each source. A test pins this file to the archived text.
 *
 * Kind of source: the GLVC document is a results document. It prints each
 * numbered event in the order the meet ran it. It is NOT a pre-meet program,
 * so this is "the order as run in February 2026", not a promise for 2026-27.
 */

export type ConferenceProgramGender = 'Women' | 'Men';
export type ConferenceProgramEventKind = 'relay' | 'individual' | 'diving';

export interface ConferenceProgramEvent {
  /** Event number printed in the source (`Event 10 Women 200 Yard Medley Relay`). */
  eventNumber: number;
  gender: ConferenceProgramGender;
  kind: ConferenceProgramEventKind;
  /**
   * Event name as the source prints it, with one repair: the PDF text layer
   * drops the "fl" ligature, so "Butter ly" is written back as "Butterfly".
   */
  name: string;
  /**
   * Relay label in the convention of `NSISC_RELAY_PROGRAM`
   * (`packages/manager/src/lib/theoreticalMeetSeeds.ts`). Present for relays only.
   */
  relayLabel?: string;
  /** Page of the archived PDF (1-based) where the event header first prints. */
  sourcePage: number;
}

export interface ConferenceProgram {
  /** Conference as the source names it. */
  conference: string;
  /** Season of the meet, in the format of `data/cutlines` ("2025-2026"). */
  season: string;
  /** Id in `data/relay-programs/sources/manifest.json`. */
  sourceId: string;
  /** What the source is. A results document is the order as run, not a program. */
  sourceKind: 'results-as-run' | 'published-program';
  /**
   * Scope rule. The program lists the numbered championship events only
   * (Events 1 to 42). It leaves out time trials (event numbers 2xx to 5xx on
   * later pages) and swim-offs (Event 109), which the source prints after the
   * championship events and which are not part of the program.
   */
  scope: string;
  /** Events in the order the meet ran them. */
  events: readonly ConferenceProgramEvent[];
}

type Row = readonly [number, ConferenceProgramGender, ConferenceProgramEventKind, string, number, string?];

const rows: readonly Row[] = [
  // [eventNumber, gender, kind, name, sourcePage, relayLabel?]
  [1, 'Women', 'relay', '800 Yard Freestyle Relay', 1, '800 Free Relay SCY'],
  [2, 'Men', 'relay', '800 Yard Freestyle Relay', 2, '800 Free Relay SCY'],
  [3, 'Women', 'diving', '3 mtr Diving', 3],
  [4, 'Women', 'individual', '1000 Yard Freestyle', 4],
  [5, 'Men', 'individual', '1000 Yard Freestyle', 6],
  [6, 'Women', 'individual', '200 Yard IM', 9],
  [7, 'Men', 'individual', '200 Yard IM', 10],
  [8, 'Women', 'individual', '50 Yard Freestyle', 12],
  [9, 'Men', 'individual', '50 Yard Freestyle', 13],
  [10, 'Women', 'relay', '200 Yard Medley Relay', 15, '200 Medley Relay SCY'],
  [11, 'Men', 'relay', '200 Yard Medley Relay', 15, '200 Medley Relay SCY'],
  [12, 'Men', 'diving', '1 mtr Diving', 16],
  [13, 'Women', 'individual', '100 Yard Butterfly', 17],
  [14, 'Men', 'individual', '100 Yard Butterfly', 18],
  [15, 'Women', 'individual', '400 Yard IM', 20],
  [16, 'Men', 'individual', '400 Yard IM', 22],
  [17, 'Women', 'individual', '200 Yard Freestyle', 24],
  [18, 'Men', 'individual', '200 Yard Freestyle', 26],
  [19, 'Women', 'relay', '400 Yard Medley Relay', 28, '400 Medley Relay SCY'],
  [20, 'Men', 'relay', '400 Yard Medley Relay', 29, '400 Medley Relay SCY'],
  [21, 'Men', 'diving', '3 mtr Diving', 30],
  [22, 'Women', 'individual', '500 Yard Freestyle', 31],
  [23, 'Men', 'individual', '500 Yard Freestyle', 33],
  [24, 'Women', 'individual', '100 Yard Backstroke', 36],
  [25, 'Men', 'individual', '100 Yard Backstroke', 38],
  [26, 'Women', 'individual', '100 Yard Breaststroke', 39],
  [27, 'Men', 'individual', '100 Yard Breaststroke', 41],
  [28, 'Women', 'individual', '200 Yard Butterfly', 43],
  [29, 'Men', 'individual', '200 Yard Butterfly', 44],
  [30, 'Women', 'relay', '200 Yard Freestyle Relay', 45, '200 Free Relay SCY'],
  [31, 'Men', 'relay', '200 Yard Freestyle Relay', 46, '200 Free Relay SCY'],
  [32, 'Women', 'diving', '1 mtr Diving', 47],
  [33, 'Women', 'individual', '1650 Yard Freestyle', 47],
  [34, 'Men', 'individual', '1650 Yard Freestyle', 49],
  [35, 'Women', 'individual', '100 Yard Freestyle', 52],
  [36, 'Men', 'individual', '100 Yard Freestyle', 54],
  [37, 'Women', 'individual', '200 Yard Backstroke', 57],
  [38, 'Men', 'individual', '200 Yard Backstroke', 58],
  [39, 'Women', 'individual', '200 Yard Breaststroke', 59],
  [40, 'Men', 'individual', '200 Yard Breaststroke', 61],
  [41, 'Women', 'relay', '400 Yard Freestyle Relay', 62, '400 Free Relay SCY'],
  [42, 'Men', 'relay', '400 Yard Freestyle Relay', 63, '400 Free Relay SCY'],
];

function toEvent(row: Row): ConferenceProgramEvent {
  const [eventNumber, gender, kind, name, sourcePage, relayLabel] = row;
  return {
    eventNumber,
    gender,
    kind,
    name,
    sourcePage,
    ...(relayLabel === undefined ? {} : { relayLabel }),
  };
}

/**
 * GLVC (Great Lakes Valley Conference) Swimming & Diving Championships, held
 * 2026-02-10 to 2026-02-14 at the Deaconess Aquatic Center, Evansville.
 *
 * Source: manifest id `glvc-swim-dive-2025-26-complete-results`
 * (`data/relay-programs/sources/2026-GLVC-Swimming-Diving-Complete_Results.pdf`,
 * "Complete Results", 76 pages, published by glvcsports.com).
 *
 * Relays in this program, per gender, in meet order: 800 free (Event 1/2, the
 * opening event), 200 medley (10/11), 400 medley (19/20), 200 free (30/31) and
 * 400 free (41/42). The source prints total relay distance ("800 Yard
 * Freestyle Relay") and never prints leg counts or leg distances.
 *
 * The 2027 championship (Feb 9-13, 2027, Evansville) has no published program
 * on record. This 2025-2026 order must not stand in for it.
 */
export const GLVC_2025_26_PROGRAM: ConferenceProgram = {
  conference: 'Great Lakes Valley Conference (GLVC)',
  season: '2025-2026',
  sourceId: 'glvc-swim-dive-2025-26-complete-results',
  sourceKind: 'results-as-run',
  scope:
    'Numbered championship events 1 to 42 as first printed in the Complete Results. ' +
    'Time trials (event numbers 2xx to 5xx) and swim-offs (Event 109) are excluded.',
  events: rows.map(toEvent),
};

/** Every conference program on record. A conference not listed has none on record. */
export const CONFERENCE_PROGRAMS: readonly ConferenceProgram[] = [GLVC_2025_26_PROGRAM];
