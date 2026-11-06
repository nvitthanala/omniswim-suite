/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Gender, OfficialTeamScores } from '../types';
import { normalizeTeamKey } from '../data/teamAliases';

export {
  TEAM_ABBREVIATIONS,
  expandTeamAbbrev,
  matchMeetTeamName,
  normalizeTeamKey,
  teamAcronym,
} from '../data/teamAliases';

/**
 * Resolve which key in `officialScores` a parsed matrix team name refers to,
 * on the exact same ambiguity-safe terms as {@link matchOfficialTeamScore}.
 *
 * Split out so a caller that needs to know WHICH official row was consumed —
 * `buildMeetReconciliationSummary` flags an official-score row nothing
 * matched as `officialOnly` — can ask without re-deriving the match logic a
 * second time. `matchOfficialTeamScore` is defined in terms of this.
 */
export function matchOfficialTeamKey(
  teamName: string,
  officialScores: Record<string, number> | undefined
): string | undefined {
  if (!officialScores || !teamName) return undefined;
  if (officialScores[teamName] != null) return teamName;

  const norm = normalizeTeamKey(teamName);
  if (!norm) return undefined;

  const exact = Object.keys(officialScores).filter(key => normalizeTeamKey(key) === norm);
  if (exact.length >= 1) return exact[0]; // an exact normalized match is never ambiguous by construction

  // Two similarly-named teams in the same field (e.g. "Ohio" and "Ohio
  // State") can both legitimately contain one another's normalized key.
  // Returning the first one found would silently attribute the wrong
  // official score to a team a coach is looking at — report "no confident
  // match" instead, per this repo's data-provenance rules.
  const contained = Object.keys(officialScores).filter(key => {
    const kn = normalizeTeamKey(key);
    return kn.length >= 4 && norm.length >= 4 && (kn.includes(norm) || norm.includes(kn));
  });
  if (contained.length === 1) return contained[0];

  return undefined;
}

/** Resolve official PDF team score for a parsed matrix team name. */
export function matchOfficialTeamScore(
  teamName: string,
  officialScores: Record<string, number> | undefined
): number | undefined {
  const key = matchOfficialTeamKey(teamName, officialScores);
  return key != null ? officialScores![key] : undefined;
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
