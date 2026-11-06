/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The spots of a scoring roster. Shared by the gate (slice A9 restores a removal that buys nothing only while the strict count holds) and by the
 * explanations (`roster_add` and `roster_remove` report the spots).
 */
import type { Lineup } from '../model/lineup';
import type { MeetEvent } from '../model/meet';
import type { SwimmerId } from '../model/primitives';

/**
 * The spots of one gender's scoring roster: whole numbers over the diver weight's denominator, not reduced. `scoreMeet` counts a swimmer with
 * any dive entry and no relay as a diver. With `strict`, the solver's rule (D5 4.4) counts a diver only when every entry of the swimmer is a dive.
 */
export function rosterSpots(
  lineup: Lineup,
  scorers: readonly SwimmerId[],
  weight: { readonly numerator: number; readonly denominator: number },
  events: readonly MeetEvent[],
  strict = false
): { readonly numerator: number; readonly denominator: number } {
  const diving = new Set(events.filter((e) => e.kind === 'diving').map((e) => `${e.gender}\u0000${e.eventKey}`));
  const dives = new Set<SwimmerId>();
  const relays = new Set<SwimmerId>();
  const others = new Set<SwimmerId>();
  for (const e of lineup.entries) {
    if (e.kind === 'relay') for (const leg of e.legs) relays.add(leg.swimmerId);
    else if (diving.has(`${e.gender}\u0000${e.eventKey}`)) dives.add(e.swimmerId);
    else others.add(e.swimmerId);
  }
  const divers = scorers.filter((id) => dives.has(id) && !relays.has(id) && !(strict && others.has(id))).length;
  const full = scorers.length - divers;
  return { numerator: full * weight.denominator + divers * weight.numerator, denominator: weight.denominator };
}
