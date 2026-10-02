/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Four audited cut-provenance defects (2026-10-01), one block each.
 *
 *  1. Rule 7: a stored `computedCut` badge was computed without asking whether
 *     the school sponsors the swim's gender. UWF fields women's swimming &
 *     diving only, so a men's `100 Free SCY 44.00` earned a "B" badge while
 *     `buildCutlineTagForTeam` said `gender_not_sponsored` for the same swim.
 *  2. Rule 5: `POST /api/parse-athlete-history` turned a missing division into
 *     `'D1'` and passed it explicitly, so the team lookup never ran. Henderson
 *     State (D2) was judged against the D1 table.
 *  3. Rule 2: D3 lists `A, Invited, B` and the code read that as strictest
 *     first. The archived D3 PDF prints Invited SLOWER than B in two events, so
 *     meeting Invited does not mean meeting B.
 *  4. Rule 3: an unreadable (NT) catalog time was stored as 0 and
 *     `isRankableCatalogTime` never refused it, so it won every best.
 *
 * Every expected number was read from `getCutlinesForSwim` over the archived
 * tables on 2026-10-01: D2 Men 100 Free A 42.87 / B 45.01; D2 Women 100 Free
 * A 49.44 / B 51.91; D3 Women 100 Fly A 53.67 / Invited 55.83 / B 55.79; D3
 * Women 400 IM A 4:15.84 / Invited 4:28.76 / B 4:28.70.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';
import { Gender, type Workspace } from '../packages/core/src/types';
import { parseSwimCloudPasteDetailed } from '../packages/core/src/lib/athleteHistory';
import {
  bestTimesByEvent,
  buildStoredSwim,
  isRankableCatalogTime,
  sortedTimesByScy,
  type CatalogEventTime,
  type CatalogTeamRoster,
} from '../packages/core/src/lib/rosterCatalog';
import {
  compareTimeToCutline,
  getCutlinesForSwim,
  strictestTierMet,
} from '../packages/core/src/lib/cutlineUtils';
import { buildCutlineTag, buildCutlineTagForTeam } from '../packages/core/src/lib/cutlineTags';
import { buildCategorizedScoringInputs } from '../packages/core/src/lib/utils';
import { NSISC_PRESET_SETTINGS } from '../packages/core/src/lib/scoringDefaults';
import { findCutlines } from '../packages/core/src/cutlines';
import { registerParsingRoutes } from '../apps/shell/lib/routes/parsingRoutes';
import { registerCutlineRoutes } from '../apps/shell/lib/routes/cutlineRoutes';

const UWF = 'University of West Florida';
const HSU = 'Henderson State University';
const FREE_100 = '100 Free SCY\t44.00\t\tTest Meet\tFeb 20, 2026\t';

/* -------------------------------------------------------------------------- */
/* 1. Rule 7: gender sponsorship                                               */
/* -------------------------------------------------------------------------- */

describe('computedCut honours gender sponsorship (rule 7)', () => {
  const cutOf = (team: string, gender: Gender, row: string, division?: 'D1' | 'D2' | 'D3' | 'NAIA') => {
    const r = parseSwimCloudPasteDetailed(`Test Swimmer\nEvent\tTime\t\tMeet\tDate\tStamp Link\n${row}`, {
      team,
      gender,
      swimmerName: 'Test Swimmer',
      format: 'personal_bests',
      division,
    });
    expect(r.swims).toHaveLength(1);
    return r.swims[0].computedCut ?? null;
  };

  it('UWF men have no program: no badge, matching the cut tag', () => {
    expect(
      buildCutlineTagForTeam({ team: UWF, gender: 'Men', event: '100 Free', time: '44.00', swimCourse: 'SCY' }).state
    ).toBe('gender_not_sponsored');
    expect(cutOf(UWF, Gender.MEN, FREE_100)).toBeNull();
  });

  it('UWF men stay unbadged when the caller passes the division explicitly', () => {
    expect(cutOf(UWF, Gender.MEN, FREE_100, 'D2')).toBeNull();
  });

  it('UWF women, who do swim, still earn their badge', () => {
    expect(cutOf(UWF, Gender.WOMEN, '100 Free SCY\t50.00\t\tTest Meet\tFeb 20, 2026\t')).toBe('B');
  });

  it('HSU men are unchanged: 44.00 is a D2 B cut (45.01)', () => {
    expect(cutOf(HSU, Gender.MEN, FREE_100)).toBe('B');
  });

  it('an unmapped team with an explicit division is still judged (the caller said which table)', () => {
    expect(cutOf('Example College', Gender.MEN, FREE_100, 'D2')).toBe('B');
  });

  it('buildStoredSwim withholds the badge for an unsponsored gender when told the team', () => {
    const base = {
      athleteId: 'a1',
      event: '100 Free SCY',
      timeText: '44.00',
      timeType: 'SCY' as const,
      source: 'paste' as const,
      gender: Gender.MEN,
      division: 'D2' as const,
    };
    expect(buildStoredSwim({ ...base, team: UWF }).computedCut).toBeNull();
    expect(buildStoredSwim({ ...base, team: HSU }).computedCut).toBe('B');
    // No team given: unchanged, the caller's division decides.
    expect(buildStoredSwim(base).computedCut).toBe('B');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Rule 5: the route does not default a missing division to D1              */
/* -------------------------------------------------------------------------- */

describe('POST /api/parse-athlete-history (rule 5)', () => {
  const app = express();
  app.use(express.json());
  registerParsingRoutes(app, {
    projectRoot: '.',
    dataDir: '.',
    pdfParserScript: '',
    parseMeetScript: '',
    parsePsychScript: '',
    pointCalculatorScript: '',
    teamRankingsScript: '',
    aiEnabled: false,
  });
  const server = http.createServer(app);
  const ready = new Promise<string>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

  async function post(body: Record<string, unknown>) {
    const res = await fetch(`${await ready}/api/parse-athlete-history`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { swims: { computedCut: 'A' | 'B' | null }[] };
  }
  const text = `Test Swimmer\nEvent\tTime\t\tMeet\tDate\tStamp Link\n${FREE_100}`;

  it('resolves Henderson State to D2 when no division is sent', async () => {
    const out = await post({ text, team: HSU, gender: 'Men' });
    expect(out.swims[0].computedCut).toBe('B'); // D2 B is 45.01; D1 is 42.55 and gave null
  });

  it('keeps an unmapped team unknown instead of scoring it against D1', async () => {
    const out = await post({ text, team: 'Example College', gender: 'Men' });
    expect(out.swims[0].computedCut).toBeNull();
    const noTeam = await post({ text, gender: 'Men' });
    expect(noTeam.swims[0].computedCut).toBeNull();
  });

  it('honours an explicit division, including D1', async () => {
    const d1 = await post({ text, team: 'Example College', gender: 'Men', division: 'D1' });
    expect(d1.swims[0].computedCut).toBeNull(); // 44.00 misses the D1 42.55 standard
    const d2 = await post({ text, team: 'Example College', gender: 'Men', division: 'D2' });
    expect(d2.swims[0].computedCut).toBe('B');
  });

  it('treats a nonsense division as absent, not as D1', async () => {
    const out = await post({ text, team: HSU, gender: 'Men', division: 'D9' });
    expect(out.swims[0].computedCut).toBe('B');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Rule 2: tier order is read from the times                                */
/* -------------------------------------------------------------------------- */

describe('D3 Invited is not assumed to be an easier B (rule 2)', () => {
  const FLY = ['Women', '100 Butterfly', 'D3'] as const;
  const IM = ['Women', '400 Individual Medley', 'D3'] as const;

  it('the archived D3 table does print Invited slower than B in exactly these events', () => {
    const secs = (s: string) => s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
    const slowerInvited = findCutlines({ division: 'D3', kind: 'individual' })
      .flatMap(e => {
        if (e.kind !== 'individual' || e.scale !== 'abInvited') return [];
        return secs(e.invitedStandard) > secs(e.bStandard) ? [`${e.gender} ${e.event}`] : [];
      })
      .sort();
    expect(slowerInvited).toStrictEqual(['Women 100 Butterfly', 'Women 400 Individual Medley']);
  });

  it('55.80 beats Invited (55.83) but not B (55.79): no legacy cut, tier stays Invited', () => {
    const r = compareTimeToCutline(55.8, ...FLY);
    expect(r.achieved).toBeNull();
    expect(r.tier).toBe('Invited');
  });

  it('4:28.73 beats Invited (4:28.76) but not B (4:28.70): no legacy cut, tier Invited', () => {
    const r = compareTimeToCutline(4 * 60 + 28.73, ...IM);
    expect(r.achieved).toBeNull();
    expect(r.tier).toBe('Invited');
  });

  it('a time under both is a B cut and names the faster standard', () => {
    const fly = compareTimeToCutline(55.79, ...FLY);
    expect(fly.achieved).toBe('B');
    expect(fly.tier).toBe('B');
    const slower = compareTimeToCutline(55.83, ...FLY);
    expect(slower.achieved).toBeNull();
    expect(slower.tier).toBe('Invited');
  });

  it('A still wins, and a miss of every tier is a miss', () => {
    expect(compareTimeToCutline(53.67, ...FLY)).toMatchObject({ achieved: 'A', tier: 'A' });
    expect(compareTimeToCutline(56.0, ...FLY)).toMatchObject({ achieved: null, tier: null, status: 'ok' });
  });

  it('events where Invited is faster than B behave as before', () => {
    // D3 Men 50 Free: Invited 20.05, B slower (20.20 only reaches B).
    expect(compareTimeToCutline(20.02, 'Men', '50 Free', 'D3')).toMatchObject({ achieved: 'B', tier: 'Invited' });
    expect(compareTimeToCutline(20.2, 'Men', '50 Free', 'D3')).toMatchObject({ achieved: 'B', tier: 'B' });
  });

  it('a tie keeps the published order, so the label does not flip (100 Breast: Invited = B = 1:04.12)', () => {
    const lookup = getCutlinesForSwim('Women', '100 Breaststroke', 'D3');
    expect(lookup.tiers.map(t => [t.tier, t.seconds])).toStrictEqual([
      ['A', 60.01],
      ['Invited', 64.12],
      ['B', 64.12],
    ]);
    expect(compareTimeToCutline(64.12, 'Women', '100 Breaststroke', 'D3')).toMatchObject({
      achieved: 'B',
      tier: 'Invited',
    });
  });

  it('strictestTierMet picks by seconds, not by position, and ignores absent tiers', () => {
    const tiers = [
      { tier: 'A' as const, time: '1', seconds: 10 },
      { tier: 'Invited' as const, time: '1', seconds: 30 },
      { tier: 'B' as const, time: '1', seconds: 20 },
      { tier: 'Provisional' as const, time: '1', seconds: 0 },
    ];
    expect(strictestTierMet(tiers, 25)?.tier).toBe('Invited');
    expect(strictestTierMet(tiers, 19)?.tier).toBe('B');
    expect(strictestTierMet(tiers, 31)).toBeNull();
    expect(strictestTierMet(tiers, 0)).toBeNull();
    expect(strictestTierMet(tiers, Number.NaN)).toBeNull();
  });

  it('the cut tag agrees with the comparison on the tier it names', () => {
    const tag = buildCutlineTag({ gender: 'Women', event: '100 Butterfly', division: 'D3', time: '55.80', swimCourse: 'SCY' });
    expect(tag.state).toBe('tagged');
    expect(tag.tag?.tier).toBe('Invited');
    const both = buildCutlineTag({ gender: 'Women', event: '100 Butterfly', division: 'D3', time: '55.79', swimCourse: 'SCY' });
    expect(both.tag?.tier).toBe('B');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Rule 3: an unreadable catalog time is never a best                        */
/* -------------------------------------------------------------------------- */

describe('an NT catalog time (rule 3)', () => {
  const make = (id: string, timeText: string): CatalogEventTime =>
    buildStoredSwim({
      id,
      athleteId: 'a1',
      event: '100 Free SCY',
      timeText,
      timeType: 'SCY',
      source: 'paste',
      gender: Gender.MEN,
      division: 'D2',
    });
  const nt = make('nt', 'NT');
  const real = make('real', '45.00');

  it('is not rankable, and a real time is', () => {
    expect(nt.timeSecondsScy).toBe(0); // stored sentinel: the DB column is NOT NULL
    expect(isRankableCatalogTime(nt)).toBe(false);
    expect(isRankableCatalogTime(real)).toBe(true);
    expect(isRankableCatalogTime({ ...real, timeSecondsScy: Number.NaN })).toBe(false);
    expect(isRankableCatalogTime({ ...real, timeSecondsScy: -1 })).toBe(false);
  });

  it('never wins the best, whichever order the rows arrive in', () => {
    expect([...bestTimesByEvent([nt, real]).values()].map(t => t.id)).toStrictEqual(['real']);
    expect([...bestTimesByEvent([real, nt]).values()].map(t => t.id)).toStrictEqual(['real']);
    expect(bestTimesByEvent([nt]).size).toBe(0);
  });

  it('never sorts ahead of a real time', () => {
    expect(sortedTimesByScy([nt, real]).map(t => t.id)).toStrictEqual(['real', 'nt']);
  });

  it('is never scored as an entry (0.00 would rank first)', () => {
    const roster: CatalogTeamRoster = {
      team: { id: 't1', name: HSU, gender: 'Men', sortIndex: 0, createdAt: 0, updatedAt: 0 },
      athletes: [
        {
          id: 'a1',
          teamId: 't1',
          fullName: 'Test Swimmer',
          nameKey: 'test swimmer',
          gender: 'Men',
          createdAt: 0,
          updatedAt: 0,
          times: [nt, make('nt-200', 'NT')].map((t, i) => (i === 1 ? { ...t, event: '200 Free' } : t)),
        },
      ],
    };
    const workspace = {
      id: 'ws',
      name: 'catalog',
      createdAt: 0,
      menResults: [],
      womenResults: [],
      scoringSettings: { ...NSISC_PRESET_SETTINGS },
    } as unknown as Workspace;
    expect(buildCategorizedScoringInputs({ workspace, gender: Gender.MEN, rosterCatalog: roster })).toStrictEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Low: GET /api/cutlines/:version fails loudly on a file with no `cutlines`   */
/* -------------------------------------------------------------------------- */

describe('GET /api/cutlines/:version', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'omniswim-cutline-routes-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'good.json'), JSON.stringify({ cutlines: [{ a: 1 }] }));
  writeFileSync(path.join(dir, 'bare.json'), JSON.stringify([{ a: 1 }]));
  writeFileSync(path.join(dir, 'nokey.json'), JSON.stringify({ somethingElse: [] }));
  const app = express();
  registerCutlineRoutes(app, { cutlinesDir: dir, fallbackCutlineVersion: 'good', builtinCutlines: [] });
  const server = http.createServer(app);
  const ready = new Promise<string>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves both file shapes', async () => {
    const base = await ready;
    expect(((await (await fetch(`${base}/api/cutlines/good`)).json()) as { cutlines: unknown[] }).cutlines).toHaveLength(1);
    expect(((await (await fetch(`${base}/api/cutlines/bare`)).json()) as { cutlines: unknown[] }).cutlines).toHaveLength(1);
  });

  it('answers 500, not 200 with [], for a file that lacks the cutlines key', async () => {
    const res = await fetch(`${await ready}/api/cutlines/nokey`);
    expect(res.status).toBe(500);
  });
});
