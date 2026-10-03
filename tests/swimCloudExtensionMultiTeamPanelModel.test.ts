/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `extensions/swimcloud-companion/src/multiTeamPanelModel.ts`: the text and rows
 * of the multi-team panel. Pure; no DOM.
 */
import { describe, expect, it } from 'vitest';

import {
  CONFERENCE_NOT_SUPPORTED_NOTE,
  defaultSeasonLabel,
  describeTargetInput,
  formatDriverState,
  formatScopeNote,
  formatSummary,
} from '../extensions/swimcloud-companion/src/multiTeamPanelModel';
import type { MultiTeamDriverState, MultiTeamSummary } from '../extensions/swimcloud-companion/src/multiTeamDriver';
import { addSwimmers, createQueue, markDone, nextWork, queueProgress } from '../extensions/swimcloud-companion/src/multiTeamQueue';
import { parseTeamSeasonOptions } from '../packages/swimcloud/src/teamSeasons';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORM = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swimcloud', 'team-412-roster-gender-F-season-form.html'), 'utf8');
const OPTIONS = parseTeamSeasonOptions(FORM);

describe('describeTargetInput', () => {
  it('splits teams, conferences and rejected lines, each with a reason', () => {
    const parsed = describeTargetInput(
      [
        'https://www.swimcloud.com/team/412/',
        'https://www.swimcloud.com/team/412/roster/?gender=F',
        'https://www.swimcloud.com/team/10002824/',
        'https://www.swimcloud.com/country/usa/college/conference/NSISC/',
        'https://example.com/team/5/',
        'https://www.swimcloud.com/team/58/facilities/',
        'justwords',
      ].join('\n'),
    );
    expect(parsed.teamIds).toEqual(['412', '10002824']);
    expect(parsed.conferences).toEqual([{ text: 'usa/nsisc', message: CONFERENCE_NOT_SUPPORTED_NOTE }]);
    expect(parsed.rejected.map((r) => r.text)).toEqual(['https://example.com/team/5/', 'https://www.swimcloud.com/team/58/facilities/', 'justwords']);
    expect(parsed.rejected.map((r) => r.message)).toEqual([
      'not a www.swimcloud.com link',
      "a path SwimCloud's robots.txt does not allow",
      'not a link (it must start with https://)',
    ]);
  });

  it('says the conference text the coach asked for, and puts no conference in teamIds', () => {
    expect(CONFERENCE_NOT_SUPPORTED_NOTE).toBe('conference pages are not supported yet (waiting for a captured conference page)');
    const parsed = describeTargetInput('https://www.swimcloud.com/country/usa/college/conference/nsisc/');
    expect(parsed.teamIds).toEqual([]);
    expect(parsed.conferences).toHaveLength(1);
  });

  it('returns empty lists for empty text', () => {
    expect(describeTargetInput('  \n ')).toEqual({ teamIds: [], conferences: [], rejected: [] });
  });
});

describe('defaultSeasonLabel', () => {
  it('uses the season the page marks as current', () => {
    expect(defaultSeasonLabel(OPTIONS)).toBe('2025-2026');
  });
});

describe('formatScopeNote', () => {
  it('states the pacing from the constants and the all-time-bests caveat', () => {
    const note = formatScopeNote();
    expect(note).toContain('3 s apart');
    expect(note).toContain('1 at once');
    expect(note).toContain('all-time bests');
    expect(note).toContain('fetched once');
  });
});

describe('formatDriverState', () => {
  const base: MultiTeamDriverState = { phase: 'reading-seasons', seasonReports: [] };

  it('names the phase', () => {
    expect(formatDriverState({ ...base, readingTeamId: '412' }).headline).toBe('Reading the season list of team 412.');
    expect(formatDriverState({ ...base, phase: 'choosing-seasons' }).headline).toContain('Pick a season');
  });

  it('shows a halt reason as the headline', () => {
    expect(formatDriverState({ ...base, phase: 'finished', haltMessage: 'SwimCloud returned a challenge.' }).headline).toBe('Stopped: SwimCloud returned a challenge.');
  });

  it('lists per-team progress and error lines from the queue', () => {
    let queue = createQueue({
      teams: [
        { teamId: '412', seasonLabel: '2025-2026', seasonOptions: OPTIONS },
        { teamId: '58', seasonLabel: '2031-2032', seasonOptions: OPTIONS },
      ],
    });
    const first = nextWork(queue);
    if (first.kind !== 'work') throw new Error('expected work');
    queue = markDone(first.queue, first.work.key);
    queue = addSwimmers(queue, '412', 'M', ['1', '2']);
    const state: MultiTeamDriverState = {
      phase: 'crawling',
      seasonReports: [{ teamId: '9', error: 'The season page for team 9 returned HTTP 404.' }],
      queue: queueProgress(queue),
      notice: 'Rate-limited.',
    };
    const lines = formatDriverState(state);
    expect(lines.teams[0]).toBe('Team 412 · 2025-2026 · rosters 1/2 · swimmers 0/2 · running');
    expect(lines.teams[1]).toBe('Team 58 · 2031-2032 · season not offered, nothing fetched');
    expect(lines.errors[0]).toBe('The season page for team 9 returned HTTP 404.');
    expect(lines.errors[1]).toContain('Team 58 · season 2031-2032 is not offered');
    expect(lines.notice).toBe('Rate-limited.');
    expect(lines.headline).toBe('Crawling.');
  });
});

describe('formatSummary', () => {
  const summary: MultiTeamSummary = {
    outcome: 'halted',
    haltMessage: 'SwimCloud returned a challenge.',
    requestedUrls: [],
    teams: [
      {
        teamId: '412',
        status: 'done-with-errors',
        seasonLabel: '2025-2026',
        seasonId: '29',
        rostersDone: 2,
        rostersFailed: 0,
        swimmersDone: 60,
        swimmersFailed: 1,
        swimmersSkippedResumed: 3,
        rosterRowsWithoutSwimmerId: 2,
        emptyRosterGenders: ['F'],
        errors: ['Team 412 · 2025-2026 · swimmer 5: HTTP 404'],
      },
      { teamId: '58', status: 'season-unavailable', seasonLabel: '2031-2032', availableLabels: ['2025-2026'], rostersDone: 0, rostersFailed: 0, swimmersDone: 0, swimmersFailed: 0, swimmersSkippedResumed: 0, rosterRowsWithoutSwimmerId: 0, emptyRosterGenders: [], errors: [] },
    ],
  };

  it('prints every count the brief names', () => {
    const lines = formatSummary(summary);
    expect(lines[0]).toBe('Stopped: SwimCloud returned a challenge. Finished swimmers are remembered. Start again to continue.');
    expect(lines[1]).toBe(
      'Team 412 · 2025-2026: 2 rosters done, 0 failed; 60 swimmers done, 3 skipped (already finished), 1 failed. Empty roster: women. 2 roster rows have no profile link.',
    );
    expect(lines[2]).toBe('Team 58: season 2031-2032 is not offered on its page. Nothing fetched. Available: 2025-2026.');
    expect(lines[3]).toBe('Team 412 · 2025-2026 · swimmer 5: HTTP 404');
  });

  it('says Done for a completed run', () => {
    expect(formatSummary({ outcome: 'completed', teams: [], requestedUrls: [] })[0]).toBe('Done.');
  });
});
