/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C5-UI: what the meet PDF import screen says about how a file was read.
 *
 * `POST /api/parse-pdf` answers with:
 *  - `pipeline: 'unified' | 'legacy'`. `legacy` means the main parser failed and
 *    the older fallback produced the rows, so relay splits may differ.
 *  - `warnings: [{ code, rows, examples[] }]`. On a legacy read the first entry
 *    has code `unified_pipeline_failed_legacy_used` and carries the reason.
 *  - on a 422, `rows: string[]` naming the rows that blocked the import. With
 *    `code: 'points_on_status_clock'` those rows print place points beside an
 *    NT, DQ, NS, SCR or DNF time.
 *
 * Nothing here reads a time or a point. It only words what the server said.
 */

/** The warning the route adds on a legacy fallback. Mirrors `LEGACY_FALLBACK_WARNING_CODE` in the shell route. */
export const LEGACY_FALLBACK_WARNING_CODE = 'unified_pipeline_failed_legacy_used';

export type PdfWarningGroup = {
  code: string;
  rows: number;
  examples: string[];
};

export type PdfImportNotice = {
  /** `error`: nothing was imported. `warning`: the meet was imported; read these first. */
  tone: 'error' | 'warning';
  /** One plain sentence. */
  title: string;
  /** One or two plain sentences that say what to do. */
  body: string;
  /** Rows that blocked an import, as the server named them. Empty for a warning. */
  rows: string[];
  /** The roll-up of parse warnings, without the legacy-fallback entry (its reason is `legacyReason`). */
  warnings: PdfWarningGroup[];
  /** Why the main parser failed, when the older parser read the file. */
  legacyReason: string | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function warningGroups(v: unknown): PdfWarningGroup[] {
  if (!Array.isArray(v)) return [];
  const out: PdfWarningGroup[] = [];
  for (const w of v) {
    if (!isRecord(w) || typeof w.code !== 'string') continue;
    out.push({
      code: w.code,
      rows: typeof w.rows === 'number' ? w.rows : 0,
      examples: stringList(w.examples),
    });
  }
  return out;
}

/**
 * The notice for a meet that imported: a legacy read, or one with parse
 * warnings. `null` when the main parser read it and raised nothing.
 */
export function noticeForParsedMeet(data: unknown): PdfImportNotice | null {
  if (!isRecord(data)) return null;
  const all = warningGroups(data.warnings);
  const fallback = all.find(w => w.code === LEGACY_FALLBACK_WARNING_CODE);
  const warnings = all.filter(w => w.code !== LEGACY_FALLBACK_WARNING_CODE);
  const legacy = data.pipeline === 'legacy';
  if (!legacy && warnings.length === 0) return null;
  return legacy
    ? {
        tone: 'warning',
        title: 'This meet was read with the older parser.',
        body: 'Check relay splits before you trust them.',
        rows: [],
        warnings,
        legacyReason: fallback?.examples[0] ?? null,
      }
    : {
        tone: 'warning',
        title: 'Some rows were read with warnings.',
        body: 'The meet was imported. Look at the rows below before you rely on the results.',
        rows: [],
        warnings,
        legacyReason: null,
      };
}

/**
 * The notice for an import the server refused with a list of rows. `null` when
 * the response names no rows: the caller shows its ordinary error then.
 */
export function noticeForRefusedMeet(data: unknown): PdfImportNotice | null {
  if (!isRecord(data)) return null;
  const rows = stringList(data.rows);
  if (rows.length === 0) return null;
  const statusClock = data.code === 'points_on_status_clock';
  return {
    tone: 'error',
    title: 'Nothing was imported.',
    body: statusClock
      ? 'These rows print place points next to an NT, DQ, NS, SCR or DNF time. The PDF columns have probably shifted, so no row from this file can be trusted. Check the PDF, then load it again.'
      : 'Some rows in this PDF could not be read without guessing. Check the rows below, then load the file again.',
    rows,
    warnings: [],
    legacyReason: null,
  };
}
