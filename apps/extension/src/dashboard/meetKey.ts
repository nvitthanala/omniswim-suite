/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The one copy of the meet key formula (D6 amendment 1 item 4). Every dashboard record of a simulator snapshot (scorer tags, choices,
 * the planner, saved lineups and snapshots) is keyed by this string. It names the teams and the date window, so a new window is a new meet.
 */
import type { SimSnapshot } from '../shared/bridgeSchema';

export const meetKeyForSnapshot = (snapshot: SimSnapshot): string =>
  `swimcloud-simulator:${JSON.stringify({ teams: [...new Set(snapshot.teams.map((t) => String(t.id)))].sort(), startDate: snapshot.settings.startDate, endDate: snapshot.settings.endDate })}`;
