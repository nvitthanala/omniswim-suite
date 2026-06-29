/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Psych sheet PDF quality heuristics — HyTek psych layouts may be one-column
 * (regular) or two-column (divided). Auto mode scores each attempt and picks
 * the best parse (same strategy as meet PDF format detection).
 */

const PSYCH_SKIP_TIMES = new Set(['NT', 'NS', 'NP', 'DQ', 'DFS', 'SCR']);

export type PsychAthleteRow = Record<string, unknown>;

export function isPsychSeedTime(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  return !PSYCH_SKIP_TIMES.has(s.toUpperCase());
}

/** Individual psych seed rows from raw pdf_parser output (relays excluded). */
export function normalizePsychAthleteRows(athletes: PsychAthleteRow[]): PsychAthleteRow[] {
  const out: PsychAthleteRow[] = [];
  for (const a of athletes) {
    if (Boolean(a.is_relay) || /\brelay\b/i.test(String(a.event ?? ''))) continue;
    if (a.is_exhibition || a.is_time_trial) continue;
    const seed = String(a.finals_time ?? a.prelims_time ?? a.time ?? '').trim();
    if (!isPsychSeedTime(seed)) continue;
    out.push({
      ...a,
      is_relay: false,
      finals_time: null,
      prelims_time: null,
      time: seed,
      round_swam: 'Psych Sheet',
      is_psych_sheet: true,
    });
  }
  return out;
}

function timeMinutes(clock: string): number | null {
  const s = clock.trim();
  if (!s.includes(':')) return null;
  const [minStr, secStr] = s.split(':');
  const min = Number(minStr);
  const sec = Number(secStr);
  if (!Number.isFinite(min) || !Number.isFinite(sec)) return null;
  return min + sec / 60;
}

/** Higher is better. Penalizes merged event headers and implausible distance seed times. */
export function scorePsychParseQuality(normalized: PsychAthleteRow[]): number {
  if (normalized.length === 0) return -1_000_000;
  let score = normalized.length;
  for (const row of normalized) {
    const ev = String(row.event ?? '');
    if (ev.length > 80) score -= 100;
    // Swimmer/time text merged into event label (regular layout on divided psych PDF)
    if (/\b(FR|SO|JR|SR|5Y)\b/.test(ev) && /\d{1,2}\.\d{2}/.test(ev) && ev.length > 45) {
      score -= 80;
    }
    const clock = String(row.time ?? '');
    const mins = timeMinutes(clock);
    if (mins != null) {
      if (/\b1000\b/.test(ev) && mins < 5) score -= 60;
      if (/\b1650\b/.test(ev) && mins < 8) score -= 60;
      if (/\b500\b/.test(ev) && mins < 2) score -= 40;
    }
  }
  return score;
}

export function corruptPsychEventCount(normalized: PsychAthleteRow[]): number {
  let n = 0;
  for (const row of normalized) {
    const ev = String(row.event ?? '');
    if (ev.length > 80) n += 1;
    else if (/\b(FR|SO|JR|SR|5Y)\b/.test(ev) && /\d{1,2}\.\d{2}/.test(ev) && ev.length > 45) n += 1;
  }
  return n;
}

export function badDistanceSeedCount(normalized: PsychAthleteRow[]): number {
  let n = 0;
  for (const row of normalized) {
    const ev = String(row.event ?? '');
    const mins = timeMinutes(String(row.time ?? ''));
    if (mins == null) continue;
    if (/\b1000\b/.test(ev) && mins < 5) n += 1;
    if (/\b1650\b/.test(ev) && mins < 8) n += 1;
  }
  return n;
}

/** Format attempts for psych PDF auto-detect (divided before regular). */
export function psychParseFormatsToTry(requestedFormat: string): string[] {
  const fmt = (requestedFormat || 'auto').toLowerCase();
  if (fmt === 'divided' || fmt === 'regular') {
    return [fmt, fmt === 'divided' ? 'regular' : 'divided'];
  }
  return ['divided', 'regular', 'auto'];
}

export function pickBestPsychParseCandidate(
  candidates: { format: string; normalized: PsychAthleteRow[] }[]
): { format: string; normalized: PsychAthleteRow[] } | null {
  if (candidates.length === 0) return null;
  const ranked = [...candidates].sort(
    (a, b) => scorePsychParseQuality(b.normalized) - scorePsychParseQuality(a.normalized)
  );
  const best = ranked[0];
  if (!best || best.normalized.length === 0) return null;
  return best;
}
