/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Team name → NCAA division lookup (fuzzy). Expand as needed.
 */

import { NcaaDivision } from '../types';

/** Known team names (normalized lowercase) → division */
const TEAM_DIVISION_MAP: Record<string, NcaaDivision> = {
  'university of pittsburgh': 'D1',
  'pitt': 'D1',
  'university of louisville': 'D1',
  'florida state university': 'D1',
  'henderson state university': 'D2',
  'ouachita baptist university': 'D2',
  'delta state university': 'D2',
  'oklahoma baptist university': 'D2',
  'lindenwood university': 'D2',
  'mckendree university': 'D2',
  'drury university': 'D2',
};

function normalizeTeamKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function divisionForTeam(
  teamName: string,
  overrides?: Record<string, NcaaDivision>
): NcaaDivision {
  const key = normalizeTeamKey(teamName);
  if (overrides?.[teamName]) return overrides[teamName];
  if (overrides?.[key]) return overrides[key];
  if (TEAM_DIVISION_MAP[key]) return TEAM_DIVISION_MAP[key];
  for (const [known, div] of Object.entries(TEAM_DIVISION_MAP)) {
    if (key.includes(known) || known.includes(key)) return div;
  }
  return 'D1';
}

export function registerTeamsFromList(teams: string[]): Record<string, NcaaDivision> {
  const out: Record<string, NcaaDivision> = {};
  for (const t of teams) {
    out[t] = divisionForTeam(t);
  }
  return out;
}
