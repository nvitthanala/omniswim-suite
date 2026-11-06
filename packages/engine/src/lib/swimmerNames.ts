/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Swimmer and team name keys, plus the class-year helpers.
// Split out of `utils.ts`, which still re-exports every name from here.

import { ClassYear } from '../types';

/** Case-insensitive name key for roster / relay matching. */
export function normalizeSwimmerName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Canonical identity key that also folds "Last, First" → "first last" so the same
 * human matches across data sources that spell the name in either order. Uses a
 * single-comma heuristic: names with 0 or 2+ commas (e.g. suffix forms like
 * "Malone, Curtis, Jr.") are left to plain `normalizeSwimmerName` semantics, so
 * suffixes are never mangled. Callers that must match identity across imports
 * (deleted-swimmer exclusion, roster keys, plan/jump matching) should use this;
 * `normalizeSwimmerName` remains the low-level key (e.g. relay group keys).
 */
export function canonicalSwimmerName(name: string): string {
  const raw = String(name ?? '').trim();
  const firstComma = raw.indexOf(',');
  if (firstComma > 0 && firstComma === raw.lastIndexOf(',')) {
    const last = raw.slice(0, firstComma).trim();
    const rest = raw.slice(firstComma + 1).trim();
    if (last && rest) return normalizeSwimmerName(`${rest} ${last}`);
  }
  return normalizeSwimmerName(raw);
}

/**
 * The class-year labels "drop seniors" removes: a senior or a graduate
 * student.
 *
 * - `SR`, `SENIOR` — senior.
 * - `GR`, `GRAD` — graduate student. SwimCloud's roster vocabulary maps
 *   `gr`, `grad` and `graduate` to `GR` (`packages/swimcloud/src/parser.ts`).
 * - `GS` — graduate student as a HyTek results file prints it. The PDF parser
 *   reads `GS` as a class year (`backend/pdf_parser.py`, `YEAR_TOKENS`), and
 *   the 2026 NSISC final results list Mark Eberhard (Henderson State) as `GS`.
 *   Before R1 (plans/2026-09-24) "drop seniors" kept him because only the
 *   SwimCloud spelling was listed.
 *
 * Deliberately NOT listed: `5Y` and `FY`, the parser's other two year tokens.
 * `FY` reads as "first year" in some exports and "fifth year" in others, and
 * no loaded file prints either, so neither is guessed at. An unlisted label
 * stays on the roster, the same as an absent one.
 */
const GRADUATING_CLASS_YEARS: ReadonlySet<string> = new Set(['SR', 'SENIOR', 'GR', 'GRAD', 'GS']);

/**
 * Case-insensitive test for a graduating class year: senior or graduate
 * student (see {@link GRADUATING_CLASS_YEARS}). Blank-tolerant: an absent year
 * is not graduating. Shared by the individual and relay-leg "drop seniors"
 * filters so they stay in lockstep.
 */
export function isGraduatingClassYear(year: string | undefined | null): boolean {
  const y = String(year ?? '').trim().toUpperCase();
  if (!y) return false;
  return GRADUATING_CLASS_YEARS.has(y);
}

/** Strip combining diacritical marks for accent-insensitive name comparisons. */
export function foldDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const INSTITUTION_TEAM_HINT =
  /\b(university|college|institute|seminary|baptist|methodist|lutheran|catholic|christian|technological|polytechnic|academy|national|international)\b/i;

/** True if string looks like a school name (not a bare "First Last" athlete). */
export function looksLikeInstitutionTeamName(team: string | null | undefined): boolean {
  const s = String(team ?? '').trim();
  if (!s) return false;
  if (INSTITUTION_TEAM_HINT.test(s)) return true;
  if (/\b(st\.|st\s|'s)\b/i.test(s)) return true;
  if (/\btech\b/i.test(s)) return true;
  if (/\ba\s*&\s*m\b/i.test(s)) return true;
  if (/\bstate\b/i.test(s)) return true;
  return false;
}

export function getYearsRemaining(year: ClassYear): number {
  switch (year) {
    case ClassYear.FR: return 3;
    case ClassYear.SO: return 2;
    case ClassYear.JR: return 1;
    case ClassYear.SR: return 0;
    default: return 4;
  }
}
