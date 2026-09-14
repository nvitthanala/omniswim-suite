/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `parseSwimmerTimesHtml` against **real** SwimCloud markup.
 *
 * The fixture is a page SwimCloud actually served on 2026-09-09 — River Paulk's
 * times page — captured through the browser extension and archived with its
 * provenance in the file's own header comment. It resolved OQ-4 ("real
 * swimmer-profile page markup") in
 * `docs/reference/SWIMCLOUD_CAPTURE_STATE.json`.
 *
 * Every value asserted here is a value on that page. The row count and the
 * spot-checked rows are snapshots of the source, so a SwimCloud layout change or
 * a parser regression breaks CI instead of quietly returning a shorter bests
 * list. A silently short list is the exact failure mode `CLAUDE.md` calls out:
 * it reads as "that is everything this swimmer has swum", not as an error.
 *
 * The companion home-page capture is here for one job — proving this parser
 * *refuses* that page's narrower "Latest Results" table rather than parsing it
 * as if it were a bests list.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSwimmerTimesHtml, type SwimCloudParseContext } from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

const TIMES_HTML = fixture('swimcloud-real-swimmer-times-1472365.html');
const HOME_HTML = fixture('swimcloud-real-swimmer-home-1472365.html');

/** The real capture URLs, verbatim from the fixtures' provenance headers. */
const TIMES_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/times/',
  retrievedAt: '2026-09-09T03:32:55.480Z',
  track: 'browser-extension',
};

const HOME_CONTEXT: SwimCloudParseContext = {
  sourceUrl: 'https://www.swimcloud.com/swimmer/1472365/',
  retrievedAt: '2026-09-09T03:32:39.435Z',
  track: 'browser-extension',
};

function parseTimes() {
  const result = parseSwimmerTimesHtml(TIMES_HTML, TIMES_CONTEXT);
  if (!result.ok) {
    throw new Error(`expected success, got ${result.failure.code}: ${result.failure.message}`);
  }
  return result;
}

function rowFor(eventLabel: string) {
  const { data } = parseTimes();
  const row = data.personalBests.find((best) => best.eventLabel === eventLabel);
  if (row === undefined) {
    throw new Error(
      `no row for ${eventLabel}; got ${data.personalBests.map((b) => b.eventLabel).join(' | ')}`,
    );
  }
  return row;
}

describe('parseSwimmerTimesHtml — the real swimmer-times capture', () => {
  it('walks the whole Personal Bests table: 9 rows, 9 parsed, none dropped', () => {
    const { data } = parseTimes();
    expect(data.rowCount).toBe(9);
    expect(data.personalBests).toHaveLength(9);
  });

  it('reports real-capture-verified confidence and carries the capture provenance', () => {
    const parsed = parseTimes();
    expect(parsed.confidence).toBe('real-capture-verified');
    expect(parsed.provenance.sourceUrl).toBe('https://www.swimcloud.com/swimmer/1472365/times/');
    expect(parsed.provenance.track).toBe('browser-extension');
  });

  it('takes the swimmer id and name from the page\'s own #swimmer-info JSON', () => {
    const { data } = parseTimes();
    expect(data.swimCloudSwimmerId).toBe('1472365');
    expect(data.swimmerIdSource).toBe('swimmer-info-json');
    // Family name first, exactly as the JSON prints it. Deliberately NOT the
    // `/swimmer/{id}/` page's own "River Paulk" — see the parser's
    // "One name, one source" note.
    expect(data.name).toBe('Paulk, River J');
  });

  it('never reshapes the JSON name into display order', () => {
    const { data } = parseTimes();
    expect(data.name).not.toBe('River Paulk');
  });

  it('reads the 50 Free SCY row: time, meet, meet id, and its NCAA B chip', () => {
    const row = rowFor('50 Free SCY');
    expect(row.time).toBe('19.42');
    expect(row.meetName).toBe('James E Martin Invitational');
    expect(row.swimCloudMeetId).toBe('338673');
    expect(row.eventRef).toBe('32');
    expect(row.swimCloudSwimId).toBe('147489244');
    expect(row.date).toBe('Mar 1, 2025');
    expect(row.tags).toStrictEqual([
      { code: 'NCAA B', title: "NCAA Division I Men's Championships" },
    ]);
    expect(row.relayLeadoff).toBe(false);
  });

  it('reads the 1000 Free SCY row: a minutes:seconds time and an "X" = Extracted chip', () => {
    const row = rowFor('1000 Free SCY');
    expect(row.time).toBe('10:37.48');
    expect(row.meetName).toBe('2020 WT COM Syntal Capital Partners Invitational');
    expect(row.swimCloudMeetId).toBe('178789');
    expect(row.date).toBe('Jan 17, 2020');
    expect(row.tags).toStrictEqual([{ code: 'X', title: 'Extracted' }]);
    // "X" here is the Extracted chip in its own cell, NOT the Hy-Tek exhibition
    // marker `readTime` looks for on a time token. The time is a clean time and
    // no exhibition flag exists on this row's output at all.
    expect(row.rawTimeToken).toBeUndefined();
  });

  it('reads a row with NO chip at all — most rows have none', () => {
    const row = rowFor('50 Free LCM');
    expect(row.time).toBe('22.33');
    expect(row.meetName).toBe('USA Swimming Futures Championship - Ocala');
    expect(row.swimCloudMeetId).toBe('308419');
    expect(row.date).toBe('Jul 26, 2025');
    expect(row.tags).toStrictEqual([]);
    expect(row.relayLeadoff).toBe(false);
  });

  it('flags the leadoff split from title="Leadoff", never from the visible "R"', () => {
    const row = rowFor('50 Back SCY');
    expect(row.relayLeadoff).toBe(true);
    expect(row.tags).toStrictEqual([{ code: 'R', title: 'Leadoff' }]);
    // The chip's visible text is a single letter; nothing keys off it.
    expect(row.tags[0].code).not.toBe('Leadoff');
  });

  it('derives course from the label suffix, so SCY and LCM of one event stay separate rows', () => {
    const scy = rowFor('50 Free SCY');
    const lcm = rowFor('50 Free LCM');
    expect(scy.course).toBe('SCY');
    expect(lcm.course).toBe('LCM');
    expect(scy.distance).toBe(50);
    expect(lcm.distance).toBe(50);
    expect(scy.stroke).toBe('Freestyle');
    expect(lcm.stroke).toBe('Freestyle');
    // Same stroke, same distance, different course — and therefore different
    // swims at different meets. Scoring one against the other's standard is the
    // silently-wrong number this derivation exists to prevent.
    expect(scy.swimKey).not.toBe(lcm.swimKey);
  });

  it('derives distance, stroke and course for every real row on the page', () => {
    const { data } = parseTimes();
    expect(
      data.personalBests.map((b) => `${b.eventLabel} -> ${b.distance ?? '?'} ${b.stroke} ${b.course}`),
    ).toStrictEqual([
      '50 Free SCY -> 50 Freestyle SCY',
      '50 Free LCM -> 50 Freestyle LCM',
      '100 Free SCY -> 100 Freestyle SCY',
      '100 Free LCM -> 100 Freestyle LCM',
      '200 Free SCY -> 200 Freestyle SCY',
      '1000 Free SCY -> 1000 Freestyle SCY',
      '50 Back SCY -> 50 Backstroke SCY',
      '200 IM LCM -> 200 Individual Medley LCM',
      '400 IM SCY -> 400 Individual Medley SCY',
    ]);
  });

  it('keys every swim on the same {meetId}:swim:{swimId} scheme parseTeamMeetSwimsHtml uses', () => {
    const { data } = parseTimes();
    expect(rowFor('50 Free SCY').swimKey).toBe('338673:swim:147489244');
    expect(rowFor('400 IM SCY').swimKey).toBe('178791:swim:34896174');
    // Every row of this capture carries a swim link, so no row falls back to a
    // composite key.
    expect(data.personalBests.every((b) => b.swimCloudSwimId !== undefined)).toBe(true);
    expect(new Set(data.personalBests.map((b) => b.swimKey)).size).toBe(9);
  });

  it('keys events on {meetId}:event:{eventRef}, so two events of one meet stay distinct', () => {
    // Both 50 Free SCY and 100 Free SCY were swum at meet 338673, at events 32
    // and 14. Same meet, different events.
    expect(rowFor('50 Free SCY').eventId).toBe('338673:event:32');
    expect(rowFor('100 Free SCY').eventId).toBe('338673:event:14');
  });

  it('keeps the date verbatim — never a Date, never an ISO string', () => {
    const { data } = parseTimes();
    expect(data.personalBests.map((b) => b.date)).toStrictEqual([
      'Mar 1, 2025',
      'Jul 26, 2025',
      'Feb 28, 2025',
      'Jul 24, 2025',
      'Dec 8, 2023',
      'Jan 17, 2020',
      'Mar 4, 2022',
      'Jun 17, 2022',
      'Feb 21, 2020',
    ]);
    for (const best of data.personalBests) {
      expect(typeof best.date).toBe('string');
      expect(best.date).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('proves the date is per-swim, not the meet\'s: one meet, two different dates', () => {
    // Both rows name meet 338673 (James E Martin Invitational), on Mar 1 and
    // Feb 28. That is why this date is not run through the meet-date reader.
    const fifty = rowFor('50 Free SCY');
    const hundred = rowFor('100 Free SCY');
    expect(fifty.swimCloudMeetId).toBe(hundred.swimCloudMeetId);
    expect(fifty.date).not.toBe(hundred.date);
  });

  it('warns about nothing on this capture — every row parsed cleanly', () => {
    const parsed = parseTimes();
    expect(parsed.warnings).toStrictEqual([]);
  });
});

describe('parseSwimmerTimesHtml — id resolution', () => {
  it('falls back to the capture URL when the page carries no #swimmer-info block', () => {
    const stripped = TIMES_HTML.replace(/<script id="swimmer-info"[\s\S]*?<\/script>/i, '');
    const result = parseSwimmerTimesHtml(stripped, TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.data.swimCloudSwimmerId).toBe('1472365');
    expect(result.data.swimmerIdSource).toBe('capture-url');
    expect(result.data.name).toBeUndefined();
    // Still nine real rows: the identity block is not what the table depends on.
    expect(result.data.personalBests).toHaveLength(9);
  });

  it('lets a caller assertion outrank the page, and says so when they disagree', () => {
    const result = parseSwimmerTimesHtml(TIMES_HTML, TIMES_CONTEXT, { swimmerId: '999' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.data.swimCloudSwimmerId).toBe('999');
    expect(result.data.swimmerIdSource).toBe('caller-supplied');
    expect(result.warnings.map((w) => w.code)).toContain('contradicted-page-declaration');
  });

  it('reports unreadable embedded JSON rather than throwing', () => {
    const broken = TIMES_HTML.replace(
      /<script id="swimmer-info" type="application\/json">[\s\S]*?<\/script>/i,
      '<script id="swimmer-info" type="application/json">{not json</script>',
    );
    const result = parseSwimmerTimesHtml(broken, TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.warnings.map((w) => w.code)).toContain('unreadable-embedded-json');
    expect(result.data.swimCloudSwimmerId).toBe('1472365');
    expect(result.data.swimmerIdSource).toBe('capture-url');
    expect(result.data.name).toBeUndefined();
  });

  it('rejects a capture URL that names another resource', () => {
    const result = parseSwimmerTimesHtml(TIMES_HTML, {
      ...TIMES_CONTEXT,
      sourceUrl: 'https://www.swimcloud.com/team/58/roster/',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('source-url-mismatch');
  });
});

describe('parseSwimmerTimesHtml — refuses shapes that are not this table', () => {
  it('refuses the swimmer home page\'s narrower "Latest Results" table', () => {
    // That table has Event and Time but no Meet and no Date, and it holds one
    // selected meet's swims — not career bests. Parsing it as bests would return
    // plausible, wrong rows, so the parser fails loudly instead.
    const result = parseSwimmerTimesHtml(HOME_HTML, HOME_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('expected-header-missing');
    expect(result.failure.message).toContain('Latest Results');
  });

  it('fails on empty input rather than returning an empty bests list', () => {
    const result = parseSwimmerTimesHtml('   ', TIMES_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('empty-input');
  });

  it('fails when the page carries no table at all', () => {
    const result = parseSwimmerTimesHtml('<html><body><p>Nothing here</p></body></html>', TIMES_CONTEXT);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('expected-table-missing');
  });

  it('treats a bests table with no rows as a real "no times yet" answer, not a failure', () => {
    const emptied = TIMES_HTML.replace(/<tbody>[\s\S]*?<\/tbody>/i, '<tbody></tbody>');
    const result = parseSwimmerTimesHtml(emptied, TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.data.personalBests).toStrictEqual([]);
    expect(result.data.rowCount).toBe(0);
    expect(result.warnings.map((w) => w.code)).toContain('zero-data-rows');
    // Absent is not empty: the swimmer is still identified.
    expect(result.data.swimCloudSwimmerId).toBe('1472365');
  });
});

describe('parseSwimmerTimesHtml — column and link rules the real page cannot exercise', () => {
  it('finds the badge column by elimination, not at a fixed index', () => {
    // The real page's badge column is the third. It has an EMPTY <th>, so it
    // cannot be located by printed label like every other column here. This
    // inserts a second unlabelled column ahead of it — if the parser had
    // hardcoded index 2, the chips would move out of reach and vanish.
    const shifted = TIMES_HTML.replace(
      '<tr><th>Event</th>',
      '<tr><th></th><th>Event</th>',
    ).replace(
      /<tr><td class="u-text-truncate"><button/g,
      '<tr><td class="u-pl0"></td><td class="u-text-truncate"><button',
    );
    const result = parseSwimmerTimesHtml(shifted, TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const row = result.data.personalBests.find((b) => b.eventLabel === '50 Free SCY');
    expect(row?.tags).toStrictEqual([
      { code: 'NCAA B', title: "NCAA Division I Men's Championships" },
    ]);
    expect(result.data.personalBests).toHaveLength(9);
  });

  it('takes the meet id from the time link, and reports a meet-link disagreement', () => {
    // The two links agree on every row of the real capture, so this forces the
    // disagreement. The time link wins because it is the link that also names
    // the event and the swim — attaching a swim id to the wrong meet is the
    // failure this precedence prevents.
    const conflicted = TIMES_HTML.replace(
      'href="/results/338673">James E Martin Invitational',
      'href="/results/999999">James E Martin Invitational',
    );
    const result = parseSwimmerTimesHtml(conflicted, TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const row = result.data.personalBests.find((b) => b.eventLabel === '50 Free SCY');
    expect(row?.swimCloudMeetId).toBe('338673');
    expect(row?.swimKey).toBe('338673:swim:147489244');
    expect(result.warnings.map((w) => w.code)).toContain('contradicted-page-declaration');
  });

  it('keeps a row whose time cell carries no link, and says the ids are missing', () => {
    const unlinked = TIMES_HTML.replace(
      '<a href="/results/338673/event/32/?id=147489244#time147489244">19.42</a>',
      '19.42',
    );
    const result = parseSwimmerTimesHtml(unlinked, TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const row = result.data.personalBests.find((b) => b.eventLabel === '50 Free SCY');
    // The time is still real and still read; only the ids are absent.
    expect(row?.time).toBe('19.42');
    expect(row?.swimCloudSwimId).toBeUndefined();
    expect(row?.eventRef).toBeUndefined();
    // The event id falls back to a capture-local key whose prefix says so.
    expect(row?.eventId).toBe('swimmer-times:event-label:50 free scy');
    // The meet is still known — from the row's own meet-name link.
    expect(row?.swimCloudMeetId).toBe('338673');
    expect(result.warnings.map((w) => w.code)).toContain('missing-swim-link');
  });
});

describe('parseSwimmerTimesHtml — labels it has not seen', () => {
  const withLabel = (label: string): string =>
    TIMES_HTML.replace('>50 Free SCY<', `>${label}<`);

  it('warns and leaves course unknown for a label outside the expected shape', () => {
    const result = parseSwimmerTimesHtml(withLabel('1 mtr Diving'), TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const row = result.data.personalBests[0];
    expect(row.eventLabel).toBe('1 mtr Diving');
    expect(row.course).toBe('unknown');
    expect(result.warnings.map((w) => w.code)).toContain('unrecognized-event-label');
    // Never defaulted to yards, and the other eight rows are untouched.
    expect(result.data.personalBests).toHaveLength(9);
  });

  it('warns and leaves course unknown for an unknown trailing course token', () => {
    const result = parseSwimmerTimesHtml(withLabel('50 Free XYZ'), TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const row = result.data.personalBests[0];
    expect(row.course).toBe('unknown');
    expect(row.distance).toBe(50);
    expect(row.stroke).toBe('Freestyle');
    expect(result.warnings.map((w) => w.code)).toContain('unrecognized-course-token');
  });

  it('warns and records an unknown stroke rather than guessing one', () => {
    const result = parseSwimmerTimesHtml(withLabel('50 Wobble SCY'), TIMES_CONTEXT);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    const row = result.data.personalBests[0];
    expect(row.stroke).toBe('unknown');
    expect(row.course).toBe('SCY');
    expect(result.warnings.map((w) => w.code)).toContain('unmapped-stroke');
  });
});
