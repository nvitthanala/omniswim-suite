/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Gender, OfficialTeamScores } from '../types';

function normalizeTeamKey(name: string): string {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Resolve official PDF team score for a parsed matrix team name. */
export function matchOfficialTeamScore(
  teamName: string,
  officialScores: Record<string, number> | undefined
): number | undefined {
  if (!officialScores || !teamName) return undefined;
  if (officialScores[teamName] != null) return officialScores[teamName];

  const norm = normalizeTeamKey(teamName);
  if (!norm) return undefined;

  for (const [key, pts] of Object.entries(officialScores)) {
    if (normalizeTeamKey(key) === norm) return pts;
  }

  for (const [key, pts] of Object.entries(officialScores)) {
    const kn = normalizeTeamKey(key);
    if (kn.length >= 4 && norm.length >= 4 && (kn.includes(norm) || norm.includes(kn))) {
      return pts;
    }
  }

  return undefined;
}

export function officialScoresForGender(
  official: OfficialTeamScores | undefined,
  gender: Gender
): Record<string, number> | undefined {
  if (!official) return undefined;
  return gender === Gender.MEN ? official.men : official.women;
}

export function buildTeamScoreLookup(
  teamNames: string[],
  officialScores: Record<string, number> | undefined
): Map<string, number | undefined> {
  const map = new Map<string, number | undefined>();
  for (const name of teamNames) {
    map.set(name, matchOfficialTeamScore(name, officialScores));
  }
  return map;
}
