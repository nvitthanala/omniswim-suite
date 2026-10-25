/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * C5 (silent fallbacks in the parse pipeline) and the C4 error code.
 *
 * Routes are mounted on an ephemeral port with the Python scripts replaced by
 * tiny fakes that print canned JSON, as `parsingRoutesFallback.test.ts` does.
 * Each test forces one fallback and checks that the response says so:
 *
 * - `pipeline` is `'unified'` or `'legacy'` on every successful response, and a
 *   legacy response leads `warnings` with `unified_pipeline_failed_legacy_used`.
 * - `relay_split_source` and `parse_warnings` reach each row as
 *   `relaySplitSource` and `parseWarnings`, and the top-level `warnings` roll-up
 *   reaches the response.
 * - `points_on_status_clock` is final: 422 with `rows`, and no legacy retry.
 */
import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEGACY_FALLBACK_WARNING_CODE, registerParsingRoutes } from '../apps/shell/lib/routes/parsingRoutes';
import { rollUpParseWarnings, structuredPipelineError } from '../apps/shell/lib/routes/parsingPipeline';

let sandbox: string;
let logFile: string;
let server: import('node:http').Server;
let base: string;

const goodRow = {
  name: 'Alan Gonzalez',
  team: 'Henderson State University',
  event: 'Event 5 Men 200 Yard Freestyle',
  gender: 'Men',
  year: 'SR',
  rank: '3',
  finals_time: '1:40.12',
  round_swam: 'A Final',
  calculated_points: 16,
  pdf_points: null,
};

const relayRow = (leg: number, source: unknown, extra: Record<string, unknown> = {}) => ({
  ...goodRow,
  name: `Relay Swimmer ${leg}`,
  event: 'Event 9 Women 200 Yard Free Relay',
  gender: 'Women',
  is_relay: true,
  relay_team_time: '1:30.00',
  finals_time: null,
  relay_leg_index: leg,
  relay_split_source: source,
  ...extra,
});

const legacyWarning = {
  code: 'relay_split_legacy_fallback',
  message: 'Relay splits for Henderson State University were read by the legacy method.',
};
const unreadableWarning = { code: 'unreadable_time', message: "Time 'xx.xx' for Pat Lee is unreadable and was not scored." };

interface Behaviour {
  stdout: string;
  exit?: number;
}

function fake(name: string, b: Behaviour): string {
  const file = path.join(sandbox, `${name}.py`);
  fs.writeFileSync(
    file,
    [
      'import sys',
      `open(${JSON.stringify(logFile)}, "a").write(${JSON.stringify(name)} + "\\n")`,
      `sys.stdout.write(${JSON.stringify(b.stdout)})`,
      `sys.exit(${b.exit ?? 0})`,
    ].join('\n') + '\n'
  );
  return file;
}

/** A calculator that echoes its stdin, as the real one does for already-scored rows. */
function echoCalculator(): string {
  const file = path.join(sandbox, 'calc-echo.py');
  fs.writeFileSync(
    file,
    ['import sys', `open(${JSON.stringify(logFile)}, "a").write("calc\\n")`, 'sys.stdout.write(sys.stdin.read())'].join('\n') + '\n'
  );
  return file;
}

const ran = (name: string) => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').split(/\r?\n/).includes(name);

interface Scripts {
  parseMeet: Behaviour;
  legacyParser?: Behaviour;
  calculator?: Behaviour;
}

async function mount(s: Scripts) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerParsingRoutes(app, {
    projectRoot: sandbox,
    dataDir: sandbox,
    pdfParserScript: fake('legacy-parser', s.legacyParser ?? { stdout: JSON.stringify([goodRow]) }),
    parseMeetScript: fake('parse-meet', s.parseMeet),
    parsePsychScript: fake('psych-parser', { stdout: JSON.stringify({ results: [] }) }),
    pointCalculatorScript: s.calculator === undefined ? echoCalculator() : fake('calc', s.calculator),
    teamRankingsScript: fake('rankings', {
      stdout: JSON.stringify({ eventThrough: null, men: {}, women: {}, markerFound: false }),
    }),
    aiEnabled: false,
  });
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = () =>
  fetch(`${base}/api/parse-pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64: Buffer.from('%PDF-fake').toString('base64'), format: 'auto' }),
  });

const stop = () => new Promise<void>(resolve => server.close(() => resolve()));

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-parse-warnings-'));
  logFile = path.join(sandbox, 'calls.log');
});
beforeEach(() => {
  fs.rmSync(logFile, { force: true });
});
afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('pipeline flag', () => {
  it('a unified success says pipeline "unified" and adds no fallback warning', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ athletes: [goodRow], conference: null, officialTeamScores: null, warnings: [] }) },
    });
    try {
      const body = await (await post()).json();
      expect(body.pipeline).toBe('unified');
      expect(body.warnings).toEqual([]);
      expect(ran('legacy-parser')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('an untagged unified failure falls back, and the response says so', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'pdfplumber blew up', trace: 't' }), exit: 1 },
      legacyParser: {
        stdout: JSON.stringify([goodRow, { ...goodRow, name: 'Pat Lee', parse_warnings: [unreadableWarning] }]),
      },
    });
    try {
      const res = await post();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pipeline).toBe('legacy');
      expect(ran('legacy-parser')).toBe(true);
      expect(body.results).toHaveLength(2);
      // The fallback warning leads, names the cause, and counts every row; the rows' own warnings follow.
      expect(body.warnings[0].code).toBe(LEGACY_FALLBACK_WARNING_CODE);
      expect(body.warnings[0].rows).toBe(2);
      expect(body.warnings[0].examples.join(' ')).toMatch(/pdfplumber blew up/);
      expect(body.warnings.slice(1)).toEqual([
        { code: 'unreadable_time', rows: 1, examples: [unreadableWarning.message] },
      ]);
    } finally {
      await stop();
    }
  });
});

describe('row notes and warning roll-up', () => {
  it('carries relay_split_source, parse_warnings and the top-level warnings into the response', async () => {
    const rollup = [
      { code: 'relay_split_legacy_fallback', rows: 2, examples: [legacyWarning.message] },
      { code: 'unreadable_time', rows: 1, examples: [unreadableWarning.message] },
    ];
    await mount({
      parseMeet: {
        stdout: JSON.stringify({
          athletes: [
            goodRow,
            { ...goodRow, name: 'Pat Lee', parse_warnings: [unreadableWarning] },
            relayRow(1, 'structured'),
            relayRow(2, 'legacy', { parse_warnings: [legacyWarning] }),
            relayRow(3, null),
          ],
          conference: null,
          officialTeamScores: null,
          warnings: rollup,
        }),
      },
    });
    try {
      const body = await (await post()).json();
      const [plain, lee, structured, legacy, noSplits] = body.results;
      // A row with nothing to report is exactly what it was: no new keys.
      expect('relaySplitSource' in plain).toBe(false);
      expect('parseWarnings' in plain).toBe(false);
      expect(lee.parseWarnings).toEqual([unreadableWarning]);
      expect(structured.relaySplitSource).toBe('structured');
      expect('parseWarnings' in structured).toBe(false);
      expect(legacy.relaySplitSource).toBe('legacy');
      expect(legacy.parseWarnings).toEqual([legacyWarning]);
      // null is a real state ("no split lines printed"), not absence.
      expect(noSplits.relaySplitSource).toBeNull();
      expect(body.warnings).toEqual(rollup);
      expect(body.pipeline).toBe('unified');
    } finally {
      await stop();
    }
  });

  it('carries the roll-up the parser printed, not one it recomputes', async () => {
    const printed = [{ code: 'unreadable_time', rows: 7, examples: ['printed by the parser'] }];
    await mount({
      parseMeet: {
        stdout: JSON.stringify({
          athletes: [{ ...goodRow, parse_warnings: [unreadableWarning] }],
          warnings: printed,
        }),
      },
    });
    try {
      expect((await (await post()).json()).warnings).toEqual(printed);
    } finally {
      await stop();
    }
  });

  it('rolls the rows up itself when the parser printed no usable warnings list', async () => {
    await mount({
      parseMeet: {
        stdout: JSON.stringify({ athletes: [{ ...goodRow, parse_warnings: [unreadableWarning] }], warnings: 'oops' }),
      },
    });
    try {
      const body = await (await post()).json();
      expect(body.warnings).toEqual([{ code: 'unreadable_time', rows: 1, examples: [unreadableWarning.message] }]);
    } finally {
      await stop();
    }
  });

  it('the legacy pipeline carries the same row notes', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 },
      legacyParser: {
        stdout: JSON.stringify([relayRow(1, 'legacy', { parse_warnings: [legacyWarning] })]),
      },
    });
    try {
      const body = await (await post()).json();
      expect(body.pipeline).toBe('legacy');
      expect(body.results[0].relaySplitSource).toBe('legacy');
      expect(body.results[0].parseWarnings).toEqual([legacyWarning]);
      expect(body.warnings.map((w: { code: string }) => w.code)).toEqual([
        LEGACY_FALLBACK_WARNING_CODE,
        'relay_split_legacy_fallback',
      ]);
    } finally {
      await stop();
    }
  });

  it('a relay_split_source it does not know is a parse defect, not a silent pass-through', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ athletes: [relayRow(1, 'guessed')] }) },
    });
    try {
      const res = await post();
      expect(res.status).toBe(422);
      expect((await res.json()).details).toMatch(/relay_split_source "guessed"/);
      expect(ran('legacy-parser')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('a malformed parse_warnings list is a parse defect', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ athletes: [{ ...goodRow, parse_warnings: ['unreadable'] }] }) },
    });
    try {
      const res = await post();
      expect(res.status).toBe(422);
      expect((await res.json()).details).toMatch(/parse_warnings is not a list/);
    } finally {
      await stop();
    }
  });
});

describe('points_on_status_clock is final', () => {
  const rows = [
    'row 12 (Pat Lee, Event 5 Men 200 Yard Freestyle): NT with 16 points',
    'row 13 (Sam Roe, Event 5 Men 200 Yard Freestyle): DQ with 14 points',
  ];
  const message = '2 row(s) print place points beside a clock that reads as NT, DQ, NS, SCR or DNF.';

  it('from the unified parser: 422 with the rows, and the legacy pipeline never runs', async () => {
    await mount({
      parseMeet: {
        stdout: JSON.stringify({ error: message, code: 'points_on_status_clock', rows, trace: 'x'.repeat(2000) }),
        exit: 1,
      },
    });
    try {
      const res = await post();
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('points_on_status_clock');
      expect(body.rows).toEqual(rows);
      expect(body.details).toBe(message);
      expect(body.trace).toBeUndefined();
      expect(ran('legacy-parser')).toBe(false);
      expect(ran('calc')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('from the legacy calculator after an untagged unified failure: 422 with the rows, not a 500', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 },
      calculator: { stdout: JSON.stringify({ error: message, code: 'points_on_status_clock', rows }), exit: 1 },
    });
    try {
      const res = await post();
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('points_on_status_clock');
      expect(body.rows).toEqual(rows);
      expect(ran('legacy-parser')).toBe(true);
    } finally {
      await stop();
    }
  });

  it('the other tagged codes keep their statuses and send no rows key', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'no page', code: 'rankings_extraction_failed' }), exit: 1 },
    });
    try {
      const res = await post();
      expect(res.status).toBe(422);
      expect('rows' in (await res.json())).toBe(false);
    } finally {
      await stop();
    }
  });
});

describe('helpers', () => {
  it('structuredPipelineError reads the code and the rows', () => {
    const err = structuredPipelineError({ code: 'points_on_status_clock', error: 'drift', rows: ['a', 'b', 7] });
    expect(err?.code).toBe('points_on_status_clock');
    expect(err?.rows).toEqual(['a', 'b']);
    expect(structuredPipelineError({ code: 'something_else', error: 'x' })).toBeNull();
  });

  it('rollUpParseWarnings counts rows per code and keeps at most five distinct examples', () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      parseWarnings: [{ code: 'unreadable_time', message: `row ${i}` }],
    }));
    rows.push({ parseWarnings: [{ code: 'unreadable_time', message: 'row 0' }] });
    const [entry] = rollUpParseWarnings(rows);
    expect(entry!.code).toBe('unreadable_time');
    expect(entry!.rows).toBe(9);
    expect(entry!.examples).toHaveLength(5);
    expect(rollUpParseWarnings([{}, { parseWarnings: [] }])).toEqual([]);
  });
});
