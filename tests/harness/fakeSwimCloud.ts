/**
 * A fake SwimCloud for the extension harness. It serves only committed fixtures.
 * It never reaches the network. Every request it answers is recorded.
 *
 * Provenance of what it serves (see also tests/swimCloudExtensionMultiTeamDriver.test.ts):
 * - Roster pages: tests/fixtures/swimcloud/team-{412,10002824}-roster-gender-{M,F}-page.html,
 *   real pages captured 2026-09-22 and trimmed. This module trims them further: it keeps the
 *   first ROWS_PER_ROSTER swimmer rows of each page, so a run with real 3 s pacing stays short.
 *   No row is edited. Team 10002824's men's page is SwimCloud's real "No rosters found" page.
 * - Swimmer times: tests/fixtures/profile_fastest_times-1330318.json for every swimmer id, with each
 *   row's swimmer_id set to the swimmer asked for. Times are not changed. The harness checks the
 *   requests and the pipeline, not whose times these are.
 * - The team page the content script mounts on is a stub with no data in it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** Swimmer rows kept on each roster page. */
export const ROWS_PER_ROSTER = 2;

export const FAKE_ORIGIN = 'https://www.swimcloud.com';

export type Gender = 'M' | 'F';

const SWIMMER_BODY = readFileSync(join(FIXTURES, 'profile_fastest_times-1330318.json'), 'utf8');

/** Keep the header and the first `keep` body rows of the roster table. Nothing inside a kept row changes. */
export function trimRoster(html: string, keep: number): string {
  const open = html.indexOf('<tbody');
  const close = html.indexOf('</tbody>');
  if (open < 0 || close < 0) return html; // The "No rosters found" page has no table.
  const body = html.slice(open, close);
  const rows = body.match(/<tr\b[\s\S]*?<\/tr>/g) ?? [];
  const head = body.slice(0, body.indexOf('>') + 1);
  return html.slice(0, open) + head + rows.slice(0, keep).join('\n') + html.slice(close);
}

/** The season option marked selected in a page, as the real site marks the season asked for. */
export function selectSeasonInPage(html: string, seasonId: string): string {
  const unselected = html.replace(/<option value="(\d+)" selected>/g, '<option value="$1">');
  return unselected.replace(`<option value="${seasonId}">`, `<option value="${seasonId}" selected>`);
}

function rosterFixture(team: string, gender: Gender): string | undefined {
  try {
    return trimRoster(readFileSync(join(FIXTURES, 'swimcloud', `team-${team}-roster-gender-${gender}-page.html`), 'utf8'), ROWS_PER_ROSTER);
  } catch {
    return undefined;
  }
}

/** Swimmer ids on a trimmed roster page, in page order. A plain scan, not the parser. */
export function swimmerIdsOnPage(html: string): string[] {
  const ids: string[] = [];
  for (const m of html.matchAll(/\/swimmer\/(\d+)/g)) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

export const rosterIds = (team: string, gender: Gender): string[] => swimmerIdsOnPage(rosterFixture(team, gender) ?? '');

/**
 * The one fixture body, answered for any swimmer id. The parser skips a row whose `swimmer_id` names
 * another swimmer, so each row's `swimmer_id` is set to the swimmer asked for. Times are untouched.
 */
function swimmerBody(swimmerId: string): string {
  const rows = JSON.parse(SWIMMER_BODY) as Array<Record<string, unknown>>;
  return JSON.stringify(rows.map(row => ({ ...row, swimmer_id: swimmerId })));
}

export interface FakeReply {
  readonly status: number;
  readonly body: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

export interface LoggedRequest {
  /** Epoch milliseconds when the fake answered. */
  readonly at: number;
  readonly url: string;
  /** `data` for a roster or swimmer request, `page` for the team stub page. */
  readonly kind: 'data' | 'page';
  readonly status: number;
}

/** A rule sees every data request, with its 1-based count among data requests. It may answer; `undefined` passes. */
export type FakeRule = (url: URL, n: number) => FakeReply | undefined;

export class FakeSwimCloud {
  readonly log: LoggedRequest[] = [];
  private readonly rules: FakeRule[] = [];

  addRule(rule: FakeRule): void {
    this.rules.push(rule);
  }

  get dataLog(): LoggedRequest[] {
    return this.log.filter(r => r.kind === 'data');
  }

  /** Answer one request to the fake origin. */
  answer(rawUrl: string): FakeReply {
    const url = new URL(rawUrl);
    const reply = this.reply(url);
    const kind = url.pathname.startsWith('/team/') && !url.pathname.includes('/roster') ? 'page' : url.pathname.startsWith('/api/') || url.pathname.includes('/roster') ? 'data' : 'page';
    this.log.push({ at: Date.now(), url: rawUrl, kind, status: reply.status });
    return reply;
  }

  private reply(url: URL): FakeReply {
    const stub = /^\/team\/(\d+)\/?$/.exec(url.pathname);
    if (stub !== null) {
      return { status: 200, contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><title>Team ${stub[1]} | SwimCloud (fake)</title></head><body><main><h1>Fake team page ${stub[1]}</h1></main></body></html>` };
    }
    const n = this.log.filter(r => r.kind === 'data').length + 1;
    for (const rule of this.rules) {
      const hit = rule(url, n);
      if (hit !== undefined) return hit;
    }
    const roster = /^\/team\/(\d+)\/roster\/?$/.exec(url.pathname);
    if (roster !== null) {
      const gender = url.searchParams.get('gender');
      const html = gender === 'M' || gender === 'F' ? rosterFixture(roster[1], gender) : undefined;
      if (html === undefined) return { status: 404, contentType: 'text/html', body: 'not found' };
      const season = url.searchParams.get('season_id');
      return { status: 200, contentType: 'text/html', body: season === null ? html : selectSeasonInPage(html, season) };
    }
    const swimmer = /^\/api\/swimmers\/(\d+)\/profile_fastest_times\/?$/.exec(url.pathname);
    if (swimmer !== null) return { status: 200, contentType: 'application/json', body: swimmerBody(swimmer[1]) };
    return { status: 404, contentType: 'text/html', body: 'not found' };
  }
}
