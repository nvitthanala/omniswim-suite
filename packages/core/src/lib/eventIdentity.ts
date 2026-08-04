/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Event identity: bridge between canonical SCY program-event labels
 * ("100 Backstroke") and the HyTek-style event labels that a loaded meet PDF
 * actually carries ("Event 24 Men 100 Yard Backstroke").
 *
 * `canonicalProgramEvent` maps an arbitrary event string (HyTek or bare) to its
 * canonical SCY individual program-event label, or null for relays / diving /
 * time trials / 25s / 100 IM / odd metric distances.
 *
 * `buildMeetEventLabelIndex` inverts this over a gender's loaded meet result
 * rows: canonical label -> the meet's actual event label. Scoring code uses it
 * to remap imported / planned / recruit rows onto the real meet event group so
 * they compete inside the loaded field instead of a phantom canonical group.
 *
 * This module is dependency-neutral (imports only athleteHistory + utils) so the
 * scoring path never has to import from crossCourseArbitrage. crossCourseArbitrage
 * re-exports `canonicalProgramEvent` for backward compatibility.
 *
 * Test: npx tsx scripts/test_event_identity_scoring.mjs
 */

import { SwimmerResult } from '../types';
import { isChampionshipProgramEvent, normalizeEventLabel } from './athleteHistory';
import { eventMeetSortKey, isDivingEvent, isRelayResult, stripEventGenderMarker } from './utils';

/**
 * Canonical SCY individual program-event label for an arbitrary event string
 * (handles HyTek "Event 24 Men 100 Yard Backstroke" as well as pre-normalized
 * "100 Backstroke"). Returns null for relays, diving, time trials, 100 IM, 25s,
 * and any non-championship distance.
 */
export function canonicalProgramEvent(raw: string): string | null {
  if (/\brelay\b/i.test(raw)) return null;
  let e = stripEventGenderMarker(raw);
  e = e.replace(/\bEvent\s+\d+\b/gi, ' ');
  e = e.replace(/\b(Yards?|Meters?|mtr|SCY|SCM|LCM)\b/gi, ' ');
  e = e.replace(/\s{2,}/g, ' ').trim();
  const norm = normalizeEventLabel(e);
  return isChampionshipProgramEvent(norm) && !/\brelay\b/i.test(norm) ? norm : null;
}

/**
 * Map each canonical SCY program event to the loaded meet's actual event label,
 * derived from a single gender's result rows.
 *
 * Dedup rule when several meet labels share one canonical event (e.g. a
 * separately-numbered prelims and finals variant): pick the label with the MOST
 * result rows (the fuller field / the scored final); break ties by the LOWEST
 * HyTek "Event N" number (eventMeetSortKey); break remaining ties
 * lexicographically. The choice is fully deterministic regardless of row order.
 *
 * Relay, diving, time-trial and other non-program rows contribute nothing
 * (canonicalProgramEvent returns null and time-trial rows are ignored), so they
 * never become a remap target.
 */
export function buildMeetEventLabelIndex(results: SwimmerResult[]): Map<string, string> {
  // canonical -> (meet label -> row count)
  const counts = new Map<string, Map<string, number>>();
  for (const r of results ?? []) {
    if (isRelayResult(r)) continue;
    if (r.isTimeTrial) continue;
    const canon = canonicalProgramEvent(r.event);
    if (!canon) continue;
    let byLabel = counts.get(canon);
    if (!byLabel) {
      byLabel = new Map();
      counts.set(canon, byLabel);
    }
    byLabel.set(r.event, (byLabel.get(r.event) ?? 0) + 1);
  }

  const index = new Map<string, string>();
  for (const [canon, byLabel] of counts) {
    let bestLabel: string | undefined;
    let bestCount = -1;
    let bestSortKey = Number.POSITIVE_INFINITY;
    for (const [label, count] of byLabel) {
      const sortKey = eventMeetSortKey(label);
      const better =
        count > bestCount ||
        (count === bestCount && sortKey < bestSortKey) ||
        (count === bestCount && sortKey === bestSortKey && (bestLabel == null || label < bestLabel));
      if (better) {
        bestLabel = label;
        bestCount = count;
        bestSortKey = sortKey;
      }
    }
    if (bestLabel != null) index.set(canon, bestLabel);
  }
  return index;
}

/**
 * Subset of `events` fit for a matrix-style event axis. Excludes:
 *  (a) non-program individual events — 25-yard events, 100 IM, time trials, and
 *      other odd distances (canonicalProgramEvent returns null);
 *  (b) when a meet is loaded (the label index is non-empty), leftover
 *      canonical-only labels that never matched a real meet event.
 * Relays and diving always remain. Order is preserved (subset of `events`).
 *
 * Purely presentational — callers keep scoring over the full `events` set, so
 * points/totals are unaffected by this filter.
 */
export function computeVisibleEvents(
  events: string[],
  allResults: SwimmerResult[],
  genderPdfResults: SwimmerResult[],
  settings: { diverEventPattern?: string[] }
): string[] {
  const meetLabelIndex = buildMeetEventLabelIndex(genderPdfResults);
  const meetLoaded = meetLabelIndex.size > 0;
  const rowsByEvent = new Map<string, SwimmerResult[]>();
  for (const r of allResults) {
    if (!rowsByEvent.has(r.event)) rowsByEvent.set(r.event, []);
    rowsByEvent.get(r.event)!.push(r);
  }
  return events.filter(event => {
    const rows = rowsByEvent.get(event) ?? [];
    // Relays and diving are always visible.
    if (/\brelay\b/i.test(event) || rows.some(r => isRelayResult(r))) return true;
    if (isDivingEvent(event, settings.diverEventPattern)) return true;
    // Time-trial pseudo-events (rows are all time trials) are hidden.
    if (rows.length > 0 && rows.every(r => r.isTimeTrial)) return false;
    const canon = canonicalProgramEvent(event);
    // 25-yard events, 100 IM, odd distances: non-program individual.
    if (!canon) return false;
    // No meet loaded (roster-only): show canonical program events.
    if (!meetLoaded) return true;
    // Meet loaded: only the chosen real meet label per canonical is visible;
    // leftover canonical-only labels that never matched are hidden.
    return meetLabelIndex.get(canon) === event;
  });
}
