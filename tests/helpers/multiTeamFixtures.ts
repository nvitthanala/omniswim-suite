/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The stored SwimCloud pages and swimmer body the multi-team driver tests read, with no import of the
 * extension. `multiTeamDriverHarness.ts` re-exports these. A test that only needs the bytes (the
 * theoretical-meet tests) imports this file, so it does not pull the extension source into its program.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = dirname(fileURLToPath(import.meta.url)); // tests/helpers
export const fixturesDir = join(here, '..', 'fixtures', 'swimcloud');
export const SWIMMER_BODY = readFileSync(join(here, '..', 'fixtures', 'profile_fastest_times-1330318.json'), 'utf8');

export type RosterGender = 'M' | 'F';
export const rosterPage = (team: string, gender: RosterGender): string =>
  readFileSync(join(fixturesDir, `team-${team}-roster-gender-${gender}-page.html`), 'utf8');

export const PAGES: Record<string, string> = {};
for (const team of ['412', '10002824']) for (const g of ['M', 'F'] as const) PAGES[`${team}|${g}`] = rosterPage(team, g);
