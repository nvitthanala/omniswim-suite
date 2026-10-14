/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * F8: a static HTML report and lineup that needs no server.
 *
 * The share and report routes return 503 without Postgres auth. This builder runs in the browser
 * and returns one self-contained `.html` string: inline CSS, no script, no external request,
 * printable. It reads the same data the printable cards and the meet-day view read
 * (`buildPrintCards`, the scored `ScoringBundle`, `workspace.officialTeamScores`). Nothing is
 * scored again here.
 *
 * Absent is not zero. A value the workspace does not hold prints as a dash. Every string that
 * came from a workspace (names, teams, meet label) goes through `escapeHtml`. The file holds
 * no workspace id, no path, no token and no account data.
 */

import { Gender, type Workspace } from '@omniswim/core/types';
import type { ScoringBundle } from '@omniswim/core/lib/useWorkspaceScoring';
import { buildTeamScoreLookup, officialScoresForGender } from '@omniswim/core/lib/teamScoreMatching';
import { PRINT_ABSENT, PRINT_NO_TIME, buildPrintCards } from '../components/printCardsView';
import type { PrintEventCard, PrintRelayCard } from '../components/printCardsView';
import { RELAY_LEG_TIME_TRIAL_LABEL } from '../components/RelayEligibleSwimmersPanel';
import { PRINT_ESTIMATE_LABEL } from '../components/PrintCards';

/** What the report prints where a value is not held. Never `0`. */
export const REPORT_DASH = PRINT_ABSENT;

export type StaticReportInput = {
  workspace: Workspace;
  scoringBundle: ScoringBundle;
  gender: Gender;
  /** The team whose lineup and relays the report lists. `''` lists no lineup. */
  team: string;
  /** Passed in so the output is reproducible. */
  generatedAt: Date;
};

export type StaticReport = {
  filename: string;
  mimeType: string;
  content: string;
  /** Event cards plus relay cards written for the team. */
  cardCount: number;
};

/** Escape text for HTML element content and for a double- or single-quoted attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `YYYY-MM-DD` in the viewer's local time. */
export function reportDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function esc(value: string | null | undefined): string {
  return escapeHtml(value ?? '');
}

/** Points to one decimal, or a dash. A non-finite value is absent, not 0. */
function points(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : REPORT_DASH;
}

/** A printed time or text cell: the card's "NT" and blank values become a dash. */
function cell(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  return text === '' || text === PRINT_NO_TIME || text === '-' ? REPORT_DASH : esc(text);
}

function fileSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug === '' ? 'workspace' : slug;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; background: #fff; max-width: 960px; margin: 2rem auto; padding: 0 1rem; line-height: 1.45; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; border-bottom: 2px solid #111; padding-bottom: .2rem; }
  h3 { font-size: 1rem; margin: 0 0 .4rem; }
  .meta { color: #444; font-size: .9rem; margin: 0 0 .25rem; }
  .note { color: #333; font-size: .9rem; margin: .4rem 0 .8rem; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; margin-bottom: .5rem; }
  th, td { border: 1px solid #999; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { background: #eee; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; }
  .card { border: 1px solid #666; border-radius: 6px; padding: .7rem .9rem; margin: 0 0 1rem; break-inside: avoid; page-break-inside: avoid; }
  .tag { display: inline-block; border: 1px solid #111; border-radius: 4px; padding: 0 .35rem; font-size: .75rem; font-weight: 700; margin-left: .4rem; vertical-align: middle; }
  dl { margin: 0; }
  dt { font-weight: 700; margin-top: .5rem; }
  dd { margin: 0 0 0 1rem; }
  footer { margin-top: 2.5rem; padding-top: .6rem; border-top: 1px solid #999; font-size: .85rem; color: #333; }
  @media print { body { margin: 0; max-width: none; } h2 { break-after: avoid; } }
`;

type LegendTerm = { term: string; meaning: string };

function legendTerms(): LegendTerm[] {
  return [
    {
      term: 'Dash (—)',
      meaning:
        'The workspace has no value here. It does not mean zero. A swimmer with a dash has no stored time.',
    },
    {
      term: 'Projected points',
      meaning:
        'Points the app expects a team to score if the lineup swims its stored times. It is an estimate, not a result.',
    },
    {
      term: 'Actual points',
      meaning:
        'The official team total printed in the meet results PDF. It is only shown when that PDF was loaded.',
    },
    {
      term: 'Seed time',
      meaning: 'The time stored for a swimmer in an event. The meet uses it to rank entries.',
    },
    {
      term: 'Course',
      meaning:
        'The pool length of the stored time. SCY is short course yards, SCM is short course meters, LCM is long course meters.',
    },
    {
      term: 'Class',
      meaning: 'The swimmer’s class year, such as FR, SO, JR or SR.',
    },
    {
      term: 'Round and place',
      meaning:
        'Prelims or finals, and the place the app projects in that round from seed times. A dash means no place is projected.',
    },
    {
      term: 'Relay leg',
      meaning: 'One swimmer’s part of a relay. Leg 1 swims first.',
    },
    {
      term: RELAY_LEG_TIME_TRIAL_LABEL,
      meaning:
        'The leg time comes from a time trial swim, not from the meet. The workspace allows this time to fill a relay leg.',
    },
    {
      term: PRINT_ESTIMATE_LABEL,
      meaning:
        'Nobody swam this relay in the loaded meet. The app built the lineup from individual times, so the relay time is a projection.',
    },
    {
      term: 'Vacant',
      meaning: 'No swimmer is assigned to this relay leg.',
    },
  ];
}

function scoresSection(input: StaticReportInput): string {
  const { workspace, scoringBundle, gender } = input;
  const official = officialScoresForGender(workspace.officialTeamScores, gender);
  const teamNames = scoringBundle.sortedTeams.map(t => t.teamName);
  const actualByTeam = buildTeamScoreLookup(teamNames, official);
  const hasOfficial = official !== undefined && Object.keys(official).length > 0;
  const rows = scoringBundle.sortedTeams
    .map((t, i) => {
      const actual = actualByTeam.get(t.teamName);
      const mine = t.teamName === input.team ? ' <span class="tag">Selected team</span>' : '';
      return (
        `<tr><td class="num">${i + 1}</td><td>${esc(t.teamName)}${mine}</td>` +
        `<td class="num mono">${points(t.totalPoints)}</td>` +
        `<td class="num mono">${points(actual)}</td></tr>`
      );
    })
    .join('');
  const body =
    rows === ''
      ? `<tr><td colspan="4">No team scores are held for this workspace.</td></tr>`
      : rows;
  const officialNote = hasOfficial
    ? ''
    : '<p class="note">No official meet totals are stored in this workspace, so the actual column shows dashes.</p>';
  return (
    `<section><h2>Team scores</h2>` +
    `<p class="note">Projected points are the app’s estimate from stored times. Actual points are the official totals from the meet results PDF.</p>` +
    `<table><thead><tr><th class="num">Rank</th><th>Team</th><th class="num">Projected points</th><th class="num">Actual points (official)</th></tr></thead>` +
    `<tbody>${body}</tbody></table>${officialNote}</section>`
  );
}

function eventCardHtml(card: PrintEventCard): string {
  const rows = card.rows
    .map(
      r =>
        `<tr><td>${cell(r.name)}</td><td>${cell(r.classYear)}</td>` +
        `<td class="mono">${cell(r.seed)}</td><td>${cell(r.course)}</td><td class="num">${cell(r.place)}</td></tr>`
    )
    .join('');
  return (
    `<div class="card"><h3>${esc(card.event)} <span class="meta">Round: ${cell(card.round)}</span></h3>` +
    `<table><thead><tr><th>Swimmer</th><th>Class</th><th>Seed time</th><th>Course</th><th class="num">Projected place</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function relayCardHtml(card: PrintRelayCard): string {
  const rows = card.legs
    .map(leg => {
      const tags = [
        leg.timeTrial ? `<span class="tag">${esc(RELAY_LEG_TIME_TRIAL_LABEL)}</span>` : '',
        // The card names a vacant leg "Vacant". Tag it only when the row still carries a name.
        leg.vacant && leg.name !== 'Vacant' ? '<span class="tag">Vacant</span>' : '',
      ].join('');
      return (
        `<tr><td class="num">${leg.leg}</td><td>${cell(leg.name)}${tags}</td>` +
        `<td class="mono">${cell(leg.time)}</td></tr>`
      );
    })
    .join('');
  const estimate = card.estimate ? `<span class="tag">${esc(PRINT_ESTIMATE_LABEL)} (projected)</span>` : '';
  return (
    `<div class="card"><h3>${esc(card.event)}${estimate} <span class="meta">Round: ${cell(card.round)}</span></h3>` +
    `<p class="meta">Relay time: <span class="mono">${cell(card.teamTime)}</span></p>` +
    `<table><thead><tr><th class="num">Leg</th><th>Swimmer</th><th>Leg time</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function lineupSection(input: StaticReportInput): { html: string; cardCount: number } {
  if (input.team === '') {
    return {
      cardCount: 0,
      html:
        `<section><h2>Lineup</h2>` +
        `<p class="note">No team was selected when this report was made, so no lineup is listed.</p></section>`,
    };
  }
  const cards = buildPrintCards({
    workspace: input.workspace,
    scoringBundle: input.scoringBundle,
    gender: input.gender,
    team: input.team,
  });
  const cardCount = cards.events.length + cards.relays.length;
  const genderLabel = input.gender === Gender.WOMEN ? 'Women' : 'Men';
  const head =
    `<h2>Lineup: ${esc(input.team)} (${genderLabel})</h2>` +
    `<p class="meta">Projected team points: ${points(cards.projectedPoints)}</p>`;
  if (cardCount === 0) {
    return {
      cardCount,
      html: `<section>${head}<p class="note">This team has no entries or relays in the workspace.</p></section>`,
    };
  }
  const events = cards.events.map(eventCardHtml).join('');
  const relays = cards.relays.map(relayCardHtml).join('');
  return {
    cardCount,
    html:
      `<section>${head}` +
      (events === '' ? '' : `<h2>Individual events</h2>${events}`) +
      (relays === '' ? '' : `<h2>Relays</h2>${relays}`) +
      `</section>`,
  };
}

/**
 * Build the static report. Pure: the same input gives the same bytes. The output has no
 * `<script`, no external URL and no event handler, and carries a Content-Security-Policy meta
 * tag that forbids both.
 */
export function buildStaticReportHtml(input: StaticReportInput): StaticReport {
  const { workspace, generatedAt } = input;
  const date = reportDate(generatedAt);
  const name = workspace.name.trim() === '' ? 'Workspace' : workspace.name;
  const meet = workspace.loadedMeet?.meetLabel?.trim() ?? '';
  const lineup = lineupSection(input);
  const legend = legendTerms()
    .map(t => `<dt>${esc(t.term)}</dt><dd>${esc(t.meaning)}</dd>`)
    .join('');

  const content =
    `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">` +
    `<title>${esc(name)} — Omniswim report</title><style>${STYLE}</style></head><body>` +
    `<header><h1>${esc(name)}</h1>` +
    `<p class="meta">Report generated ${date}</p>` +
    (meet === '' ? '' : `<p class="meta">Meet: ${esc(meet)}</p>`) +
    (workspace.conference ? `<p class="meta">Conference: ${esc(String(workspace.conference))}</p>` : '') +
    `<p class="note">This is a read-only copy of a swim team plan from Omniswim Suite. ` +
    `It lists each team’s projected and actual points, then the lineup for one team. ` +
    `Open it in any browser. Print it to keep a paper copy or save a PDF.</p></header>` +
    scoresSection(input) +
    lineup.html +
    `<section><h2>Key terms</h2><dl>${legend}</dl></section>` +
    `<footer>Generated by Omniswim Suite from the workspace as saved on ${date}; ` +
    `projections are estimates from published times.</footer>` +
    `</body></html>\n`;

  return {
    filename: `omniswim-report-${fileSlug(name)}-${date}.html`,
    mimeType: 'text/html;charset=utf-8',
    content,
    cardCount: lineup.cardCount,
  };
}
