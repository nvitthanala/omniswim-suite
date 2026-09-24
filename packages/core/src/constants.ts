/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConversionFactors } from './types';

/**
 * Course-conversion factors (SCY ↔ LCM/SCM).
 *
 * **LCM (`men_lcm`, `women_lcm`).** Researched 2026-09-13, per
 * `plans/2026-08-14/02-data-quality-aliasing.md` §1's open question: **no
 * governing body publishes a directly citable, archivable primary source
 * for these values.** USA Swimming's Times & Recognition Policy Manual
 * covers when a converted time is (and is not) recognized, but does not
 * itself publish a factor table. The NCAA publishes no LCM factor either:
 * its D2 sheet says "No times achieved in 50-meter courses will be eligible
 * for selection" (`2026-27D2MSW_QualStandards.pdf`, p. 2). The LCM factors in
 * circulation (this table included) trace to Colorado Time Systems' internal
 * conversion methodology, embedded in timing software and reproduced by
 * third-party calculators — not a standalone published document with a
 * URL/sha256 to archive the way `data/cutlines/sources/` does for cut
 * standards.
 *
 * **SCM (`both_scm`).** Corrected 2026-09-22: the NCAA *does* publish SCM→SCY
 * factors, and they differ by division. See {@link NCAA_SCM_CONVERSION_TABLES}
 * below, which `convertToSCY` now reads. `both_scm` holds the NCAA **D1**
 * 2025-26 values only; it is kept so the row shape stays additive, and a test
 * pins it to the D1 table. Do not read it for a D2, D3, NAIA or unknown team.
 *
 * Every value derived from this table is **indicative, not official**, per
 * this repo's own `converted_estimate` cutline-tag state (`cutlineTags.ts`),
 * which treats any conversion-derived cut comparison as visibly
 * non-authoritative rather than a real cut. Even the NCAA's own SCM factors
 * only *convert* a time; a converted time is not a yards swim. Do not present
 * a value derived from this table as an official time.
 */
export const CONVERSION_FACTORS: ConversionFactors = {
  '50 Freestyle': { men_lcm: 0.87, women_lcm: 0.881, both_scm: 0.906 },
  '100 Freestyle': { men_lcm: 0.873, women_lcm: 0.884, both_scm: 0.906 },
  '200 Freestyle': { men_lcm: 0.875, women_lcm: 0.884, both_scm: 0.906 },
  '400 Freestyle': { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  '500 Freestyle': { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  '800 Freestyle': { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  '1000 Freestyle': { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  '1500 Freestyle': { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  '1650 Freestyle': { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  '100 Backstroke': { men_lcm: 0.845, women_lcm: 0.863, both_scm: 0.906 },
  '200 Backstroke': { men_lcm: 0.859, women_lcm: 0.867, both_scm: 0.906 },
  '100 Breaststroke': { men_lcm: 0.866, women_lcm: 0.88, both_scm: 0.906 },
  '200 Breaststroke': { men_lcm: 0.868, women_lcm: 0.888, both_scm: 0.906 },
  '100 Butterfly': { men_lcm: 0.878, women_lcm: 0.887, both_scm: 0.906 },
  '200 Butterfly': { men_lcm: 0.876, women_lcm: 0.891, both_scm: 0.906 },
  // Keyed under the canonical label produced by `normalizeEventLabel` ("200 IM"
  // normalizes to "200 Individual Medley"). Both spellings are listed because
  // callers reach this table with either: keying only the abbreviation is what
  // made every IM conversion miss the table and silently fall back to the 50
  // Freestyle factor.
  '200 IM': { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 },
  '400 IM': { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 },
  '200 Individual Medley': { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 },
  '400 Individual Medley': { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 },
};

/* -------------------------------------------------------------------------- */
/* NCAA short-course-metres → short-course-yards factors (primary source)      */
/* -------------------------------------------------------------------------- */

/**
 * One row of the NCAA "Short-Course Conversion Factors (Men and Women)" table.
 *
 * The NCAA publishes exactly four rows, keyed by the **metric** event:
 * "400 meters to 500 yards", "800 meters to 1000 yards", "1500 meters to 1650
 * yards" and "All other events". Nothing finer is published, so nothing finer
 * is modelled.
 */
export type NcaaScmConversionRow =
  | 'free400To500'
  | 'free800To1000'
  | 'free1500To1650'
  | 'allOtherEvents';

/** The two distinct SCM tables the NCAA publishes today. */
export type NcaaScmConversionTableId = 'ncaa-rules-book-a2-2026-27' | 'ncaa-d1-2025-26';

/** Where an NCAA SCM table was read, so a caller can cite it. */
export type NcaaScmConversionSource = {
  /** `id` of each archived PDF in `data/cutlines/sources/manifest.json` (holds url + sha256). */
  manifestIds: readonly string[];
  /** Archived PDF filenames under `data/cutlines/sources/`. */
  filenames: readonly string[];
  /** 1-based PDF page that prints the table. */
  page: number;
  /** Section heading on that page. */
  section: 'Conversions';
  /** The sheet's own sentence about which rulebook the table follows, verbatim. */
  statement: string;
};

export type NcaaScmConversionTable = {
  id: NcaaScmConversionTableId;
  /** Short display name for a UI, e.g. `NCAA Rules Book A-2 (2026-27)`. */
  label: string;
  /** The published factor for each row, verbatim. */
  factors: Readonly<Record<NcaaScmConversionRow, number>>;
  source: NcaaScmConversionSource;
};

/**
 * Official NCAA SCM→SCY conversion factors, transcribed from the archived
 * qualifying-standard PDFs on 2026-09-22 and checked against
 * `pdftotext -layout` output of each page (see
 * `tests/courseConversionDivision.test.ts`, which re-reads the PDFs when
 * `pdftotext` is installed).
 *
 * - `ncaa-rules-book-a2-2026-27` — `2026-27D2MSW_QualStandards.pdf` and
 *   `2026-27D2WSW_QualStandards.pdf` (identical tables), page 2, section
 *   "Conversions". The sheet says the table "reflects what is included in the
 *   2026-27 NCAA Swimming and Diving Rules Book, Appendix A-2". It is the
 *   **default**: D2 uses it, and so does every team whose division publishes
 *   no table of its own.
 * - `ncaa-d1-2025-26` — `2025-26D1XSW_QUALSTANDARDS.pdf`, page 3, section
 *   "Conversions". The sheet says the table "does not reflect what is included
 *   in the NCAA Swimming and Diving Rules Book". It applies to D1 only.
 *
 * Not published, and therefore not here:
 * - D3: `2026-27D3XSW_QualifyingStandards.pdf` prints no conversion table.
 * - NAIA: `2026-27-SD-Qualifying-Standards-wo-Relays.pdf` prints separate
 *   meter standards and no factor.
 * Both fall back to the Rules Book table, and the conversion reports that
 * choice (`reason: 'division_publishes_none'`) instead of hiding it.
 *
 * Both sheets state the same procedure: "(a) transform the achieved metric
 * time into seconds; (b) carrying the calculation out to five decimal places,
 * multiply ... by the appropriate following conversion factor; (c) drop,
 * without rounding, all units smaller than a hundredth of a second; and (d)
 * ... transform the resultant value in seconds back into minutes and
 * seconds". `convertToSCY` therefore truncates an SCM conversion; it never
 * rounds one.
 */
export const NCAA_SCM_CONVERSION_TABLES: Readonly<
  Record<NcaaScmConversionTableId, NcaaScmConversionTable>
> = {
  'ncaa-rules-book-a2-2026-27': {
    id: 'ncaa-rules-book-a2-2026-27',
    label: 'NCAA Rules Book A-2 (2026-27)',
    factors: {
      free400To500: 1.143,
      free800To1000: 1.143,
      free1500To1650: 1.003,
      allOtherEvents: 0.896,
    },
    source: {
      manifestIds: ['ncaa-d2-men-2026-27', 'ncaa-d2-women-2026-27'],
      filenames: ['2026-27D2MSW_QualStandards.pdf', '2026-27D2WSW_QualStandards.pdf'],
      page: 2,
      section: 'Conversions',
      statement:
        'Please note that the conversion table above reflects what is included in the ' +
        '2026-27 NCAA Swimming and Diving Rules Book, Appendix A-2.',
    },
  },
  'ncaa-d1-2025-26': {
    id: 'ncaa-d1-2025-26',
    label: 'NCAA Division I (2025-26)',
    factors: {
      free400To500: 1.153,
      free800To1000: 1.153,
      free1500To1650: 1.013,
      allOtherEvents: 0.906,
    },
    source: {
      manifestIds: ['ncaa-d1-2025-26'],
      filenames: ['2025-26D1XSW_QUALSTANDARDS.pdf'],
      page: 3,
      section: 'Conversions',
      statement:
        'Please note the conversion table above does not reflect what is included in the ' +
        'NCAA Swimming and Diving Rules Book.',
    },
  },
};

/**
 * The `CONVERSION_FACTORS` keys that take a distance row of the NCAA SCM
 * table. Every other key takes `allOtherEvents`.
 *
 * The metric keys (400/800/1500) are the NCAA's own rows. The yards keys
 * (500/1000/1650) are the SCY slots those metric swims convert into; they sat
 * on the same distance factor in the old `both_scm` column, and they stay on
 * the same row here so no existing lookup changes row.
 */
export const NCAA_SCM_DISTANCE_ROWS: Readonly<Record<string, NcaaScmConversionRow>> = {
  '400 Freestyle': 'free400To500',
  '500 Freestyle': 'free400To500',
  '800 Freestyle': 'free800To1000',
  '1000 Freestyle': 'free800To1000',
  '1500 Freestyle': 'free1500To1650',
  '1650 Freestyle': 'free1500To1650',
};

/* -------------------------------------------------------------------------- */
/* NCAA altitude adjustment (primary source)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The three elevation columns of the NCAA "Altitude" chart, under the sheet's
 * own Roman numerals: I is 3,000-4,250 ft, II is 4,251-6,500 ft, III is above
 * 6,500 ft. Below 3,000 ft the chart does not apply.
 */
export type NcaaAltitudeElevationClass = 'I' | 'II' | 'III';

/**
 * One row of the NCAA altitude chart. The sheet prints exactly five rows, each
 * for individual events, and pairs a yards distance with a metres distance:
 * "100 Yards/Meters", "200 Yards/Meters", "500 Yards/400 Meters", "1,000
 * Yards/800 Meters" and "1,650 Yards/1,500 Meters". There is no 50 row and no
 * 400-yard row, so nothing is modelled for either.
 */
export type NcaaAltitudeRow =
  | 'y100m100'
  | 'y200m200'
  | 'y500m400'
  | 'y1000m800'
  | 'y1650m1500';

/** Where the altitude chart was read, one entry per archived PDF. */
export type NcaaAltitudeSourceDocument = {
  /** `id` in `data/cutlines/sources/manifest.json` (holds url + sha256). */
  manifestId: string;
  /** Archived PDF filename under `data/cutlines/sources/`. */
  filename: string;
  /** 1-based PDF page that prints the chart. */
  page: number;
};

export type NcaaAltitudeAdjustmentTable = {
  id: 'ncaa-altitude-2026-27';
  label: string;
  /** Elevation band of each column, in feet, as printed. `maxFeet: null` is "Above 6,500 Ft." */
  elevationClasses: Readonly<
    Record<NcaaAltitudeElevationClass, { minFeet: number; maxFeet: number | null; label: string }>
  >;
  /** The lowest elevation at which the chart applies: "3,000 feet or higher". */
  thresholdFeet: number;
  /**
   * Seconds subtracted from the actual time, per row and column, verbatim.
   * `0` in class I for the 100 is the sheet's own printed `.0`, not an absence.
   */
  seconds: Readonly<Record<NcaaAltitudeRow, Readonly<Record<NcaaAltitudeElevationClass, number>>>>;
  /** "A relay team may use a conversion that is four times the appropriate figures listed above." */
  relayMultiplier: 4;
  source: {
    documents: readonly NcaaAltitudeSourceDocument[];
    section: 'Altitude';
    /** The sheet's instruction under the chart, verbatim. */
    statement: string;
  };
};

/**
 * The official NCAA altitude adjustment chart, transcribed on 2026-09-22 from
 * the archived qualifying-standard PDFs and checked against
 * `pdftotext -table` output (the `-layout` mode misaligns the rows). The D2
 * 2026-27 men's and women's sheets (page 2) and the D1 2025-26 sheet (page 3)
 * print identical figures. `tests/altitudeAdjustment.test.ts` snapshots every
 * value and re-reads the PDFs when `pdftotext` is installed. The D3 and NAIA
 * sheets print no altitude chart.
 *
 * The chart is for a time **swum** at altitude and **not yet adjusted**. It
 * must never be applied to a time a source has already adjusted: SwimCloud
 * marks those `A` / "Altitude Adjusted" and publishes only the adjusted time
 * (see `HistoricalSwim.isAltitudeAdjusted`). The one function that applies it
 * is `ncaaAltitudeAdjustment` in `lib/altitude.ts`.
 */
export const NCAA_ALTITUDE_ADJUSTMENT_TABLE: NcaaAltitudeAdjustmentTable = {
  id: 'ncaa-altitude-2026-27',
  label: 'NCAA altitude adjustment (2026-27 D2 / 2025-26 D1 sheets)',
  elevationClasses: {
    I: { minFeet: 3000, maxFeet: 4250, label: '3,000-4,250 Ft.' },
    II: { minFeet: 4251, maxFeet: 6500, label: '4,251-6,500 Ft.' },
    III: { minFeet: 6501, maxFeet: null, label: 'Above 6,500 Ft.' },
  },
  thresholdFeet: 3000,
  seconds: {
    y100m100: { I: 0, II: 0.1, III: 0.15 },
    y200m200: { I: 0.5, II: 1.2, III: 1.6 },
    y500m400: { I: 2.5, II: 5.0, III: 7.0 },
    y1000m800: { I: 6.3, II: 11.4, III: 18.5 },
    y1650m1500: { I: 11.0, II: 20.0, III: 32.5 },
  },
  relayMultiplier: 4,
  source: {
    documents: [
      { manifestId: 'ncaa-d2-men-2026-27', filename: '2026-27D2MSW_QualStandards.pdf', page: 2 },
      { manifestId: 'ncaa-d2-women-2026-27', filename: '2026-27D2WSW_QualStandards.pdf', page: 2 },
      { manifestId: 'ncaa-d1-2025-26', filename: '2025-26D1XSW_QUALSTANDARDS.pdf', page: 3 },
    ],
    section: 'Altitude',
    statement:
      'Subtract the time above from the actual time achieved. A relay team may use a ' +
      'conversion that is four times the appropriate figures listed above.',
  },
};

export const SCORING_POINTS = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

// NEON_COLORS and TEAM_COLORS_MAP were removed on 2026-09-22. Both were dead:
// nothing in the repo imported either. Team colours come from
// `team_colors.json` through `teamColorLookup.ts`, which is keyed by data and
// works for a school nobody has heard of. The map that lived here named four
// specific programs, which is the shape this app must not have -- it has to
// work for any division and any team. Logged as finding f9 in
// docs/reference/PRODUCTION_READINESS_STATE.json, whose "falls back to the
// NEON_COLORS rotation" consequence was already out of date: neither constant
// was reachable to fall back to.


