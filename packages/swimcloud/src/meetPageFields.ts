/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Meet-level readers shared by the team-swims, team-standings and event-results parsers: scope, gender, course and date range.
// Split out of `parser.ts`, which still re-exports every name it exported before.

import { extractHrefs, findElementSpans, htmlToText } from './html';
import { regexGroup } from './indexed';
import { classifySwimCloudUrl } from './urlClassifier';
import type {
  SwimCloudCourse,
  SwimCloudGenderOrUnknown,
  SwimCloudMeetId,
  SwimCloudTeamId,
} from './entities';
import type { SwimCloudParseWarning } from './parseResult';
import {
  classTokens,
  elementTextById,
  readQueryParam,
  startTagOf,
} from './parseElements';
import { mapGender } from './swimFields';

/** The warning every parse raises when the page prints no meet name. See `meet-name-missing`. */
export function missingMeetNameWarning(): SwimCloudParseWarning {
  return {
    code: 'meet-name-missing',
    message:
      'The page prints no meet name (no meet-name element and no level-1 heading). meet.name is the empty string, which means "not stated".',
  };
}

/* ---- Page-level facts ------------------------------------------------------ */

export function meetScopeFromSourceUrl(sourceUrl: string): {
  meetId?: SwimCloudMeetId;
  teamId?: SwimCloudTeamId;
  page?: string;
  mismatch?: string;
} {
  const classification = classifySwimCloudUrl(sourceUrl);
  if (classification.outcome !== 'fetchable') {
    return {};
  }
  const resource = classification.resource;
  if (resource.kind === 'meet' || resource.kind === 'meetEvent' || resource.kind === 'meetTopTeams') {
    return { meetId: resource.meetId };
  }
  if (resource.kind === 'meetTeam' || resource.kind === 'meetTeamSwims') {
    return {
      meetId: resource.meetId,
      teamId: resource.teamId,
      ...(resource.query.page === undefined ? {} : { page: resource.query.page }),
    };
  }
  return { mismatch: resource.kind };
}

/**
 * The gender the page is filtered to, read from the **printed word** on the
 * gender dropdown's active item.
 *
 * Deliberately not read from the URL's `?gender=` value. The real capture does
 * show `M` next to `Men` and `F` next to `Women`, but one sample is not an
 * encoding, and `SwimCloudMeetTeamQuery` documents why the classifier refuses to
 * interpret that parameter. The printed word is the page stating the fact, which
 * is the same rule `parseTeamRosterHtml` follows for a roster's gender.
 *
 * A dropdown item is a gender item only if it links to a `?gender=`-bearing URL,
 * so an unrelated `active` list item (a nav tab, say) cannot answer this.
 */
export function readActiveGenderWord(html: string): SwimCloudGenderOrUnknown {
  for (const item of findElementSpans(html, 'li')) {
    if (!classTokens(startTagOf(item.html)).includes('active')) {
      continue;
    }
    const linksGender = extractHrefs(item.inner).some(
      (href) => readQueryParam(href, 'gender') !== undefined,
    );
    if (!linksGender) {
      continue;
    }
    const word = /^(men|women|mixed|boys|girls|mens|womens)\b/i.exec(htmlToText(item.inner));
    const mapped = mapGender(word === null ? undefined : word[1]);
    if (mapped !== 'unknown') {
      return mapped;
    }
  }
  return 'unknown';
}

/** The course the page printed, e.g. `<li id="meet-course">SCY</li>`. Only the three real values are accepted. */
export function readPrintedCourse(html: string): SwimCloudCourse | undefined {
  const text = elementTextById(html, 'meet-course');
  if (text === undefined) {
    return undefined;
  }
  const token = text.trim().toUpperCase();
  if (token === 'SCY' || token === 'SCM' || token === 'LCM') {
    return token;
  }
  return undefined;
}

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** `Feb 17 – Mar 2, 2026`. */
const DATE_CROSS_MONTH = /^([A-Za-z]+)\.?\s+(\d{1,2})\s*[–—-]\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/;

/** `Feb 17–21, 2026` — the shape the real capture prints. */
const DATE_SAME_MONTH = /^([A-Za-z]+)\.?\s+(\d{1,2})\s*[–—-]\s*(\d{1,2}),\s*(\d{4})$/;

/** `Feb 17, 2026`. */
const DATE_SINGLE = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/;

function isoDate(year: number, monthWord: string, day: number): string | undefined {
  const month = MONTHS[monthWord.toLowerCase()];
  if (month === undefined || day < 1 || day > 31) {
    return undefined;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * The meet's start and end dates, from the printed `<li id="meet-date">` line.
 *
 * Three shapes are recognized and nothing else. A line that matches none of them
 * leaves both dates **absent** and raises `unrecognized-meet-date` — a meet date
 * is not worth guessing at, and a wrong one silently mis-seasons every swim under
 * it.
 */
export function readMeetDateRange(
  html: string,
  warnings: SwimCloudParseWarning[],
): { startDate?: string; endDate?: string } {
  const text = elementTextById(html, 'meet-date');
  if (text === undefined) {
    return {};
  }

  const cross = DATE_CROSS_MONTH.exec(text);
  if (cross !== null) {
    const year = Number.parseInt(regexGroup(cross, 5), 10);
    const startDate = isoDate(year, regexGroup(cross, 1), Number.parseInt(regexGroup(cross, 2), 10));
    const endDate = isoDate(year, regexGroup(cross, 3), Number.parseInt(regexGroup(cross, 4), 10));
    if (startDate !== undefined && endDate !== undefined) {
      return { startDate, endDate };
    }
  }

  const same = DATE_SAME_MONTH.exec(text);
  if (same !== null) {
    const year = Number.parseInt(regexGroup(same, 4), 10);
    const startDate = isoDate(year, regexGroup(same, 1), Number.parseInt(regexGroup(same, 2), 10));
    const endDate = isoDate(year, regexGroup(same, 1), Number.parseInt(regexGroup(same, 3), 10));
    if (startDate !== undefined && endDate !== undefined) {
      return { startDate, endDate };
    }
  }

  const single = DATE_SINGLE.exec(text);
  if (single !== null) {
    const startDate = isoDate(
      Number.parseInt(regexGroup(single, 3), 10),
      regexGroup(single, 1),
      Number.parseInt(regexGroup(single, 2), 10),
    );
    if (startDate !== undefined) {
      return { startDate };
    }
  }

  warnings.push({
    code: 'unrecognized-meet-date',
    message: `Meet date ${JSON.stringify(text)} matches none of the recognized shapes ("Feb 17, 2026", "Feb 17-21, 2026", "Feb 17 - Mar 2, 2026"); no start or end date recorded.`,
    raw: text,
  });
  return {};
}
