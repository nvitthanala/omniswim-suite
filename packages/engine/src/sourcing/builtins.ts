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

/** `'table-d-user'` v1. */
export const BUILTIN_TABLE_D: readonly Builtin<TableDPreset>[] = [
  { id: 'table-d-user', version: 1, label: 'LCM to SCY (Table D)', preset: TABLE_D_USER },
];
