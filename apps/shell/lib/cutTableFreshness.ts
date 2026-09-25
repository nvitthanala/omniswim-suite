/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A4 (production-readiness, 2026-09-24): report — never fetch — which
 * divisions' cut-standard tables are older than the current competition
 * season, at server start.
 *
 * `data/cutlines/sources/manifest.json` (see CLAUDE.md's "Data provenance"
 * rules) lists every archived qualifying-standards PDF with its `division`
 * and `season` (e.g. `"2025-2026"`). One entry may carry `evidenceOnly:
 * true` — it exists only to document a formatting decision (see
 * `naia-2020-21-course-evidence`) and contributes no season for freshness
 * purposes.
 *
 * This module is pure: no filesystem, no network, no clock reads other than
 * the `Date` the caller passes in. `server.ts` owns reading the manifest
 * file and the console logging; it must not crash startup if that read or
 * parse fails, so `loadCutTableSources` throws with a clear message on a
 * malformed manifest and the caller wraps it in try/catch.
 */

export interface CutTableSource {
  readonly id: string;
  readonly division: string;
  readonly season: string;
  readonly evidenceOnly?: boolean;
}

export interface StaleDivisionReport {
  readonly division: string;
  readonly latestSeason: string;
  readonly currentSeason: string;
}

/**
 * A season is labelled `"YYYY-YYYY+1"` and, by decision recorded here,
 * starts on 1 August and runs through 31 July of the following calendar
 * year. NCAA/NAIA/USA Swimming publish qualifying standards for the coming
 * academic year over the summer, so a season is "current" from the August
 * it starts, not the January most of its meets fall in.
 *
 * Boundary: 31 July 2026 is still season "2025-2026"; 1 August 2026 is
 * already "2026-2027".
 */
export function seasonForDate(date: Date): string {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0 = January, 7 = August
  const startYear = month >= 7 ? year : year - 1;
  return `${startYear}-${startYear + 1}`;
}

/**
 * Parse a `"YYYY-YYYY+1"` season label to its start year. Throws on any
 * other shape rather than guessing — a cut table's season is a fact, not
 * something to coerce silently (CLAUDE.md's data-provenance rules apply to
 * this metadata the same as to the times themselves).
 */
export function seasonStartYear(season: string): number {
  const m = /^(\d{4})-(\d{4})$/.exec(season);
  if (!m) throw new Error(`Not a "YYYY-YYYY" season label: ${JSON.stringify(season)}`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end !== start + 1) {
    throw new Error(`Season label's years are not consecutive: ${JSON.stringify(season)}`);
  }
  return start;
}

/**
 * Parse and validate the manifest's `sources` array. Throws a descriptive
 * error on anything malformed; never fills in a missing field. The caller
 * (`server.ts`) decides what "must not crash startup" means for a throw
 * from here — currently, catch it and log a warning.
 */
export function loadCutTableSources(manifestJson: string): CutTableSource[] {
  const parsed: unknown = JSON.parse(manifestJson);
  if (typeof parsed !== 'object' || parsed === null || !('sources' in parsed)) {
    throw new Error('Cut-table manifest has no "sources" array.');
  }
  const sources = (parsed as { sources: unknown }).sources;
  if (!Array.isArray(sources)) {
    throw new Error('Cut-table manifest\'s "sources" is not an array.');
  }
  return sources.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`Cut-table manifest source #${i} is not an object.`);
    }
    const { id, division, season, evidenceOnly } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof division !== 'string' || typeof season !== 'string') {
      throw new Error(`Cut-table manifest source #${i} is missing id/division/season.`);
    }
    return { id, division, season, evidenceOnly: evidenceOnly === true };
  });
}

/**
 * For each division with at least one non-`evidenceOnly` source, find its
 * newest season and report it when that season is older than
 * `currentSeason`. A division whose newest table already matches or beats
 * the current season is left out — this reports staleness, not status.
 */
export function findStaleDivisions(
  sources: readonly CutTableSource[],
  currentSeason: string
): StaleDivisionReport[] {
  const currentStart = seasonStartYear(currentSeason);
  const latestByDivision = new Map<string, string>();

  for (const source of sources) {
    if (source.evidenceOnly) continue;
    const seen = latestByDivision.get(source.division);
    if (seen === undefined || seasonStartYear(source.season) > seasonStartYear(seen)) {
      latestByDivision.set(source.division, source.season);
    }
  }

  const stale: StaleDivisionReport[] = [];
  for (const [division, latestSeason] of latestByDivision) {
    if (seasonStartYear(latestSeason) < currentStart) {
      stale.push({ division, latestSeason, currentSeason });
    }
  }
  // Stable, readable order for a log line — alphabetical by division.
  return stale.sort((a, b) => a.division.localeCompare(b.division));
}

/** One console line per {@link StaleDivisionReport}, in the shape agreed for A4. */
export function formatStaleDivisionLine(report: StaleDivisionReport): string {
  return (
    `Cut tables: ${report.division} is ${report.latestSeason}, current season is ` +
    `${report.currentSeason} — re-run scripts/fetch-cutlines.py when the NCAA publishes.`
  );
}

/**
 * Convenience for the server: given the manifest's raw JSON text and
 * "today", produce the exact log lines to print (possibly none). Still
 * pure — the caller reads the file and does the `console.warn`/`console.log`.
 */
export function staleCutTableLines(manifestJson: string, today: Date): string[] {
  const sources = loadCutTableSources(manifestJson);
  const currentSeason = seasonForDate(today);
  return findStaleDivisions(sources, currentSeason).map(formatStaleDivisionLine);
}
