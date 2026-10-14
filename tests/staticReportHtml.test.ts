/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F8: the static HTML report and lineup. One self-contained file, no server, no script.
 * The relay rows come from `tests/fixtures/nsisc-2026-relay-followups-r1.json`
 * (2026 NSISC Championships, Henderson State).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  Gender,
  type PlannedSwimEntry,
  type SwimmerResult,
  type TeamScore,
  type Workspace,
} from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { canonicalSwimmerName, simulateRoster } from '@omniswim/core/lib/utils';
import {
  REPORT_DASH,
  buildStaticReportHtml,
  escapeHtml,
  reportDate,
} from '../packages/manager/src/lib/staticReportHtml';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const HSU = 'Henderson State University';
const OTHER = 'Other University';
const M_400FR = 'Event 42 Men 4x100 Yard Freestyle Relay';
const GENERATED = new Date(2026, 9, 14, 12, 0, 0);

const fixture = JSON.parse(
  readFileSync(join(repoRoot, 'tests', 'fixtures', 'nsisc-2026-relay-followups-r1.json'), 'utf8')
) as { menResults: SwimmerResult[] };
const menResults = fixture.menResults.filter(r => !r.isRelay || r.event === M_400FR);

function entry(over: Partial<PlannedSwimEntry>): PlannedSwimEntry {
  return {
    id: 'e',
    name: 'Colton Bennett',
    team: HSU,
    gender: Gender.MEN,
    classYear: 'JR',
    event: 'Event 4 Men 1000 Yard Freestyle',
    time: '9:26.63',
    timeType: 'SCY',
    source: 'manual',
    active: true,
    ...over,
  };
}

function workspaceWith(entries: PlannedSwimEntry[], over: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-private-id-123',
    name: 'HSU 2026-27',
    createdAt: 0,
    menResults,
    womenResults: [],
    recruits: [],
    meetEntryPlans: entries,
    activeEntryIds: [],
    athleteHistory: [],
    relayLegOverrides: [],
    deletedSwimmers: [{ name: 'Scott Doll', gender: Gender.MEN }],
    scorerRosterOverrides: [],
    officialTeamScores: { men: { [HSU]: 400 }, women: {} },
    ...over,
  } as unknown as Workspace;
}

function bundle(timeTrialLeg?: number): ScoringBundle {
  const excluded = new Set([canonicalSwimmerName('Scott Doll')]);
  const scored = simulateRoster(menResults, [], false, excluded, [], new Set(), [], undefined);
  const rows =
    timeTrialLeg === undefined
      ? scored
      : scored.map(r =>
          r.isRelay && r.team === HSU && r.relayLegIndex === timeTrialLeg
            ? { ...r, relayLegTimeTrial: true as const }
            : r
        );
  const hsu: TeamScore = { teamName: HSU, totalPoints: 412.5, swimmers: [], color: 'teal' };
  const other: TeamScore = { teamName: OTHER, totalPoints: 100, swimmers: [], color: 'red' };
  return {
    allResults: rows,
    allScored: rows,
    events: [],
    visibleEvents: [],
    sortedTeams: [hsu, other],
    timelineData: [],
    teamStyleSignature: '',
  };
}

function render(
  entries: PlannedSwimEntry[],
  opts: { team?: string; workspace?: Partial<Workspace>; timeTrialLeg?: number } = {}
) {
  return buildStaticReportHtml({
    workspace: workspaceWith(entries, opts.workspace),
    scoringBundle: bundle(opts.timeTrialLeg),
    gender: Gender.MEN,
    team: opts.team ?? HSU,
    generatedAt: GENERATED,
  });
}

describe('escapeHtml', () => {
  it('escapes the five characters that open markup or an attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });
});

describe('static report HTML', () => {
  it('(a) escapes a script tag in a swimmer, team and workspace name', () => {
    const evil = '<script>alert(1)</script>';
    const { content } = render([entry({ id: 'x', name: evil })], {
      workspace: { name: `WS ${evil}` },
    });
    expect(content).not.toContain(evil);
    expect(content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(content).not.toContain('<script');
  });

  it('(a) escapes a team name that holds markup', () => {
    const team = 'Bad "Team" <img src=x onerror=alert(1)>';
    const hsu: TeamScore = { teamName: team, totalPoints: 10, swimmers: [], color: 'teal' };
    const b = { ...bundle(), sortedTeams: [hsu] };
    const { content } = buildStaticReportHtml({
      workspace: workspaceWith([entry({ id: 'x', team })]),
      scoringBundle: b,
      gender: Gender.MEN,
      team,
      generatedAt: GENERATED,
    });
    expect(content).not.toContain('<img');
    expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('(b) prints a dash, never 0, where a time or a team total is absent', () => {
    const { content } = render([
      entry({ id: 'a', name: 'Has Time', time: '9:26.63' }),
      entry({ id: 'b', name: 'Blank Time', time: '' }),
      entry({ id: 'c', name: 'Zero Time', time: '0.00' }),
    ]);
    const row = (name: string) => {
      const m = content.match(new RegExp(`<tr><td>${name}</td>.*?</tr>`));
      expect(m, name).not.toBeNull();
      return m![0];
    };
    expect(row('Has Time')).toContain('<td class="mono">9:26.63</td>');
    expect(row('Blank Time')).toContain(`<td class="mono">${REPORT_DASH}</td>`);
    expect(row('Zero Time')).toContain(`<td class="mono">${REPORT_DASH}</td>`);
    expect(content).not.toContain('0.00');
    // Other University has no official total: the actual column is a dash, not 0.0.
    const other = content.match(new RegExp(`<tr><td class="num">2</td><td>${OTHER}</td>.*?</tr>`));
    expect(other![0]).toBe(
      `<tr><td class="num">2</td><td>${OTHER}</td><td class="num mono">100.0</td><td class="num mono">${REPORT_DASH}</td></tr>`
    );
  });

  it('(b) prints dashes for actual points when the workspace holds no official totals', () => {
    const { content } = render([entry({})], { workspace: { officialTeamScores: undefined } });
    expect(content).toContain('No official meet totals are stored');
    expect(content).not.toMatch(/<td class="num mono">0\.0<\/td>/);
  });

  it('(c) holds no external URL, no script and no event handler', () => {
    const { content } = render([entry({ id: 'a' }), entry({ id: 'b', time: '' })]);
    expect(content).not.toMatch(/https?:\/\//i);
    expect(content).not.toContain('<script');
    expect(content).not.toMatch(/<(link|img|iframe|object|embed|video|audio|source)\b/i);
    expect(content).not.toMatch(/\bon[a-z]+\s*=/i);
    expect(content).not.toMatch(/url\(/i);
    expect(content).not.toMatch(/@import/i);
  });

  it('holds no workspace id, path or account data', () => {
    const { content } = render([entry({})]);
    expect(content).not.toContain('ws-private-id-123');
    expect(content).not.toMatch(/[A-Za-z]:\\|\/Users\/|@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  it('labels a relay leg filled from a time trial', () => {
    const { content } = render([entry({})], { timeTrialLeg: 1 });
    expect(content).toContain('Time trial');
    const plain = render([entry({})]).content;
    expect(plain).not.toMatch(/<span class="tag">Time trial<\/span>/);
  });

  it('writes a legend, the footer and a dated file name', () => {
    const report = render([entry({})]);
    expect(report.content).toContain('<h2>Key terms</h2>');
    expect(report.content).toContain(
      'Generated by Omniswim Suite from the workspace as saved on 2026-10-14; projections are estimates from published times.'
    );
    expect(report.filename).toBe('omniswim-report-hsu-2026-27-2026-10-14.html');
    expect(report.mimeType).toBe('text/html;charset=utf-8');
    expect(reportDate(GENERATED)).toBe('2026-10-14');
  });

  it('lists scores only, with a note, when no team is selected', () => {
    const report = render([entry({})], { team: '' });
    expect(report.cardCount).toBe(0);
    expect(report.content).toContain('No team was selected');
    expect(report.content).toContain('Team scores');
  });

  it('matches the snapshot for a small fixture workspace', () => {
    const report = render(
      [
        entry({ id: 'a', name: 'Colton Bennett', time: '9:26.63' }),
        entry({ id: 'b', name: 'Blank Time', time: '' }),
        entry({ id: 'c', name: 'Fast Fifty', event: 'Event 8 Men 50 Yard Freestyle', time: '20.95' }),
      ],
      { timeTrialLeg: 1 }
    );
    expect(report.content).toMatchSnapshot();
  });
});
