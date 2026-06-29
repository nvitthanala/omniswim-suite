/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * HyTek psych-sheet / results PDF team abbreviations and meet-name resolution.
 */

/** Uppercase abbreviation → canonical full school name. */
export const TEAM_ABBREVIATIONS: Record<string, string> = {
  // NSISC
  HSU: 'Henderson State University',
  DSU: 'Delta State University',
  OUAC: 'Ouachita Baptist University',
  OBU: 'Ouachita Baptist University',
  UWF: 'University of West Florida',
  // GLVC / legacy (backend/pdf_parser.py)
  UMSL: 'University of Missouri-St. Louis',
  TRUM: 'Truman State University',
  SBU: 'Southwest Baptist University',
  WJC: 'William Jewell College',
  MKU: 'McKendree University',
  ROCK: 'University of Indianapolis',
  UINDY: 'University of Indianapolis',
  INDY: 'University of Indianapolis',
  'MS&T': 'Missouri S&T',
  MST: 'Missouri S&T',
  QU: 'Quincy University',
  DRURY: 'Drury University',
  DRUR: 'Drury University',
  LU: 'Lindenwood University',
  MARY: 'University of Mary',
  NSU: 'Northern State University',
  SCAD: 'SCAD Savannah',
};

const ACRONYM_STOP_WORDS = new Set(['of', 'the', 'at', '&', 'and', 'a']);

/** Lowercase alphanumeric key for fuzzy team matching. */
export function normalizeTeamKey(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Build acronym from institution name (e.g. Henderson State University → HSU). */
export function teamAcronym(fullName: string): string {
  const trimmed = String(fullName ?? '').trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('university of ')) {
    const tail = trimmed.slice('university of '.length).trim();
    const parts = tail.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'U';
    return ('U' + parts.map(p => p[0] ?? '').join('')).toUpperCase();
  }

  return trimmed
    .replace(/[.,']/g, '')
    .split(/\s+/)
    .filter(w => w && !ACRONYM_STOP_WORDS.has(w.toLowerCase()))
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase();
}

/** Expand a known abbreviation to its canonical full name, if mapped. */
export function expandTeamAbbrev(label: string): string | null {
  const trimmed = String(label ?? '').trim();
  if (!trimmed) return null;
  const mapped = TEAM_ABBREVIATIONS[trimmed.toUpperCase()];
  return mapped ?? null;
}

function findMeetTeamByCanonical(canonical: string, meetTeams: string[]): string | undefined {
  const normCanon = normalizeTeamKey(canonical);
  return meetTeams.find(t => normalizeTeamKey(t) === normCanon);
}

function findMeetTeamByAcronym(abbrev: string, meetTeams: string[]): string | undefined {
  const upper = abbrev.toUpperCase();
  if (upper.length < 2 || upper.length > 6) return undefined;
  for (const t of meetTeams) {
    if (teamAcronym(t) === upper) return t;
  }
  return undefined;
}

function findMeetTeamBySubstring(candidate: string, meetTeams: string[]): string | undefined {
  const norm = normalizeTeamKey(candidate);
  if (!norm || norm.length < 3) return undefined;

  for (const t of meetTeams) {
    if (normalizeTeamKey(t) === norm) return t;
  }

  for (const t of meetTeams) {
    const kn = normalizeTeamKey(t);
    if (kn.length >= 3 && norm.length >= 3 && (kn.includes(norm) || norm.includes(kn))) {
      return t;
    }
  }

  // First significant token (e.g. "Henderson" → Henderson State University)
  const firstToken = norm.replace(/university|college|state/g, '').slice(0, 12);
  if (firstToken.length >= 4) {
    for (const t of meetTeams) {
      const kn = normalizeTeamKey(t);
      if (kn.startsWith(firstToken) || firstToken.startsWith(kn.slice(0, firstToken.length))) {
        return t;
      }
    }
  }

  return undefined;
}

/**
 * Map a psych-sheet or truncated team label onto a meet-results team name.
 * Falls back to expanded canonical name or the original label.
 */
export function matchMeetTeamName(candidate: string, meetTeams: Iterable<string>): string {
  const trimmed = String(candidate ?? '').trim();
  if (!trimmed) return trimmed;

  const teams = [...meetTeams];
  if (teams.includes(trimmed)) return trimmed;

  const expanded = expandTeamAbbrev(trimmed);
  if (expanded) {
    const exact = findMeetTeamByCanonical(expanded, teams);
    if (exact) return exact;
    if (teams.length === 0) return expanded;
  }

  const byAcronym = findMeetTeamByAcronym(trimmed, teams);
  if (byAcronym) return byAcronym;

  const bySubstr = findMeetTeamBySubstring(trimmed, teams);
  if (bySubstr) return bySubstr;

  if (expanded) return expanded;

  return trimmed;
}
