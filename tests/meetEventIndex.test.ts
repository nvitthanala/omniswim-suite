/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A meet's event list belongs to the meet, not to its teams' swims lists.
 *
 * ## The gap this closes
 *
 * The crawler used to learn a meet's events by parsing all 42 per-team swims
 * pages and collecting `swims[].event.eventRef`. Against the archived crawl of
 * meet 356467 that produced 51 refs. Every stored event page prints an index of
 * 57, and the six it never named are real scoring events:
 *
 *     9    1M Diving Men Finals
 *     18   3M Diving Women Finals
 *     29   3M Diving Men Finals
 *     40   1M Diving Women Finals
 *     403  50 Free Mixed
 *     503  200 Fly Mixed
 *
 * Four diving events and two mixed relays. A diver never appears on a swims
 * list, so no number of swims pages would have found the diving four — the meet
 * was importing with entire scoring events missing, which is worse than
 * mis-scoring one, because nothing in the totals looks wrong.
 *
 * These tests pin the count, the six, and the cross-meet guard against the real
 * stored pages. They skip rather than pass when the capture is absent, so a
 * clean checkout cannot report a green proof it never ran.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readMeetEventIndex } from '../packages/swimcloud/src/parser';

const PAGES = path.resolve(__dirname, '..', 'data', 'swimcloud-captures', 'pages');
const MEET_ID = '356467';

function storedEventPages(): { name: string; html: string }[] {
  if (!fs.existsSync(PAGES)) return [];
  return fs
    .readdirSync(PAGES)
    .filter((n) => /_2f_event_2f_\d+_2f_/.test(n))
    .map((name) => ({
      name,
      html: (JSON.parse(fs.readFileSync(path.join(PAGES, name), 'utf-8')) as { html?: string }).html ?? '',
    }))
    .filter((p) => p.html.length > 0);
}

const PAGES_ON_DISK = storedEventPages();

/**
 * The refs the swims-derived enumeration produced, measured from the same
 * archived crawl. Pinned verbatim so the "six missed" assertion below is a real
 * comparison against what the old path actually returned, not against a list
 * derived from the new one.
 */
const SWIMS_DERIVED_REFS = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '10', '11', '12', '13', '14', '15', '16', '17',
  '19', '20', '21', '22', '23', '24', '25', '26', '27', '28', '30', '31', '32', '33', '34',
  '35', '36', '37', '38', '39', '41', '42', '100', '101', '102', '201', '202', '300', '400',
  '402', '404', '500', '501', '938', '939',
]);

describe.skipIf(PAGES_ON_DISK.length === 0)('a meet event index read from a real event page', () => {
  it('reads the same 57 events from every one of the stored pages', () => {
    // The point of the whole change: ANY event page enumerates the meet, so the
    // crawl needs exactly one of them as a seed. If one page disagreed, the
    // seed would matter and the architecture would not hold.
    const sizes = new Map<number, string[]>();
    for (const page of PAGES_ON_DISK) {
      const n = readMeetEventIndex(page.html, MEET_ID).length;
      sizes.set(n, [...(sizes.get(n) ?? []), page.name]);
    }
    expect([...sizes.keys()]).toStrictEqual([57]);
    expect(sizes.get(57)?.length).toBe(PAGES_ON_DISK.length);
  });

  it('names the six events the swims pages never mentioned', () => {
    const index = readMeetEventIndex(PAGES_ON_DISK[0]!.html, MEET_ID);
    const missed = index
      .filter((entry) => !SWIMS_DERIVED_REFS.has(entry.eventRef))
      .map((entry) => `${entry.eventRef} ${entry.label}`);
    expect(missed).toStrictEqual([
      '9 1M Diving Men Finals',
      '18 3M Diving Women Finals',
      '29 3M Diving Men Finals',
      '40 1M Diving Women Finals',
      '403 50 Free Mixed',
      '503 200 Fly Mixed',
    ]);
  });

  it('carries every swims-derived ref too, so nothing is traded away', () => {
    // Event-first replaces the swims pass. That is only safe if the index is a
    // superset: a ref the old path found and this one does not would be an
    // event that stops being crawled.
    const index = new Set(readMeetEventIndex(PAGES_ON_DISK[0]!.html, MEET_ID).map((e) => e.eventRef));
    const lost = [...SWIMS_DERIVED_REFS].filter((ref) => !index.has(ref));
    expect(lost).toStrictEqual([]);
  });

  it('reads each label exactly once, not once per responsive copy', () => {
    // The anchor prints its label in a desktop div and a mobile div, so the
    // flattened text reads "9 1M Diving Men Finals 1M Diving Men Finals". A
    // doubled label would be a fabricated event name.
    for (const entry of readMeetEventIndex(PAGES_ON_DISK[0]!.html, MEET_ID)) {
      expect(entry.label.length).toBeGreaterThan(0);
      const half = entry.label.slice(0, Math.floor(entry.label.length / 2)).trim();
      expect(entry.label, `${entry.eventRef} label is doubled`).not.toBe(`${half} ${half}`);
    }
  });

  it('pins the first and last entry, so a reordering is visible', () => {
    // Printed order is program order, and the crawl fetches in it. Pinning both
    // ends catches a silent reversal that a count check would miss.
    const index = readMeetEventIndex(PAGES_ON_DISK[0]!.html, MEET_ID);
    expect(index[0]).toStrictEqual({
      eventRef: '1',
      label: '800 Free Relay Women',
      printedNumber: '1',
      status: 'Scored',
    });
    expect(index.at(-1)).toStrictEqual({
      eventRef: '939',
      label: '100 Breast Men',
      printedNumber: '939',
      status: 'Scored',
    });
  });

  it('rejects an index item that names a different meet', () => {
    // Guards against a "related meets" card leaking another meet's events into
    // this meet's crawl plan, which would fetch pages that score nothing.
    expect(readMeetEventIndex(PAGES_ON_DISK[0]!.html, '999999')).toStrictEqual([]);
  });

  it('returns nothing for a page that carries no index', () => {
    // Absent must stay distinguishable from empty. The caller's contract is
    // that zero entries means "this page had no index", and the parser turns
    // that into an `event-index-absent` warning rather than a silent empty.
    expect(readMeetEventIndex('<html><body><p>No index here.</p></body></html>', MEET_ID)).toStrictEqual([]);
  });

  it('ignores an anchor that links an event but is not an index item', () => {
    // Every results row's time cell links to /results/{meet}/event/{n}/. Only
    // the `js-event-item` anchors are the index; counting the rest would turn
    // one event page's 81 event links into 81 crawl steps.
    const notAnItem =
      '<a href="/results/356467/event/26/" class="c-table__link">21.49</a>' +
      '<a href="/results/356467/event/99/">stray</a>';
    expect(readMeetEventIndex(notAnItem, MEET_ID)).toStrictEqual([]);
  });
});
