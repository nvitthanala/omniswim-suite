/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for AthleteHistorySection's season/lifetime toggle
 * (P5) and "bests pulled" capture date (P7). No JSX, matching this repo's
 * `X.tsx` + `XView.ts` convention (see `athleteHistoryImportView.ts`).
 *
 * Season identity comes only from `HistoricalSwim.seasonId` (SwimCloud's own
 * `season_id`, e.g. `'29'`). A row without one (paste/PDF/CSV) can never be
 * placed in a season, so it is excluded from the season view rather than
 * guessed into the most recent one — the UI states the exclusion count so a
 * coach does not think an entry silently vanished.
 *
 * The season's own label is never invented from the id: it is the actual
 * date range of the swims that carry it (`HistoricalSwim.date`, ISO
 * `YYYY-MM-DD` when SwimCloud printed one — see `SwimCloudPersonalBestMeet`
 * in `packages/swimcloud/src/entities.ts`). A swim with no date does not
 * contribute to the range; a season with no dated swims has no range label
 * at all, rather than a fabricated one.
 */
import type { HistoricalSwim } from '@omniswim/core/types';

export type HistoryRangeMode = 'lifetime' | 'season';

/**
 * The highest (most recent) `seasonId` present, numeric-compared since
 * SwimCloud's ids are small increasing integers stated as strings.
 * `null` when no row carries one.
 */
export function highestSeasonId(rows: HistoricalSwim[]): string | null {
  let best: string | null = null;
  let bestRank = -Infinity;
  for (const row of rows) {
    const id = row.seasonId;
    if (!id) continue;
    const num = Number(id);
    const rank = Number.isFinite(num) ? num : -Infinity;
    if (best === null || rank > bestRank) {
      best = id;
      bestRank = rank;
    }
  }
  return best;
}

/** Rows carrying exactly this `seasonId`. */
export function rowsInSeason(rows: HistoricalSwim[], seasonId: string): HistoricalSwim[] {
  return rows.filter(r => r.seasonId === seasonId);
}

/** Rows carrying no `seasonId` at all — never placeable in a season. */
export function rowsWithoutSeason(rows: HistoricalSwim[]): HistoricalSwim[] {
  return rows.filter(r => !r.seasonId);
}

function parseIsoDate(date: string | undefined): Date | null {
  if (!date) return null;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * `"Oct 2025 – Jul 2026"` (or a single `"Jul 2026"` when every dated swim
 * falls in the same month) built from the swims themselves — never from the
 * season id. `null` when none of the given rows carries a parseable date.
 */
export function seasonDateRangeLabel(rows: HistoricalSwim[]): string | null {
  const dates = rows.map(r => parseIsoDate(r.date)).filter((d): d is Date => d !== null);
  if (dates.length === 0) return null;
  const min = new Date(Math.min(...dates.map(d => d.getTime())));
  const max = new Date(Math.max(...dates.map(d => d.getTime())));
  const minLabel = MONTH_YEAR.format(min);
  const maxLabel = MONTH_YEAR.format(max);
  return minLabel === maxLabel ? minLabel : `${minLabel} – ${maxLabel}`;
}

/** ISO instant of the most recent capture among these rows, or `null` when none was recorded. */
export function latestRetrievedAt(rows: HistoricalSwim[]): string | null {
  let best: string | null = null;
  for (const row of rows) {
    if (!row.retrievedAt) continue;
    if (best === null || row.retrievedAt > best) best = row.retrievedAt;
  }
  return best;
}

const SHORT_DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** Short display date for a `latestRetrievedAt` ISO instant, e.g. `"Sep 22, 2026"`. */
export function formatCaptureDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return SHORT_DATE.format(d);
}
