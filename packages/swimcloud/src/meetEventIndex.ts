/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Meet event index reader (the `js-event-item` list on a meet page).
// Split out of `parser.ts`, which still re-exports every name it exported before.

import {
  collapseWhitespace,
  decodeHtmlEntities,
  htmlToText,
  stripNonContent,
} from './html';
import type { SwimCloudMeetId } from './entities';

/** One entry of a meet's own event index — see {@link readMeetEventIndex}. */
export interface SwimCloudMeetEventIndexEntry {
  /** The `/event/{n}/` reference, as printed in the anchor's href. */
  readonly eventRef: string;
  /**
   * The event's printed name, verbatim from the anchor's own `title`
   * attribute, e.g. `'1M Diving Men Finals'`.
   *
   * **Not a key.** Three pairs of the 57 entries on the real capture share a
   * label (`event/400/` and `event/938/` are both "100 Breast Women"),
   * because SwimCloud numbers a post-meet time-trial session above the meet's
   * program and labels it the same as the programmed event. Only
   * {@link eventRef} identifies an entry.
   */
  readonly label: string;
  /**
   * The number printed in the entry's own status badge, e.g. `'9'`.
   *
   * Recorded verbatim, never used to derive a ref. On the real capture it
   * equals the ref for all 57 entries, but nothing here depends on that: the
   * ref comes from the href alone.
   */
  readonly printedNumber?: string;
  /**
   * The status word on the entry, verbatim — `'Scored'` on all 57 entries of
   * the real capture.
   *
   * Recorded rather than interpreted. Nothing here decides an event was
   * unscored from this field, because no capture has shown any other value, so
   * the vocabulary is unknown. A second word appearing is a finding to read,
   * not a condition to branch on.
   */
  readonly status?: string;
}

const EVENT_INDEX_ITEM_MARKER = /\bjs-event-item\b/;

const EVENT_INDEX_ANCHOR = /<a\b([^>]*)>([\s\S]*?)<\/a>/g;

const EVENT_INDEX_HREF = /href="\/results\/(\d+)\/event\/(\d+)\/?"/;

const EVENT_INDEX_LABEL = /class="c-events__link-body"\s+title="([^"]*)"/;

const EVENT_INDEX_STATUS = /class="c-events__link-start"[^>]*title="([^"]*)"/;

const EVENT_INDEX_NUMBER = /class="c-event-status[^"]*"\s*>([\s\S]*?)<\/span>/;

/**
 * Every event of a meet, read from the event index a results page prints for
 * itself.
 *
 * ## Why this exists: the swims-derived event list was incomplete
 *
 * Until now the crawler learned a meet's events by parsing all 42 per-team
 * swims pages and collecting `swims[].event.eventRef`. Measured against the
 * archived crawl of meet 356467, that produced **51** refs. Every one of the
 * 51 stored event pages prints an index of **57**, and the six it never
 * mentioned are real events that were simply never fetched:
 *
 *     9    1M Diving Men Finals
 *     29   3M Diving Men Finals
 *     18   3M Diving Women Finals
 *     40   1M Diving Women Finals
 *     403  50 Free Mixed
 *     503  200 Fly Mixed
 *
 * Four diving events and two mixed relays. Diving points count toward the team
 * score in every format this repo models, so a meet imported from the swims
 * lists was missing scoring events outright — not mis-scoring them, missing
 * them. A diver does not appear on a swims list, so no number of swims pages
 * would ever have found those four.
 *
 * ## Why an anchor's `title`, not its text
 *
 * The anchor repeats its label in a desktop `<div>` and a mobile one, so its
 * flattened text reads "1 1M Diving Men Finals 1M Diving Men Finals". The
 * `title` attribute on `c-events__link-body` carries it once. Reading the
 * attribute is not a shortcut around the text — it is the only place the label
 * appears exactly once.
 *
 * ## Scope of what is proven
 *
 * All 51 stored event pages of meet 356467 print the identical 57-entry index,
 * so **any one event page enumerates the whole meet**. Nothing here assumes
 * the index appears on other page types; a caller hands this whatever HTML it
 * has and reads the length of the result. An empty array means this page
 * carried no index — which a caller must not read as "this meet has no
 * events", and {@link SwimCloudMeetEventResultsParse.eventIndex} keeps that
 * distinction by warning instead of returning a silent empty.
 *
 * `meetId` is required and matched against each href, so a link to another
 * meet's event — a "related meets" card, say — can never enter the list.
 */
export function readMeetEventIndex(
  html: string,
  meetId: SwimCloudMeetId,
): readonly SwimCloudMeetEventIndexEntry[] {
  const entries: SwimCloudMeetEventIndexEntry[] = [];
  const seen = new Set<string>();
  const cleaned = stripNonContent(html);

  for (const match of cleaned.matchAll(EVENT_INDEX_ANCHOR)) {
    const attrs = match[1] ?? '';
    const inner = match[2] ?? '';
    if (!EVENT_INDEX_ITEM_MARKER.test(attrs)) {
      continue;
    }

    const href = EVENT_INDEX_HREF.exec(attrs);
    // An index item whose href names another meet is not this meet's event.
    if (href === null || href[1] !== meetId) {
      continue;
    }
    const eventRef = href[2] as string;
    if (seen.has(eventRef)) {
      continue;
    }
    seen.add(eventRef);

    const labelMatch = EVENT_INDEX_LABEL.exec(inner);
    const statusMatch = EVENT_INDEX_STATUS.exec(inner);
    const numberMatch = EVENT_INDEX_NUMBER.exec(inner);
    const label =
      labelMatch === null ? '' : collapseWhitespace(decodeHtmlEntities(labelMatch[1] as string));
    const status =
      statusMatch === null ? undefined : collapseWhitespace(decodeHtmlEntities(statusMatch[1] as string));
    const printedNumber =
      numberMatch === null ? undefined : collapseWhitespace(htmlToText(numberMatch[1] as string));

    entries.push({
      eventRef,
      label,
      ...(printedNumber === undefined || printedNumber.length === 0 ? {} : { printedNumber }),
      ...(status === undefined || status.length === 0 ? {} : { status }),
    });
  }

  return entries;
}
