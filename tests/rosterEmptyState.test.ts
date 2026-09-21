/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * A roster page that says "no roster" is an answer, not a parse failure.
 *
 * ## The case these were written against
 *
 * A real crawl reported:
 *
 *   Could not parse https://www.swimcloud.com/team/10002824/roster/?gender=M:
 *   No <table> element was found; a roster page is expected to contain one.
 *
 * Team 10002824 is the University of West Florida, which fields women's
 * swimming and diving and no men's programme — the exact example `CLAUDE.md`
 * uses for `sponsoredGenders`. The page returns HTTP 200 with the full site
 * chrome and SwimCloud's own "No rosters found" empty state where the table
 * would be. There is nothing wrong with it.
 *
 * Reporting that as a failure breaks the rule the rest of this package is built
 * on: absent is not the same as empty. It also buries real failures, because a
 * coach reading a list of forty "could not parse" lines cannot tell which ones
 * matter. The sibling swims parser already got this right — it emits
 * `zero-data-rows` and says so in the message.
 *
 * The second case here is the same idea one level down: SwimCloud prints a dash
 * in the class-year column when it has no class year, which is the page saying
 * "I do not know", not a word outside the vocabulary.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseTeamRosterHtml } from '../packages/swimcloud/src/parser';

const PAGES = path.resolve(__dirname, '..', 'data', 'swimcloud-captures', 'pages');

/** The real stored body for one captured URL, or undefined on a clean checkout. */
function storedPage(match: (name: string) => boolean): string | undefined {
  if (!fs.existsSync(PAGES)) return undefined;
  const file = fs.readdirSync(PAGES).find(match);
  if (!file) return undefined;
  const entry = JSON.parse(fs.readFileSync(path.join(PAGES, file), 'utf-8')) as { html?: string };
  return entry.html;
}

const UWF_MEN = storedPage(
  n => n.includes('10002824') && n.includes('roster') && n.includes('gender_3d_M'),
);

/** Minimal page carrying the empty state, for the clean-checkout path. */
const SYNTHETIC_EMPTY = `<!doctype html><html><head><title>Roster - Test University</title></head>
<body><main><h1>Test University</h1><p>No rosters found</p>
<p>Try adjusting your search by changing your filters.</p></main></body></html>`;

const CONTEXT = {
  sourceUrl: 'https://www.swimcloud.com/team/10002824/roster/?gender=M',
  retrievedAt: '2026-09-21T00:00:00.000Z',
} as const;

describe('a roster page with no table', () => {
  it('is a success carrying no-roster-posted when the page says "No rosters found"', () => {
    const result = parseTeamRosterHtml(SYNTHETIC_EMPTY, CONTEXT as never, {} as never);
    expect(result.ok, 'the empty state is an answer, not a failure').toBe(true);
    if (!result.ok) return;
    expect(result.data.athletes).toStrictEqual([]);
    expect(result.warnings.map(w => w.code)).toContain('no-roster-posted');
    // The message has to say it is real, or a coach reads an empty list as a bug.
    const warning = result.warnings.find(w => w.code === 'no-roster-posted');
    expect(warning?.message).toMatch(/real answer/i);
  });

  it('is still a FAILURE when the page carries no empty state either', () => {
    // The guard must not turn every missing table into a shrug. A page that is
    // neither a roster nor an empty state is a genuine parse failure and has to
    // keep reporting as one.
    const notARosterPage = `<!doctype html><html><head><title>Something else</title></head>
      <body><p>Unrelated content with no table and no empty state.</p></body></html>`;
    const result = parseTeamRosterHtml(notARosterPage, CONTEXT as never, {} as never);
    expect(result.ok).toBe(false);
  });

  it.skipIf(UWF_MEN === undefined)(
    'reads the real University of West Florida men\'s page as no-roster-posted',
    () => {
      const result = parseTeamRosterHtml(UWF_MEN as string, CONTEXT as never, {} as never);
      expect(result.ok, 'UWF fields no men\'s programme; that is an answer').toBe(true);
      if (!result.ok) return;
      expect(result.data.athletes).toStrictEqual([]);
      expect(result.warnings.map(w => w.code)).toContain('no-roster-posted');
    },
  );
});
