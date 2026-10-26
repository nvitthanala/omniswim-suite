/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Built-in Table D (plans/2026-10-25/D2-ENGINE-API.md, 3.12 and 4).
 *
 * `table-d-user` v1 is the user's LCM to SCY table. Each row is copied from Table D in
 * `plans/2026-10-25/00-USER-PLAN.md`: lines 82 to 84 and 88 to 103. A row carries the multiplier in
 * thousandths (0.892 is 892) and the turn adjustment in hundredths of a second (0.80s is 80).
 *
 * Lines 85 to 87 are the 400/500, 800/1000 and 1500/1650 rows. R29 (plans/2026-10-25/README.md:46)
 * rules them out: "Do not use the 0.892 rows for 400→500, 800→1000 and 1500→1650. Use SwimCloud's
 * own conversion first. Where SwimCloud has none, source the factors from SwimSwam's conversion tool,
 * archived with a manifest entry." Both settings stay pending until the SwimSwam archive exists. A
 * conversion that needs a pending row must refuse; it must not guess.
 *
 * Rounding is `truncate` (R23).
 */
import type { Builtin } from '../rules/builtinSupport';
import { pending, readmeRow, setting, userPlan } from '../rules/builtinSupport';
import type { EventKey } from '../model/primitives';
import type { Provenance } from '../model/provenance';
import type { LcmToScyPreset, LcmToScyRow } from './lcmToScy';
import type { TableDPreset, TableDRow } from './tableD';

/** The wording printed in the plan for this row, so a test can find it on the cited line. */
function row(
  line: number,
  planName: string,
  lcmEventKey: EventKey,
  scyEventKey: EventKey,
  turnText: string,
  turnHundredths: number
): TableDRow {
  const wording = `${planName} | 0.892 | ${turnText}`;
  return {
    lcmEventKey,
    scyEventKey,
    multiplierPermille: setting(892, userPlan(String(line), wording)),
    turnAdjustmentHundredths: setting(turnHundredths, userPlan(String(line), wording)),
  };
}

/** Same event in both courses. */
function same(line: number, planName: string, eventKey: EventKey, turnText: string, turnHundredths: number): TableDRow {
  return row(line, planName, eventKey, eventKey, turnText, turnHundredths);
}

const R29 =
  "R29 (README.md:46): \"Do not use the 0.892 rows for 400→500, 800→1000 and 1500→1650. Use SwimCloud's own conversion first. " +
  "Where SwimCloud has none, source the factors from SwimSwam's conversion tool, archived with a manifest entry.\" " +
  'Pending until the SwimSwam archive exists.';

/** Both settings pending: the row is in the plan (lines 85 to 87), but R29 says not to use it. */
function crossDistance(lcmEventKey: EventKey, scyEventKey: EventKey): TableDRow {
  return {
    lcmEventKey,
    scyEventKey,
    multiplierPermille: pending(R29, ['convertLcmToScy']),
    turnAdjustmentHundredths: pending(R29, ['convertLcmToScy']),
  };
}

const TABLE_D_USER: TableDPreset = {
  payloadVersion: 1,
  rows: [
    same(82, '50 Freestyle', '50 Freestyle', '0.80s', 80),
    same(83, '100 Freestyle', '100 Freestyle', '1.60s', 160),
    same(84, '200 Freestyle', '200 Freestyle', '3.20s', 320),
    crossDistance('400 Freestyle', '500 Freestyle'),
    crossDistance('800 Freestyle', '1000 Freestyle'),
    crossDistance('1500 Freestyle', '1650 Freestyle'),
    same(88, '50 Backstroke', '50 Backstroke', '0.60s', 60),
    same(89, '100 Backstroke', '100 Backstroke', '1.20s', 120),
    same(90, '200 Backstroke', '200 Backstroke', '2.40s', 240),
    same(91, '50 Breaststroke', '50 Breaststroke', '1.00s', 100),
    same(92, '100 Breaststroke', '100 Breaststroke', '2.00s', 200),
    same(93, '200 Breaststroke', '200 Breaststroke', '4.00s', 400),
    same(94, '50 Butterfly', '50 Butterfly', '0.70s', 70),
    same(95, '100 Butterfly', '100 Butterfly', '1.40s', 140),
    same(96, '200 Butterfly', '200 Butterfly', '2.80s', 280),
    same(97, '200 IM', '200 Individual Medley', '3.00s', 300),
    same(98, '400 IM', '400 Individual Medley', '6.00s', 600),
    same(99, '200 Free Relay', '200 Freestyle Relay', '3.20s', 320),
    same(100, '400 Free Relay', '400 Freestyle Relay', '6.40s', 640),
    same(101, '800 Free Relay', '800 Freestyle Relay', '12.80s', 1280),
    same(102, '200 Medley Relay', '200 Medley Relay', '3.20s', 320),
    same(103, '400 Medley Relay', '400 Medley Relay', '6.40s', 640),
  ],
  rounding: setting('truncate', readmeRow('40', 'Truncate.')),
};

/**
 * `'table-d-user'` v1. **Retired from use** (README R58, 2026-10-26): the user ruled Table D incorrect
 * for every event. Nothing in the engine reads it; `scyStatementFor` takes `lcmToScy` and has no Table D
 * field. The v1 content stays unchanged and resolvable, so saved data that names it does not break.
 * A picker must not offer it. Use `BUILTIN_LCM_TO_SCY`.
 */
export const BUILTIN_TABLE_D: readonly Builtin<TableDPreset>[] = [
  {
    id: 'table-d-user',
    version: 1,
    label: 'LCM to SCY (Table D)',
    preset: TABLE_D_USER,
    retired: { on: '2026-10-26', reason: 'README R58: the user ruled Table D incorrect for every event', supersededBy: 'lcm-scy-swimswam' },
  },
];

/* -------------------------------------------------------------------------- */
/* LCM to SCY, fitted to the SwimSwam converter (README R58 to R60)           */
/* -------------------------------------------------------------------------- */

/** The archive the values below are pinned to. `tests/engineLcmToScy.test.ts` replays all of it. */
export const LCM_SCY_ARCHIVE_PATH = 'data/conversions/swimswam/lcm-to-scy-2026-10-26.json';
/** sha256 of that file. `.gitattributes` pins LF, so the digest is stable across checkouts. */
export const LCM_SCY_ARCHIVE_SHA256 = '2b9114cb7ceec28564bbbbdca9b90166e92813d059f65b10d9892b82046999f5';

/**
 * Inferred from tool outputs. The converter publishes no factors (archive README, "What the outputs
 * fit"). Never `published`.
 */
const SWIMSWAM_PROVENANCE: Provenance = {
  kind: 'tool-derived',
  tool: { name: 'SwimSwam Swimming Time Conversion Tool', url: 'https://swimswam.com/swimming-times-conversion-tool/' },
  archive: { path: LCM_SCY_ARCHIVE_PATH, sha256: LCM_SCY_ARCHIVE_SHA256 },
  capturedOn: '2026-10-26',
  basis: 'inferred-from-tool-outputs',
};

/** Divisor times 100000 (README table in the archive: 1.11, 1.09361, 0.8925, 1.02). */
const DIVISOR_FREE_FLY_BREAST_IM = 111000;
const DIVISOR_BACK = 109361;
const DIVISOR_DISTANCE_FREE = 89250;
const DIVISOR_1500 = 102000;

function lcmRow(
  lcmEventKey: EventKey,
  scyEventKey: EventKey,
  divisorScaled: number,
  turnHundredths: number
): LcmToScyRow {
  return {
    lcmEventKey,
    scyEventKey,
    divisorScaled: setting(divisorScaled, SWIMSWAM_PROVENANCE),
    turnHundredths: setting(turnHundredths, SWIMSWAM_PROVENANCE),
  };
}

/** The same event in both courses. */
function lcmSame(eventKey: EventKey, divisorScaled: number, turnHundredths: number): LcmToScyRow {
  return lcmRow(eventKey, eventKey, divisorScaled, turnHundredths);
}

/**
 * `'lcm-scy-swimswam'` v1. 17 rows. The 800 Freestyle Relay has no row: the converter returns its
 * input unchanged, which is no conversion and never factor 1.0.
 */
const LCM_TO_SCY_SWIMSWAM: LcmToScyPreset = {
  payloadVersion: 1,
  rows: [
    lcmSame('50 Freestyle', DIVISOR_FREE_FLY_BREAST_IM, 80),
    lcmSame('100 Freestyle', DIVISOR_FREE_FLY_BREAST_IM, 160),
    lcmSame('200 Freestyle', DIVISOR_FREE_FLY_BREAST_IM, 320),
    lcmSame('50 Butterfly', DIVISOR_FREE_FLY_BREAST_IM, 70),
    lcmSame('100 Butterfly', DIVISOR_FREE_FLY_BREAST_IM, 140),
    lcmSame('200 Butterfly', DIVISOR_FREE_FLY_BREAST_IM, 280),
    lcmSame('50 Breaststroke', DIVISOR_FREE_FLY_BREAST_IM, 100),
    lcmSame('100 Breaststroke', DIVISOR_FREE_FLY_BREAST_IM, 200),
    lcmSame('200 Breaststroke', DIVISOR_FREE_FLY_BREAST_IM, 400),
    lcmSame('50 Backstroke', DIVISOR_BACK, 250),
    lcmSame('100 Backstroke', DIVISOR_BACK, 500),
    lcmSame('200 Backstroke', DIVISOR_BACK, 1000),
    lcmSame('200 Individual Medley', DIVISOR_FREE_FLY_BREAST_IM, 320),
    lcmSame('400 Individual Medley', DIVISOR_FREE_FLY_BREAST_IM, 640),
    lcmRow('400 Freestyle', '500 Freestyle', DIVISOR_DISTANCE_FREE, 0),
    lcmRow('800 Freestyle', '1000 Freestyle', DIVISOR_DISTANCE_FREE, 0),
    lcmRow('1500 Freestyle', '1650 Freestyle', DIVISOR_1500, 0),
  ],
  rounding: setting('truncate', SWIMSWAM_PROVENANCE),
};

/** `'lcm-scy-swimswam'` v1. The only LCM to SCY source in use. */
export const BUILTIN_LCM_TO_SCY: readonly Builtin<LcmToScyPreset>[] = [
  { id: 'lcm-scy-swimswam', version: 1, label: 'LCM to SCY (SwimSwam converter, inferred)', preset: LCM_TO_SCY_SWIMSWAM },
];

/** The built-in LCM to SCY preset for `{id, version}`, or `undefined`. Never a fallback. */
export function builtinLcmToScy(id: string, version: number): LcmToScyPreset | undefined {
  return BUILTIN_LCM_TO_SCY.find(b => b.id === id && b.version === version)?.preset;
}
