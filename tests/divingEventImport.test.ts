/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Diving events parse, and their points count.
 *
 * ## The bug
 *
 * `locateEventRoundTables` required a round table to have both a "Name" and a
 * "Time" column. **A diving table has no Time column at all** — its header is
 * `Name | Team | Pts | Score`, because a diving result is a judged score. So
 * every diving page failed with `expected-header-missing`, and all four of meet
 * 356467's diving events contributed nothing: 47 rows and 360 meet points
 * missing from the team totals, with nothing in the totals to show it.
 *
 * ## The question this also settles
 *
 * The parser used to warn `diving-score-column-unverified` and refuse to store
 * a diving `Score`, on the reasoning that it might be the judged score and that
 * a judged 300.15 stored as meet points would multiply a team's total. No
 * diving page had ever been captured, so the caution was right to exist.
 *
 * The full-field crawl settles it. On all four pages the `Pts` column holds the
 * judged score (503.95, 431.25, …) and the hidden `Score` column holds
 * 20, 17, 16, 15, 14, 13, 12, 11 — the championship individual table, place for
 * place. `data/meets.json`, built independently from the meet's own PDF, gives
 * Santiago Santodomingo `"points": 20` and `"time": "503.95"` for that same 1M
 * final. Two sources, same numbers.
 *
 * These tests assert the SwimCloud-derived rows against the PDF-derived ones
 * rather than against a copy of either, so they check the agreement and not a
 * snapshot.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseMeetEventResultsHtml } from '../packages/swimcloud/src/parser';
import type { SwimCloudMeetEventResultsParse } from '../packages/swimcloud/src/parser';
import { swimCloudEventResultsToSwimmerResults } from '../packages/matrix/src/lib/swimCloudMeetImportBridge';

const ROOT = path.resolve(__dirname, '..');
const PAGES = path.join(ROOT, 'data', 'swimcloud-captures', 'pages');
const MEETS_JSON = path.join(ROOT, 'data', 'meets.json');

/** The four diving events of meet 356467, by `/event/{n}/` reference. */
const DIVING_REFS = ['9', '18', '29', '40'] as const;

function storedEventPage(ref: string): { html: string; url: string } | undefined {
  if (!fs.existsSync(PAGES)) return undefined;
  const name = fs.readdirSync(PAGES).find((n) => n.includes(`_2f_event_2f_${ref}_2f`));
  if (name === undefined) return undefined;
  const j = JSON.parse(fs.readFileSync(path.join(PAGES, name), 'utf-8')) as {
    html?: string;
    canonicalUrl?: string;
    url?: string;
  };
  if (j.html === undefined || j.html.length === 0) return undefined;
  return { html: j.html, url: j.canonicalUrl ?? j.url ?? '' };
}

const PAGES_ON_DISK = DIVING_REFS.map((ref) => ({ ref, page: storedEventPage(ref) })).filter(
  (p): p is { ref: string; page: { html: string; url: string } } => p.page !== undefined,
);

/**
 * Parse one page, returning `undefined` rather than throwing.
 *
 * Deliberately not a throw. Throwing here happens while vitest is collecting
 * the suite, so the whole file reports "no tests" — which reads like a broken
 * test file rather than a caught regression, and is easy to mistake for a skip.
 * A mutation reinstating the Time-column requirement produced exactly that.
 * Returning undefined lets the failure land in a named test with a real
 * message.
 */
function parsed(html: string, url: string): SwimCloudMeetEventResultsParse | undefined {
  const result = parseMeetEventResultsHtml(
    html,
    { sourceUrl: url, retrievedAt: '2026-09-22T14:00:00.000Z', track: 'browser-extension' } as never,
    {} as never,
  );
  return result.ok ? result.data : undefined;
}

describe.skipIf(PAGES_ON_DISK.length === 0)('diving events from the real capture', () => {
  const parses = PAGES_ON_DISK.map(({ page }) => parsed(page.html, page.url)).filter(
    (p): p is SwimCloudMeetEventResultsParse => p !== undefined,
  );
  const rows = parses.flatMap((p) => {
    const converted = swimCloudEventResultsToSwimmerResults(p, { scoredEventNumberMax: 42 });
    return [...converted.men, ...converted.women];
  });

  it('parses all four diving pages', () => {
    // They failed outright with expected-header-missing before this, because a
    // diving table has no Time column and one was required.
    expect(PAGES_ON_DISK).toHaveLength(4);
    expect(parses).toHaveLength(4);
    for (const p of parses) expect(p.event.stroke).toBe('Diving');
  });

  it('reads both rounds of each page, and every diver', () => {
    const totalSwims = parses.reduce((n, p) => n + p.rounds.reduce((m, r) => m + r.swims.length, 0), 0);
    expect(totalSwims).toBe(47);
    for (const p of parses) {
      expect(p.rounds.map((r) => r.round)).toStrictEqual(['Finals, 11 Dives', 'Preliminaries, 11 Dives']);
    }
  });

  it('stores the Score column as meet points, and the Pts column as the judged score', () => {
    // The distinction the whole fix turns on. Storing 503.95 as meet points
    // would multiply a team's total; storing 20 as the result would lose the
    // dive.
    const winner = rows.find((r) => r.event === '1M Diving' && r.rank === 1 && r.gender === 'Men');
    expect(winner?.name).toBe('Santiago Santodomingo');
    expect(winner?.pdfPoints).toBe(20);
    expect(winner?.time).toBe('503.95');
  });

  it('agrees with data/meets.json, which came from the meet PDF', () => {
    // Two independent sources for the same event. The PDF path already carried
    // this meet's diving; the SwimCloud path now produces the same numbers.
    const meets = JSON.parse(fs.readFileSync(MEETS_JSON, 'utf-8')) as unknown;
    const pdfRows: { name: string; time: string; points: number; event: string; rank: number }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== 'object') return;
      const row = node as Record<string, unknown>;
      if (typeof row.event === 'string' && /1 mtr Diving/i.test(row.event) && /\bMen\b/i.test(row.event)) {
        pdfRows.push(row as never);
      }
      Object.values(row).forEach(walk);
    };
    walk(meets);
    expect(pdfRows.length).toBeGreaterThan(0);

    const scy = rows.filter((r) => r.event === '1M Diving' && r.gender === 'Men');
    for (const pdf of pdfRows) {
      const mine = scy.find((r) => r.name === pdf.name);
      expect(mine, `${pdf.name} is missing from the SwimCloud-derived rows`).toBeDefined();
      expect(mine?.time, `${pdf.name} judged score`).toBe(pdf.time);
      expect(mine?.pdfPoints, `${pdf.name} meet points`).toBe(pdf.points);
      expect(mine?.rank, `${pdf.name} place`).toBe(pdf.rank);
    }
  });

  it('gives the ninth-place diver 9 points and the eight finalists none from prelims', () => {
    // The prelims table awards nothing to the eight who advanced -- their
    // points come from the finals table -- but the ninth diver, who did not
    // advance, scores 9th place. A parser that read the dashes as zeros, or
    // that skipped the prelims table, would lose that swim.
    const prelims = parses
      .flatMap((p) => p.rounds.filter((r) => /Prelim/i.test(r.round ?? '')))
      .flatMap((r) => r.swims);
    const scoring = prelims.filter((s) => s.meetScore !== undefined);
    expect(scoring.map((s) => s.meetScore)).toStrictEqual([9, 9]);
    for (const s of scoring) expect(s.result.place).toBe(9);
  });

  it('adds 360 meet points that used to be missing entirely', () => {
    const total = rows.reduce((sum, r) => sum + (r.pdfPoints ?? 0), 0);
    expect(total).toBe(360);
    expect(rows).toHaveLength(47);
  });

  it('never puts a judged score in a time field', () => {
    // `finalTime` is for times. A judged 503.95 there would be compared against
    // cut standards and sorted against real swims.
    for (const p of parses) {
      for (const round of p.rounds) {
        for (const swim of round.swims) {
          expect(swim.result.finalTime, `${swim.entry.athleteName}`).toBeUndefined();
          expect(swim.result.rawTimeToken).toMatch(/^\d+\.\d{2}$/);
        }
      }
    }
  });

  it('reports no warnings at all on a diving page', () => {
    // "1M Diving" is a well-formed label naming a board, not a malformed
    // distance. Warning about it put four review-severity notes in front of a
    // coach on a page that parsed perfectly.
    for (const { ref, page } of PAGES_ON_DISK) {
      const result = parseMeetEventResultsHtml(
        page.html,
        { sourceUrl: page.url, retrievedAt: 'x', track: 'browser-extension' } as never,
        {} as never,
      );
      expect(result.ok).toBe(true);
      expect(result.ok ? result.warnings.map((w) => w.code) : ['did not parse'], `event ${ref}`).toStrictEqual([]);
    }
  });

  it('leaves a diving board out of the distance field', () => {
    // A 1M board is not a 1-metre swim. Putting it in `distance` would make it
    // sortable and comparable against one.
    for (const p of parses) expect(p.event.distance).toBeUndefined();
  });
});
