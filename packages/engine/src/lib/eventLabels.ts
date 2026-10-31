/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Event label ordering and compact display labels.
// Split out of `utils.ts`, which still re-exports every name from here.

import { regexGroup } from './indexedAccess';

export function eventMeetSortKey(event: string): number {
  const m = event.match(/Event\s+(\d+)/i);
  return m ? parseInt(regexGroup(m, 1), 10) : 99999;
}

export function sortEventsByMeetOrder(events: string[]): string[] {
  return [...events].sort((a, b) => eventMeetSortKey(a) - eventMeetSortKey(b));
}

/** Remove gender markers from HyTek-style event titles (gender comes from workspace tab). */
export function stripEventGenderMarker(event: string): string {
  return event
    .replace(/\b(Men|Women|Boys|Boy|Girls|Girl)\b\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Full stripped event name for hover tooltips when compact label is shown. */
export function compactEventTitleAttr(event: string): string {
  return stripEventGenderMarker(event);
}

const STROKE_ABBREV: [RegExp, string][] = [
  [/\bIndividual\s+Medley\b/i, 'IM'],
  [/\bMedley\s+Relay\b/i, 'MD-R'],
  [/\bFreestyle\s+Relay\b/i, 'FR-R'],
  [/\bButterfly\b/i, 'FL'],
  [/\bBackstroke\b/i, 'BK'],
  [/\bBreaststroke\b/i, 'BR'],
  [/\bFreestyle\b/i, 'FR'],
  [/\bDiving\b/i, 'DV'],
  [/\bFly\b/i, 'FL'],
  [/\bBack\b/i, 'BK'],
  [/\bBreast\b/i, 'BR'],
  [/\bFree\b/i, 'FR'],
  [/\bIM\b/i, 'IM'],
  [/\bRelay\b/i, 'R'],
];

function abbreviateStrokeText(strokeText: string): string {
  let s = strokeText.trim();
  if (!s) return '';
  for (const [re, code] of STROKE_ABBREV) {
    if (re.test(s)) {
      s = s.replace(re, code);
      break;
    }
  }
  return s.replace(/\s+/g, '').toUpperCase();
}

/**
 * Compact display label: `Event 6 Men 200 Yard Individual Medley` → `E6 200IM`.
 * Display-only; does not mutate stored event keys.
 */
export function formatCompactEventLabel(event: string): string {
  const eventNumMatch = event.match(/\bEvent\s+(\d+)\b/i);
  const prefix = eventNumMatch ? `E${eventNumMatch[1]}` : '';

  let s = stripEventGenderMarker(event);
  s = s.replace(/\bEvent\s+\d+\b\s*/i, '');
  s = s.replace(/\s*\(Avg Split\)\s*/gi, ' ');
  s = s.replace(/\b(Yards?|Meters?|SCY|SCM|LCM)\b/gi, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();

  const distMatch = s.match(/\b(\d{2,4})\b/);
  const distance = distMatch?.[1] ?? '';
  const strokePart = distMatch ? s.slice(distMatch.index! + distMatch[0].length).trim() : s;
  const strokeCode = abbreviateStrokeText(strokePart);

  const body = `${distance}${strokeCode}`.trim();
  if (prefix && body) return `${prefix} ${body}`;
  if (prefix) return prefix;
  return body || stripEventGenderMarker(event);
}

/** Compact event number + stroke label for chart x-axes and tooltips. */
export function formatEventChartAxisLabel(
  event: string,
  options?: { abbreviate?: boolean; maxLength?: number }
): string {
  const { abbreviate = true, maxLength } = options ?? {};
  const label = abbreviate ? formatCompactEventLabel(event) : stripEventGenderMarker(event);
  if (maxLength != null && label.length > maxLength) {
    return label.substring(0, maxLength);
  }
  return label;
}
