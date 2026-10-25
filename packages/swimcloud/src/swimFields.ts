/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Cell readers shared by more than one SwimCloud page kind: time, points, ordinal place, flags, ids, gender and stroke words.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import { extractHrefs, findElementSpans, htmlToText } from './html';
import { classifySwimCloudUrl } from './urlClassifier';
import type {
  SwimCloudEvent,
  SwimCloudGenderOrUnknown,
  SwimCloudResultFlags,
  SwimCloudStroke,
} from './entities';
import type { SwimCloudParseWarning } from './parseResult';
import { classTokens, readAttribute, startTagOf } from './parseElements';

/**
 * A swim time as printed: optional hour and minute groups, then seconds to
 * hundredths. `52.10`, `1:56.47`, `1:02:33.44`.
 *
 * Hundredths are required. A value printed to tenths or to thousandths is not a
 * time this parser will accept, because accepting it would mean deciding how to
 * pad or truncate it, and that is a fabricated digit in a competition value.
 */
const TIME_TOKEN = /^(?:\d{1,2}:){0,2}\d{1,2}\.\d{2}$/;

/**
 * Non-time markers with a meaning clear enough to map onto a flag.
 *
 * **Unverified** that SwimCloud prints these tokens at all — they are the
 * Hy-Tek/Meet-Manager conventions the sport uses everywhere. A token outside
 * this map is *not* guessed at: it is preserved in
 * {@link SwimCloudResult.rawTimeToken} and reported as
 * `unrecognized-time-token`.
 */
const RESULT_MARKERS: Readonly<Record<string, SwimCloudResultFlags>> = {
  dq: { disqualified: true },
  ns: { noShow: true },
  scr: { scratched: true },
  // Declared False Start: the athlete did not swim. Treated as a scratch, which
  // is the state it shares — deliberately not folded into `disqualified`, since
  // Rule 7 treats a DQ and a non-swim differently.
  dfs: { scratched: true },
};

/**
 * The swimmer id a row's athlete link carries, from either link shape.
 *
 * Both shapes are accepted because SwimCloud uses both, and a swimmer id is the
 * same fact whichever page linked to it. The meet-scoped
 * `/results/{meetId}/swimmer/{id}/` form is the one every results row actually
 * uses — confirmed on all three real captures — so restricting this to the bare
 * `/swimmer/{id}/` form (as it was until 2026-09-08) silently dropped the id
 * from every row of every real results page and fell back to matching athletes
 * by printed name, which is the ambiguity `suggestAliasCandidates` exists to
 * clean up after.
 */
export function swimmerIdFromCell(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable') {
      continue;
    }
    const resource = classification.resource;
    if (resource.kind === 'swimmer' || resource.kind === 'meetSwimmer') {
      return resource.swimmerId;
    }
  }
  return undefined;
}

/**
 * The team id a row's team link carries, from any of the three link shapes.
 *
 * Same reasoning as {@link swimmerIdFromCell}: the meet-root results table links
 * its team column at `/results/{meetId}/team/{teamId}/`, never at `/team/{id}/`.
 */
export function teamIdFromCell(cellHtml: string): string | undefined {
  for (const href of extractHrefs(cellHtml)) {
    const classification = classifySwimCloudUrl(href);
    if (classification.outcome !== 'fetchable') {
      continue;
    }
    const resource = classification.resource;
    if (resource.kind === 'team' || resource.kind === 'meetTeam' || resource.kind === 'meetTeamSwims') {
      return resource.teamId;
    }
  }
  return undefined;
}

export function mapGender(word: string | undefined): SwimCloudGenderOrUnknown {
  if (word === undefined) {
    return 'unknown';
  }
  const lower = word.toLowerCase();
  if (lower === 'men' || lower === 'mens') {
    return 'Men';
  }
  if (lower === 'women' || lower === 'womens') {
    return 'Women';
  }
  // `Mixed`, `Boys`, `Girls` have no home in the two-value program vocabulary
  // this repo uses. They are reported as unknown rather than forced into one.
  return 'unknown';
}

export function mapStroke(lowerLabel: string, isRelay: boolean): SwimCloudStroke {
  if (/\bdiving\b|\bdiver\b|\bdive\b/.test(lowerLabel)) {
    return 'Diving';
  }
  if (isRelay) {
    if (/\bmedley\b/.test(lowerLabel)) {
      return 'Medley Relay';
    }
    if (/\bfree(style)?\b/.test(lowerLabel)) {
      return 'Freestyle Relay';
    }
    return 'unknown';
  }
  if (/\bindividual medley\b|\bim\b/.test(lowerLabel)) {
    return 'Individual Medley';
  }
  if (/\bbutterfly\b|\bfly\b/.test(lowerLabel)) {
    return 'Butterfly';
  }
  if (/\bbackstroke\b|\bback\b/.test(lowerLabel)) {
    return 'Backstroke';
  }
  if (/\bbreaststroke\b|\bbreast\b/.test(lowerLabel)) {
    return 'Breaststroke';
  }
  if (/\bfreestyle\b|\bfree\b/.test(lowerLabel)) {
    return 'Freestyle';
  }
  return 'unknown';
}

interface ReadPoints {
  readonly points?: number;
  readonly rawPointsToken?: string;
}

/**
 * See {@link SwimCloudResult}'s doc comment for why this field exists at
 * all — it was not always captured, and still isn't *trusted* by anything
 * in this file; capturing is all a parser ever does.
 *
 * An empty cell is not a warning-worthy case (plenty of rows — DQ, no-show,
 * exhibition — legitimately score nothing) but anything present that isn't
 * a clean non-negative number is preserved verbatim and flagged, same
 * discipline as every other cell in this file.
 */
export function readPoints(raw: string, event: SwimCloudEvent, rowIndex: number, warnings: SwimCloudParseWarning[]): ReadPoints {
  const token = raw.trim();
  if (token.length === 0) {
    return {};
  }
  // SwimCloud prints a dash in the Score column for a swim that scored nothing
  // -- a consolation heat below the scoring places, an exhibition, a relay B
  // squad. That is the page stating "no points", which is the same thing an
  // empty cell states, so it is recorded as absent rather than flagged as a
  // token nobody recognises. Covers the hyphen, non-breaking hyphen, and the en
  // and em dashes; the real capture uses U+2013.
  if (/^[-‐‑‒–—―]+$/.test(token)) {
    return {};
  }
  if (/^\d+(\.\d+)?$/.test(token)) {
    const value = Number.parseFloat(token);
    return { points: value };
  }
  warnings.push({
    code: 'unrecognized-points-token',
    message: `Points cell ${JSON.stringify(token)} is not a non-negative number; no points recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return { rawPointsToken: token };
}

export interface ReadTime {
  readonly finalTime?: string;
  readonly rawTimeToken?: string;
  readonly flags?: SwimCloudResultFlags;
}

export function readTime(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): ReadTime {
  const token = raw.trim();
  if (token.length === 0) {
    return {};
  }

  // A leading `X` on the *time token* marks an exhibition swim in Hy-Tek-derived
  // output. **Still unverified for SwimCloud** — kept, deliberately, and here is
  // the reasoning as of 2026-09-10.
  //
  // The per-event results page (`parseMeetEventResultsHtml`) has a *different*,
  // now-confirmed exhibition marker: a `<span title="Exhibition">X</span>`
  // replacing the ordinal in the row's rank cell. That finding says what the
  // per-event page does. It says nothing about the swims list, which this
  // function also serves and which has **no rank-cell marker of any kind** —
  // its rows carry an ordinal that is only a row number. So retiring this check
  // would leave the swims-list path with no exhibition detection whatsoever,
  // and an exhibition swim there would silently score. Keeping an unproven
  // check that has never fired on a real capture costs nothing; removing the
  // only check on that path could cost a wrong team score.
  //
  // The two cannot collide: the per-event page's time cells print a bare time
  // (`54.27`), never `X54.27`, so on that page this branch never fires and the
  // rank cell is the sole source of the flag.
  const exhibition = /^x/i.test(token) && TIME_TOKEN.test(token.slice(1));
  const body = exhibition ? token.slice(1) : token;

  if (event.stroke === 'Diving') {
    // A diving column holds a judged score, not a time. Storing it in a time
    // field would put a non-time into a field everything downstream reads as a
    // time.
    warnings.push({
      code: 'diving-score-not-a-time',
      message: `Diving result ${JSON.stringify(token)} is a judged score, not a time; preserved verbatim and not stored as finalTime.`,
      eventId: event.eventId,
      rowIndex,
      raw: token,
    });
    return {
      rawTimeToken: token,
      ...(exhibition ? { flags: { exhibition: true } } : {}),
    };
  }

  if (TIME_TOKEN.test(body)) {
    return {
      finalTime: body,
      ...(exhibition ? { flags: { exhibition: true } } : {}),
    };
  }

  const marker = RESULT_MARKERS[body.toLowerCase()];
  if (marker !== undefined) {
    return {
      rawTimeToken: token,
      flags: exhibition ? { ...marker, exhibition: true } : marker,
    };
  }

  warnings.push({
    code: 'unrecognized-time-token',
    message: `Time cell ${JSON.stringify(token)} is neither a time nor a known marker (${Object.keys(RESULT_MARKERS).join(', ').toUpperCase()}); preserved verbatim, no time recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return { rawTimeToken: token };
}

/**
 * A cut-standard badge printed in a row's flags cell, captured verbatim.
 *
 * Informational only. This package does **not** resolve a badge to a standard:
 * deciding that `D2 B` means a particular published time is the job
 * `CLAUDE.md`'s provenance rules reserve for the cutline tables, which trace
 * every value to an archived PDF. Copying a scraped badge into a cut decision
 * is how a swimmer gets told they made a cut they did not make.
 */
export interface SwimCloudCutStandardLabel {
  /** The badge text as printed, e.g. `'D2 B'`. */
  readonly label: string;
  /** The badge's tooltip, e.g. `'NCAA Division II Championship'`. Absent when the markup carried none. */
  readonly title?: string;
}

/**
 * Place cells that mean "no place" on a swims list.
 *
 * The **en dash** (U+2013) is the confirmed one — it is what a real capture
 * prints for an unplaced swim, and it is not the hyphen a reader might assume.
 * The rest are carried over from {@link NO_PLACE_TOKENS} because they express the
 * same idea and none of them can be confused with an ordinal.
 *
 * A separate set from {@link NO_PLACE_TOKENS} on purpose: adding the en dash
 * there would change how {@link parseMeetResultsHtml} treats a page shape nobody
 * has verified, turning a loud warning into a silent absence on evidence that
 * does not cover it.
 */
const SWIMS_NO_PLACE_TOKENS = new Set(['', '–', '—', '-', '--', '---']);

/** `1st`, `2nd`, `3rd`, `17th`. */
const ORDINAL_PLACE = /^(\d+)\s*(?:st|nd|rd|th)$/i;

/**
 * Read a swims-list place cell, which prints an **ordinal**, not an integer.
 *
 * A bare integer is accepted too. It never appears on the captured page, but an
 * integer in a place column is unambiguous, and refusing it would discard a real
 * place to make a point. Anything else is `unrecognized-place-token` and no
 * place at all — never coerced, never zero.
 *
 * Kept separate from {@link readPlace}, which stays exactly as it was for the
 * page shape it was written against.
 */
export function readOrdinalPlace(
  raw: string,
  event: SwimCloudEvent,
  rowIndex: number,
  warnings: SwimCloudParseWarning[],
): number | undefined {
  const token = raw.trim();
  if (SWIMS_NO_PLACE_TOKENS.has(token)) {
    return undefined;
  }
  const ordinal = ORDINAL_PLACE.exec(token);
  const digits = ordinal !== null ? ordinal[1] : /^\d+$/.test(token) ? token : undefined;
  if (digits !== undefined) {
    const value = Number.parseInt(digits, 10);
    if (value > 0) {
      return value;
    }
  }
  warnings.push({
    code: 'unrecognized-place-token',
    message: `Place cell ${JSON.stringify(token)} is neither an ordinal ("1st", "17th"), a positive integer, nor a known "no place" marker; no place recorded.`,
    eventId: event.eventId,
    rowIndex,
    raw: token,
  });
  return undefined;
}

/** What the flags cell carries. Both parts are optional and can co-occur. */
export interface SwimFlagsCell {
  readonly relayLeadoff: boolean;
  readonly cutStandards: SwimCloudCutStandardLabel[];
}

/**
 * Read a row's flags cell.
 *
 * Leadoff detection matches on `title="Leadoff"` and nothing else. Not the
 * visible `R` glyph, and never the event name: a leadoff split's event cell is
 * character-for-character identical to a genuine individual swim of the same
 * event, and the real capture contains both.
 */
export function readFlagsCell(cellHtml: string): SwimFlagsCell {
  let relayLeadoff = false;
  const cutStandards: SwimCloudCutStandardLabel[] = [];

  for (const span of findElementSpans(cellHtml, 'span')) {
    const startTag = startTagOf(span.html);
    const title = readAttribute(startTag, 'title');
    if (title !== undefined && title.trim().toLowerCase() === 'leadoff') {
      relayLeadoff = true;
      continue;
    }
    if (!classTokens(startTag).includes('c-label--royal')) {
      continue;
    }
    const label = htmlToText(span.inner);
    if (label.length > 0) {
      cutStandards.push({ label, ...(title === undefined ? {} : { title }) });
    }
  }

  return { relayLeadoff, cutStandards };
}
