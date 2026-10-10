import express from 'express';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerParsingRoutes } from '../apps/shell/lib/routes/parsingRoutes';

/**
 * Route-level tests with the Python scripts replaced by tiny fake scripts that
 * print canned JSON. Each fake appends its own name to a call log, so a test can
 * prove which pipeline stages ran. No real PDF or server port is involved: the
 * routes are mounted on an ephemeral port.
 */
let sandbox: string;
let logFile: string;
let server: import('node:http').Server;
let base: string;

type Behaviour = { stdout: string; exit?: number };

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

function fake(name: string, b: Behaviour): string {
  const file = path.join(sandbox, `${name}.py`);
  const body = [
    'import sys',
    `open(${JSON.stringify(logFile)}, "a").write(${JSON.stringify(name)} + " " + " ".join(sys.argv[1:]) + "\\n")`,
    `sys.stdout.write(${JSON.stringify(b.stdout)})`,
    `sys.exit(${b.exit ?? 0})`,
  ].join('\n');
  fs.writeFileSync(file, `${body}\n`);
  return file;
}

/** Calculator fake that echoes its stdin, as the real one does for already-scored rows. */
function echoCalculator(): string {
  const file = path.join(sandbox, 'calc.py');
  fs.writeFileSync(
    file,
    [
      'import sys',
      `open(${JSON.stringify(logFile)}, "a").write("calc " + " ".join(sys.argv[1:]) + "\\n")`,
      'sys.stdout.write(sys.stdin.read())',
    ].join('\n') + '\n'
  );
  return file;
}

const calls = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
const ran = (prefix: string) => calls().some(c => c === prefix || c.startsWith(`${prefix} `));

interface Scripts {
  parseMeet: Behaviour;
  legacyParser?: Behaviour;
  rankings?: Behaviour;
  psych?: Behaviour;
}

async function mount(s: Scripts) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  registerParsingRoutes(app, {
    projectRoot: sandbox,
    dataDir: sandbox,
    pdfParserScript: fake('legacy-parser', s.legacyParser ?? { stdout: JSON.stringify([goodRow]) }),
    parseMeetScript: fake('parse-meet', s.parseMeet),
    parsePsychScript: fake('psych-parser', s.psych ?? { stdout: JSON.stringify({ results: [] }) }),
    pointCalculatorScript: echoCalculator(),
    teamRankingsScript: fake(
      'rankings',
      s.rankings ?? { stdout: JSON.stringify({ eventThrough: null, men: {}, women: {}, markerFound: false }) }
    ),
    aiEnabled: false,
  });
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const post = (route: string) =>
  fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64: Buffer.from('%PDF-fake').toString('base64'), format: 'auto' }),
  });

beforeAll(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-parse-routes-'));
  logFile = path.join(sandbox, 'calls.log');
});

beforeEach(() => {
  fs.rmSync(logFile, { force: true });
});

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function stop() {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

describe('POST /api/parse-pdf failure routing', () => {
  it('unusable rows: 422 naming the row, and the legacy pipeline never runs', async () => {
    await mount({
      parseMeet: {
        stdout: JSON.stringify({ athletes: [{ ...goodRow, gender: undefined }], conference: null, officialTeamScores: null }),
      },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.details).toMatch(/row 0 .*gender/);
      expect(body.rows).toHaveLength(1);
      expect(ran('parse-meet')).toBe(true);
      expect(ran('legacy-parser')).toBe(false);
      expect(ran('calc')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('rankings page found but unreadable: 422 with its text, and no legacy retry', async () => {
    const message = 'Team Rankings page was detected but extraction failed: boom';
    await mount({
      parseMeet: {
        stdout: JSON.stringify({ error: message, code: 'rankings_extraction_failed', trace: 'x'.repeat(2000) }),
        exit: 1,
      },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.code).toBe('rankings_extraction_failed');
      expect(body.details).toBe(message);
      expect(ran('legacy-parser')).toBe(false);
      expect(ran('calc')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('settings missing: the message reaches the client, and no legacy retry', async () => {
    const message = 'No scoring settings file found (looked in OMNI_DATA_DIR). Refusing to score without settings.';
    await mount({
      parseMeet: {
        stdout: JSON.stringify({ error: message, code: 'scoring_settings_missing', trace: 'y'.repeat(2000) }),
        exit: 1,
      },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('scoring_settings_missing');
      expect(body.details).toBe(message);
      expect(ran('legacy-parser')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('an untagged unified failure still falls back to the legacy pipeline', async () => {
    await mount({ parseMeet: { stdout: JSON.stringify({ error: 'boom', trace: 't' }), exit: 1 } });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toHaveLength(1);
      expect(body.officialTeamScores).toBeUndefined();
      expect(ran('legacy-parser')).toBe(true);
      expect(ran('rankings')).toBe(true);
      expect(ran('calc')).toBe(true);
    } finally {
      await stop();
    }
  });

  it('legacy refuses a PDF whose rankings page was found but not read', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 },
      rankings: { stdout: JSON.stringify({ error: 'cannot read block', markerFound: true }), exit: 1 },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('rankings_extraction_failed');
      expect(ran('calc')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('legacy refuses when the PDF could not be inspected for a rankings page', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 },
      rankings: { stdout: JSON.stringify({ error: 'no pdfplumber', markerFound: null }), exit: 1 },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(422);
      expect(ran('calc')).toBe(false);
    } finally {
      await stop();
    }
  });

  it.each([
    ['a cutoff but no team block', { eventThrough: 42, men: {}, women: {}, markerFound: true }],
    ['a cutoff and a (contradictory) no-page flag', { eventThrough: 42, men: {}, women: {}, markerFound: false }],
    ['a rankings page but no team block', { eventThrough: null, men: {}, women: {}, markerFound: true }],
  ])('legacy refuses %s', async (_label, rankings) => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 },
      rankings: { stdout: JSON.stringify(rankings) },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(422);
      expect(ran('calc')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('legacy hands the rankings cutoff to the calculator', async () => {
    await mount({
      parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 },
      rankings: {
        stdout: JSON.stringify({ eventThrough: 42, men: { 'Team A': 10 }, women: {}, markerFound: true }),
      },
    });
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.officialTeamScores.eventThrough).toBe(42);
      expect(calls()).toContain('calc 42');
    } finally {
      await stop();
    }
  });

  it('legacy surfaces a tagged calculator failure instead of "Points calculation failed"', async () => {
    const message = 'No scoring settings file found. Refusing to score.';
    await mount({ parseMeet: { stdout: JSON.stringify({ error: 'boom' }), exit: 1 } });
    // Replace the echo calculator with one that prints the CLI's tagged error JSON.
    fs.writeFileSync(
      path.join(sandbox, 'calc.py'),
      `import sys\nsys.stdin.read()\nsys.stdout.write(${JSON.stringify(
        JSON.stringify({ error: message, code: 'scoring_settings_missing' })
      )})\n`
    );
    try {
      const res = await post('/api/parse-pdf');
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.code).toBe('scoring_settings_missing');
      expect(body.details).toBe(message);
    } finally {
      await stop();
    }
  });
});

describe('POST /api/parse-psych-pdf failure routing', () => {
  it('unusable psych rows: 422, and psych_parser.py is not rerun', async () => {
    await mount({
      parseMeet: { stdout: '{}' },
      // A seed-time row with no gender: normalisation keeps it, mapping must refuse it.
      legacyParser: {
        stdout: JSON.stringify([
          { name: 'Alan Gonzalez', team: 'Henderson State University', event: 'Event 5 Men 200 Yard Freestyle', gender: null, finals_time: '1:40.12', rank: '3' },
        ]),
      },
    });
    try {
      const res = await post('/api/parse-psych-pdf');
      expect(res.status).toBe(422);
      expect((await res.json()).details).toMatch(/gender/);
      expect(ran('legacy-parser')).toBe(true);
      expect(ran('psych-parser')).toBe(false);
    } finally {
      await stop();
    }
  });

  it('a generic primary failure still falls back to psych_parser.py', async () => {
    await mount({
      parseMeet: { stdout: '{}' },
      legacyParser: { stdout: JSON.stringify({ error: 'primary failed' }) },
      psych: {
        stdout: JSON.stringify({
          results: [
            { name: 'Alan Gonzalez', team: 'Henderson State University', event: 'Event 5 Men 200 Yard Freestyle', gender: 'Men', time: '1:40.12', rank: '3' },
          ],
        }),
      },
    });
    try {
      const res = await post('/api/parse-psych-pdf');
      expect(res.status).toBe(200);
      expect((await res.json()).results).toHaveLength(1);
      expect(ran('psych-parser')).toBe(true);
    } finally {
      await stop();
    }
  });
});
