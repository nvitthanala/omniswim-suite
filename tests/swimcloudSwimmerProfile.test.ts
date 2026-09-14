/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for `parseSwimmerProfileHtml` against the hand-authored, explicitly
 * synthetic fixture `tests/fixtures/swimcloud-synthetic-swimmer-profile.html`.
 * See that fixture's own header, and `parseSwimmerProfileHtml`'s doc comment
 * in `packages/swimcloud/src/parser.ts`, for what's unverified here — notably
 * whether this table is even present in a captured page without a tab click
 * first.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSwimmerProfileHtml, type SwimCloudParseContext } from '@omniswim/swimcloud';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

function contextFor(sourceUrl: string): SwimCloudParseContext {
  return { sourceUrl, retrievedAt: '2026-09-07T00:00:00.000Z', track: 'synthetic-fixture' };
}

function warningCodes(warnings: readonly { code: string }[]): string[] {
  return warnings.map((warning) => warning.code);
}

const html = fixture('swimcloud-synthetic-swimmer-profile.html');
const context = contextFor('https://www.swimcloud.com/swimmer/3646504/');

describe('parseSwimmerProfileHtml — the happy path', () => {
  it('reads all six rows: five parsed, one skipped for an empty event cell', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}: ${result.failure.message}`);

    expect(result.data.swimCloudSwimmerId).toBe('3646504');
    expect(result.data.name).toBe('Landon Dehn');
    expect(result.data.rowCount).toBe(6);
    expect(result.data.personalBests).toHaveLength(5);
  });

  it('resolves a yard event to SCY regardless of an empty course column', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests[0]).toEqual({
      label: '100 Yard Butterfly',
      course: 'SCY',
      stroke: 'Butterfly',
      distance: 100,
      time: '49.87',
      date: '2026-02-19',
      meetName: '2026 NSISC Championships',
    });
  });

  it('reads an explicit Course column for a metric event', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests[1]).toEqual({
      label: '200 Meter Freestyle',
      course: 'LCM',
      stroke: 'Freestyle',
      distance: 200,
      time: '1:48.30',
      date: '2025-07-12',
      meetName: 'Summer Nationals',
    });
  });

  it('leaves course unknown for a metric event with no course column and no defaultCourse, and flags it', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests[2]).toEqual({
      label: '400 Meter Individual Medley',
      course: 'unknown',
      stroke: 'Individual Medley',
      distance: 400,
      time: '4:22.10',
    });
    const warning = result.warnings.find(
      (w) => w.code === 'ambiguous-metric-course' && w.raw === '400 Meter Individual Medley',
    );
    expect(warning).toBeDefined();
  });

  it('a defaultCourse option resolves that same row instead of leaving it unknown', () => {
    const result = parseSwimmerProfileHtml(html, context, { defaultCourse: 'LCM' });
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests[2].course).toBe('LCM');
    expect(
      result.warnings.some((w) => w.code === 'ambiguous-metric-course' && w.raw === '400 Meter Individual Medley'),
    ).toBe(false);
  });

  it('parses a relay-labeled row with a relay stroke, not a plain one', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests[3]).toEqual({
      label: '200 Yard Freestyle Relay',
      course: 'SCY',
      stroke: 'Freestyle Relay',
      distance: 200,
      time: '1:34.12',
      date: '2026-02-18',
      meetName: '2026 NSISC Championships',
    });
  });

  it('preserves a tenths-precision time verbatim rather than padding it to hundredths', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests[4]).toEqual({
      label: '50 Yard Freestyle',
      course: 'SCY',
      stroke: 'Freestyle',
      distance: 50,
      rawTimeToken: '21.4',
    });
    const warning = result.warnings.find((w) => w.code === 'unrecognized-time-token' && w.raw === '21.4');
    expect(warning).toBeDefined();
  });

  it('skips a row with an empty event cell rather than fabricating a label', () => {
    const result = parseSwimmerProfileHtml(html, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.data.personalBests.some((pb) => pb.time === '1:59.99')).toBe(false);
    expect(warningCodes(result.warnings)).toContain('unparsed-row');
  });

  it('marks the whole parse synthetic-fixture-only', () => {
    const result = parseSwimmerProfileHtml(html, context);
    expect(result.confidence).toBe('synthetic-fixture-only');
  });
});

describe('parseSwimmerProfileHtml — a course column that contradicts the label', () => {
  // Regression test for a real bug found by code review (2026-09-07): a
  // "Yard" event label short-circuited straight to SCY without ever
  // consulting an explicit course column, so a contradictory column value
  // (stale markup, a copy-pasted row) was silently discarded with no warning.
  const contradictingHtml = `
    <div class="c-page">
      <h1>Regression Fixture</h1>
      <table>
        <thead><tr><th>Event</th><th>Time</th><th>Course</th></tr></thead>
        <tbody>
          <tr><td>50 Yard Freestyle</td><td>21.40</td><td>LCM</td></tr>
        </tbody>
      </table>
    </div>
  `;
  const context = contextFor('https://www.swimcloud.com/swimmer/3646504/');

  it('still resolves to SCY (the label wins) but flags the contradiction rather than discarding it silently', () => {
    const result = parseSwimmerProfileHtml(contradictingHtml, context);
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);

    expect(result.data.personalBests[0].course).toBe('SCY');

    const warning = result.warnings.find((w) => w.code === 'course-column-contradicts-label');
    expect(warning).toBeDefined();
    expect(warning?.raw).toBe('LCM');
  });

  it('does not warn when the course column simply agrees with the label', () => {
    const agreeingHtml = contradictingHtml.replace('<td>LCM</td>', '<td>SCY</td>');
    const result = parseSwimmerProfileHtml(agreeingHtml, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.warnings.some((w) => w.code === 'course-column-contradicts-label')).toBe(false);
  });

  it('does not warn when the course column is simply empty', () => {
    const emptyColumnHtml = contradictingHtml.replace('<td>LCM</td>', '<td></td>');
    const result = parseSwimmerProfileHtml(emptyColumnHtml, context);
    if (!result.ok) throw new Error('expected success');
    expect(result.warnings.some((w) => w.code === 'course-column-contradicts-label')).toBe(false);
  });
});

describe('parseSwimmerProfileHtml — failure modes', () => {
  it('rejects empty input', () => {
    const result = parseSwimmerProfileHtml('   ', context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('empty-input');
  });

  it('refuses to parse a swimmer page against a team URL', () => {
    const wrongContext = contextFor('https://www.swimcloud.com/team/633/');
    const result = parseSwimmerProfileHtml(html, wrongContext);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('source-url-mismatch');
  });

  it('requires a resolvable swimmer id: neither the URL nor the options name one', () => {
    const result = parseSwimmerProfileHtml(html, contextFor('not-a-url-at-all'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('source-url-mismatch');
  });

  it('accepts a swimmerId option when the capture URL cannot be classified (e.g. a Wayback snapshot)', () => {
    const result = parseSwimmerProfileHtml(html, contextFor('not-a-url-at-all'), { swimmerId: '3646504' });
    if (!result.ok) throw new Error(`expected success, got ${result.failure.code}`);
    expect(result.data.swimCloudSwimmerId).toBe('3646504');
  });

  it('fails loudly when no table exists at all — e.g. the "EVENT PROGRESSION" tab was never opened before capture', () => {
    const noTable = '<div class="c-page"><h1>Landon Dehn</h1><p>Loading…</p></div>';
    const result = parseSwimmerProfileHtml(noTable, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('expected-table-missing');
  });

  it('fails loudly when a table exists but has neither an event nor a time column', () => {
    const wrongColumns = `
      <table><thead><tr><th>Rank</th><th>Score</th></tr></thead>
      <tbody><tr><td>1</td><td>100</td></tr></tbody></table>
    `;
    const result = parseSwimmerProfileHtml(wrongColumns, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('expected-header-missing');
  });
});
