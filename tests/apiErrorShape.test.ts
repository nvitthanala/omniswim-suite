/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * P5: one API error shape (`apps/shell/lib/middleware/apiError.ts`).
 *
 * Three layers, each of which fails if the one above it is weakened:
 *
 * 1. The helper itself: `details` and exception text never leave the process in
 *    production, and `extra` cannot overwrite `error`, `code` or `details`.
 * 2. A source check over every file that answers `/api` requests: no raw
 *    `.status(4xx/5xx).json(`. A new route written the old way fails here.
 * 3. Real routes on real sockets, with a store that throws a secret. In
 *    production nothing of the secret is on the wire. Outside production
 *    `details` carries it, so the test cannot pass on a route that never throws.
 */
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiError, isProductionEnv } from '../apps/shell/lib/middleware/apiError';
import { apiErrorHandler } from '../apps/shell/lib/middleware/apiErrorHandler';
import { createHostOriginGuard } from '../apps/shell/lib/middleware/hostOriginGuard';
import { registerAuthRoutes } from '../apps/shell/lib/routes/authRoutes';
import { registerCutlineRoutes } from '../apps/shell/lib/routes/cutlineRoutes';
import { registerParsingRoutes } from '../apps/shell/lib/routes/parsingRoutes';
import { registerScoringPresetRoutes } from '../apps/shell/lib/routes/scoringPresetRoutes';
import { registerWorkspaceRoutes } from '../apps/shell/lib/routes/workspaceRoutes';
import { EXPECTED_VERSION_HEADER } from '../packages/core/src/api/saveSequence';
import type { AuthService, ShareLinkService } from '../packages/db/src/AuthService';
import type { ScoringSettings } from '../packages/core/src/types';
import { startTestServer, type RawResponse, type TestServer } from './helpers/rawHttp';

const ROOT = path.join(import.meta.dirname, '..');
const SECRET = 'SECRET_LEAK /srv/omni/data/omniswim.db SQLITE_CORRUPT postgres://user:pw@host/db';

afterEach(() => {
  vi.unstubAllEnvs();
});

/* -------------------------------------------------------------------------- */
/* 1. The helper                                                               */
/* -------------------------------------------------------------------------- */

describe('apiError', () => {
  /** A bare `Response` stand-in that records what the helper sent. */
  function fakeRes() {
    const sent: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status(code: number) {
        sent.status = code;
        return res;
      },
      json(body: Record<string, unknown>) {
        sent.body = body;
        return res;
      },
    };
    return { res: res as unknown as express.Response, sent };
  }

  it('sends error, code and details outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { res, sent } = fakeRes();
    apiError(res, 500, 'THING_FAILED', 'Thing failed', 'because of X');
    expect(sent.status).toBe(500);
    expect(sent.body).toEqual({ error: 'Thing failed', code: 'THING_FAILED', details: 'because of X' });
  });

  it('drops details in production and keeps error and code', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(isProductionEnv()).toBe(true);
    const { res, sent } = fakeRes();
    apiError(res, 500, 'THING_FAILED', 'Thing failed', SECRET);
    expect(sent.body).toEqual({ error: 'Thing failed', code: 'THING_FAILED' });
    expect(Object.keys(sent.body ?? {})).not.toContain('details');
    expect(JSON.stringify(sent.body)).not.toContain('SECRET_LEAK');
  });

  it('reads NODE_ENV on each call, not at import', () => {
    const { res: a, sent: first } = fakeRes();
    vi.stubEnv('NODE_ENV', 'production');
    apiError(a, 400, 'X', 'x', 'd');
    vi.stubEnv('NODE_ENV', 'development');
    const { res: b, sent: second } = fakeRes();
    apiError(b, 400, 'X', 'x', 'd');
    expect(first.body).not.toHaveProperty('details');
    expect(second.body).toHaveProperty('details', 'd');
  });

  it('omits details when none is given, even outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const { res, sent } = fakeRes();
    apiError(res, 404, 'NOT_FOUND', 'Not found');
    expect(sent.body).toEqual({ error: 'Not found', code: 'NOT_FOUND' });
  });

  it('keeps extra fields in production, and extra cannot overwrite error, code or details', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { res, sent } = fakeRes();
    apiError(res, 422, 'ROWS', 'Rows unreadable', 'hidden', {
      rows: [{ row: 1 }],
      error: 'forged',
      code: 'FORGED',
      details: 'forged details',
    });
    expect(sent.body).toEqual({ error: 'Rows unreadable', code: 'ROWS', rows: [{ row: 1 }] });
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Source check: no route answers an error the old way                      */
/* -------------------------------------------------------------------------- */

describe('every file that answers /api requests uses apiError', () => {
  const routesDir = path.join(ROOT, 'apps', 'shell', 'lib', 'routes');
  const middlewareDir = path.join(ROOT, 'apps', 'shell', 'lib', 'middleware');
  const ts = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => path.join(dir, f));

  /** The helper itself is the one place `.status().json()` is allowed. */
  const exempt = (file: string) => path.basename(file) === 'apiError.ts';
  const files = [...ts(routesDir), ...ts(middlewareDir), path.join(ROOT, 'apps', 'shell', 'server.ts')].filter(
    f => !exempt(f)
  );

  /** `.status(<anything but 2xx>)` then `.json(` across whitespace and newlines. */
  const RAW_ERROR_STATUS = /\.status\(\s*(?!2\d\d\b)[^)]*\)\s*\.json\(/;
  /** A body whose first key is `error`, sent with the default 200. */
  const RAW_ERROR_BODY = /\.json\(\s*\{\s*error\b/;

  it('enumerates the real files, so a wrong path cannot pass on zero files', () => {
    const names = files.map(f => path.basename(f));
    for (const known of [
      'authRoutes.ts',
      'cutlineRoutes.ts',
      'devRoutes.ts',
      'parsingRoutes.ts',
      'scoringPresetRoutes.ts',
      'workspaceRoutes.ts',
      'hostOriginGuard.ts',
      'parsePdfGuard.ts',
      'apiErrorHandler.ts',
      'server.ts',
    ]) {
      expect(names, known).toContain(known);
    }
  });

  it.each(files.map(f => [path.relative(ROOT, f).replaceAll('\\', '/'), f] as const))(
    '%s sends no raw error response',
    (_name, file) => {
      const source = fs.readFileSync(file, 'utf8');
      expect(RAW_ERROR_STATUS.exec(source)?.[0]).toBeUndefined();
      expect(RAW_ERROR_BODY.exec(source)?.[0]).toBeUndefined();
    }
  );

  it('the pattern catches the shapes it exists for', () => {
    expect(RAW_ERROR_STATUS.test("res.status(500).json({ error: 'x' })")).toBe(true);
    expect(RAW_ERROR_STATUS.test("res\n  .status(400)\n  .json({ error: 'x' })")).toBe(true);
    expect(RAW_ERROR_STATUS.test("res.status(isCaller ? 400 : 500).json({ error: 'x' })")).toBe(true);
    expect(RAW_ERROR_STATUS.test("res.status(409).json({ code: 'X', error: 'x' })")).toBe(true);
    expect(RAW_ERROR_STATUS.test("res.status(201).json({ id: 1 })")).toBe(false);
    expect(RAW_ERROR_BODY.test("res.json({ error: 'x' })")).toBe(true);
    expect(RAW_ERROR_BODY.test('res.json({ success: true })')).toBe(false);
  });

  it('the route files that send errors import the helper', () => {
    for (const name of [
      'authRoutes.ts',
      'cutlineRoutes.ts',
      'parsingRoutes.ts',
      'scoringPresetRoutes.ts',
      'workspaceRoutes.ts',
    ]) {
      const source = fs.readFileSync(path.join(routesDir, name), 'utf8');
      expect(source, name).toMatch(/import \{ apiError \} from '\.\.\/middleware\/apiError\.ts'/);
      expect(source, name).toMatch(/apiError\(/);
    }
  });

  it('server.ts mounts the error handler after the app-wide parser and every route', () => {
    const source = fs.readFileSync(path.join(ROOT, 'apps', 'shell', 'server.ts'), 'utf8');
    const handler = source.indexOf('app.use(apiErrorHandler)');
    expect(handler).toBeGreaterThan(source.indexOf("app.use(express.json({ limit: '50mb' }))"));
    expect(handler).toBeGreaterThan(source.indexOf('registerParsingRoutes(app'));
    expect(handler).toBeGreaterThan(source.indexOf('registerWorkspaceRoutes(app'));
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Real routes: nothing of an exception reaches the wire in production      */
/* -------------------------------------------------------------------------- */

const pass: express.RequestHandler = (_q, _s, n) => n();

/** A repo whose every method throws `SECRET`, as a database that has gone bad would. */
function throwingRepo() {
  return new Proxy(
    { kind: 'sqlite' } as Record<string, unknown>,
    {
      get: (target, prop) =>
        prop in target
          ? target[prop as string]
          : async () => {
              throw new Error(SECRET);
            },
    }
  );
}

function expectNoLeak(res: RawResponse, why: string): void {
  expect(res.text, why).not.toContain('SECRET_LEAK');
  expect(res.text, why).not.toContain('SQLITE_CORRUPT');
  expect(res.json, why).not.toHaveProperty('details');
  expect(typeof res.json?.code, `${why}: code`).toBe('string');
  expect(typeof res.json?.error, `${why}: error`).toBe('string');
}

describe('workspace routes with a store that throws', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(() => {
      const app = express();
      app.use(express.json());
      registerWorkspaceRoutes(app, {
        repo: throwingRepo() as never,
        auth: null,
        shareLinks: {
          resolveToken: async () => {
            throw new Error(SECRET);
          },
        } as unknown as ShareLinkService,
        AUTH_REQUIRED: false,
        requireAuth: pass,
        optionalAuth: pass,
        defaultScoringSettings: {} as ScoringSettings,
      });
      return app;
    });
  });
  afterAll(() => server.close());

  const CASES: ReadonlyArray<readonly [string, string, string, unknown, string]> = [
    ['list', 'GET', '/api/workspaces', undefined, 'WORKSPACE_LIST_FAILED'],
    ['create', 'POST', '/api/workspaces', { name: 'x' }, 'WORKSPACE_CREATE_FAILED'],
    ['update', 'PUT', '/api/workspaces/w1', { name: 'y' }, 'WORKSPACE_UPDATE_FAILED'],
    ['delete', 'DELETE', '/api/workspaces/w1', undefined, 'WORKSPACE_DELETE_FAILED'],
    ['list backups', 'GET', '/api/workspaces/backups', undefined, 'BACKUP_LIST_FAILED'],
    ['backup', 'POST', '/api/workspaces/backup', {}, 'BACKUP_FAILED'],
    ['restore', 'POST', '/api/workspaces/restore', { file: 'x.json' }, 'RESTORE_FAILED'],
    ['snapshot', 'POST', '/api/workspaces/w1/snapshots', {}, 'SNAPSHOT_FAILED'],
    ['list snapshots', 'GET', '/api/workspaces/w1/snapshots', undefined, 'SNAPSHOT_LIST_FAILED'],
    ['read snapshot', 'GET', '/api/snapshots/s1', undefined, 'SNAPSHOT_READ_FAILED'],
    ['restore snapshot', 'POST', '/api/snapshots/s1/restore', {}, 'SNAPSHOT_RESTORE_FAILED'],
    ['report', 'GET', '/api/workspaces/w1/report', undefined, 'REPORT_FAILED'],
    ['share', 'GET', '/api/share/tok', undefined, 'SHARE_LOAD_FAILED'],
  ];

  it.each(CASES)('production: %s answers a code and no exception text', async (name, method, route, body, code) => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await server.request({ method, path: route, ...(body === undefined ? {} : { body }) });
    expect(res.status, name).toBe(500);
    expect(res.json.code).toBe(code);
    expectNoLeak(res, name);
  });

  it.each(CASES)('outside production: %s carries details', async (name, method, route, body, code) => {
    vi.stubEnv('NODE_ENV', 'test');
    const res = await server.request({ method, path: route, ...(body === undefined ? {} : { body }) });
    expect(res.status, name).toBe(500);
    expect(res.json.code).toBe(code);
    expect(res.json.details, name).toContain('SECRET_LEAK');
  });

  it('a validation 400 keeps its code in production and drops the issue list', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await server.request({ method: 'PUT', path: '/api/workspaces/w1', body: { menResults: 'x' } });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('INVALID_WORKSPACE_PATCH');
    expect(res.json).not.toHaveProperty('details');

    vi.stubEnv('NODE_ENV', 'test');
    const open = await server.request({ method: 'PUT', path: '/api/workspaces/w1', body: { menResults: 'x' } });
    expect(Array.isArray(open.json.details)).toBe(true);
  });

  it('keeps the named codes and statuses clients branch on', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const bad = await server.request({
      method: 'PUT',
      path: '/api/workspaces/w1',
      body: { name: 'y' },
      headers: { [EXPECTED_VERSION_HEADER]: 'abc' },
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe('BAD_EXPECTED_VERSION');
    expect(bad.json.error).toBe('Invalid expected version');
    expect(bad.json).not.toHaveProperty('details');
  });
});

describe('auth routes with a service that throws', () => {
  async function mountAuth(auth: Record<string, unknown>) {
    return startTestServer(() => {
      const app = express();
      app.use(express.json());
      registerAuthRoutes(app, {
        auth: auth as unknown as AuthService,
        optionalAuth: (req, _res, next) => {
          (req as { user?: unknown }).user = { id: 'u1', email: 'a@b.co', teamId: 't1', displayName: '' };
          next();
        },
        requireAuth: (req, _res, next) => {
          (req as { user?: unknown }).user = { id: 'u1', email: 'a@b.co', teamId: 't1', displayName: '' };
          next();
        },
        AUTH_REQUIRED: false,
      });
      return app;
    });
  }

  it('register: a database error is a fixed message in production, a sentinel stays a sentinel', async () => {
    const server = await mountAuth({
      register: async (email: string) => {
        throw new Error(email.startsWith('dup') ? 'EMAIL_EXISTS' : SECRET);
      },
    });
    try {
      vi.stubEnv('NODE_ENV', 'production');
      const boom = await server.request({
        method: 'POST',
        path: '/api/auth/register',
        body: { email: 'new@example.com', password: 'abcdefgh' },
      });
      expect(boom.status).toBe(500);
      expect(boom.json.code).toBe('REGISTRATION_FAILED');
      expectNoLeak(boom, 'register');

      const dup = await server.request({
        method: 'POST',
        path: '/api/auth/register',
        body: { email: 'dup@example.com', password: 'abcdefgh' },
      });
      expect(dup.status).toBe(409);
      expect(dup.json).toEqual({ error: 'EMAIL_EXISTS', code: 'EMAIL_EXISTS' });
    } finally {
      await server.close();
    }
  });

  it('invite: an unexpected error never reaches the wire in production', async () => {
    const server = await mountAuth({
      inviteToTeam: async (_t: string, _u: string, email: string) => {
        throw new Error(email === 'known@x.co' ? 'USER_NOT_FOUND' : SECRET);
      },
    });
    try {
      vi.stubEnv('NODE_ENV', 'production');
      const boom = await server.request({ method: 'POST', path: '/api/auth/invite', body: { email: 'x@y.co' } });
      expect(boom.status).toBe(400);
      expect(boom.json.code).toBe('INVITE_FAILED');
      expectNoLeak(boom, 'invite');

      const known = await server.request({ method: 'POST', path: '/api/auth/invite', body: { email: 'known@x.co' } });
      expect(known.status).toBe(400);
      expect(known.json).toEqual({ error: 'USER_NOT_FOUND', code: 'USER_NOT_FOUND' });
    } finally {
      await server.close();
    }
  });
});

describe('preset, cutline and parsing routes', () => {
  let sandbox: string;
  let server: TestServer;
  let projectRoot: string;

  const failingScript = (name: string): string => {
    const file = path.join(sandbox, `${name}.py`);
    fs.writeFileSync(
      file,
      [
        'import sys',
        `sys.stderr.write(${JSON.stringify(SECRET)})`,
        `sys.stdout.write(${JSON.stringify(JSON.stringify({ error: SECRET }))})`,
        'sys.exit(1)',
      ].join('\n') + '\n'
    );
    return file;
  };

  beforeAll(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-api-error-'));
    projectRoot = sandbox;
    // A file where the presets directory should be: every write fails with ENOTDIR.
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const cutlines = path.join(sandbox, 'cutlines');
    fs.mkdirSync(cutlines);
    fs.writeFileSync(path.join(cutlines, 'broken.json'), '{ not json');
    fs.writeFileSync(path.join(cutlines, 'nolines.json'), '{"other": 1}');

    server = await startTestServer(() => {
      const app = express();
      app.use(express.json());
      registerScoringPresetRoutes(app, { scoringPresetsDir: path.join(blocker, 'presets') });
      registerCutlineRoutes(app, {
        cutlinesDir: cutlines,
        fallbackCutlineVersion: 'v1',
        builtinCutlines: [],
      });
      registerParsingRoutes(app, {
        projectRoot,
        dataDir: sandbox,
        pdfParserScript: failingScript('legacy'),
        parseMeetScript: failingScript('unified'),
        parsePsychScript: failingScript('psych'),
        pointCalculatorScript: failingScript('calc'),
        teamRankingsScript: failingScript('rankings'),
        aiEnabled: false,
      });
      return app;
    });
  });
  afterAll(async () => {
    await server.close();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const validPreset = {
    id: 'p5-test',
    label: 'P5 test',
    settings: {
      scoringPoints: [9, 4, 3, 2, 1, 0],
      relayPoints: [11, 4, 2, 0],
      relayMultiplier: 2,
      halfRateRelaySwimmer: true,
      maxIndividualScorersPerTeam: 999,
      maxRelaysScoringPerTeam: 2,
      maxIndividualScorersPerTeamPerEvent: 3,
      aFinalBracketSize: 6,
      scorerCapScope: 'event',
      diverScorerWeight: 1,
      relayEligibleFromScorerPool: false,
      diverEventPattern: ['DIVING', 'DIVE'],
    },
  };
  const pdf = { base64: Buffer.from('%PDF-1.4 fake').toString('base64'), format: 'auto' };

  const CASES: ReadonlyArray<readonly [string, string, string, unknown, number, string]> = [
    ['preset save', 'POST', '/api/scoring-presets', validPreset, 500, 'PRESET_SAVE_FAILED'],
    ['cutline read', 'GET', '/api/cutlines/broken', undefined, 500, 'CUTLINES_READ_FAILED'],
    ['cutline shape', 'GET', '/api/cutlines/nolines', undefined, 500, 'CUTLINES_MALFORMED'],
    ['parse-pdf', 'POST', '/api/parse-pdf', pdf, 500, 'PDF_PARSE_FAILED'],
    ['parse-psych-pdf', 'POST', '/api/parse-psych-pdf', pdf, 500, 'PSYCH_PARSE_FAILED'],
  ];

  it.each(CASES)('production: %s sends a code and no exception text', async (name, method, route, body, status, code) => {
    vi.stubEnv('NODE_ENV', 'production');
    const res = await server.request({ method, path: route, ...(body === undefined ? {} : { body }) });
    expect(res.status, `${name}: ${res.text}`).toBe(status);
    expect(res.json.code).toBe(code);
    expectNoLeak(res, name);
  });

  it.each(CASES)('outside production: %s carries details', async (name, method, route, body, status, code) => {
    vi.stubEnv('NODE_ENV', 'test');
    const res = await server.request({ method, path: route, ...(body === undefined ? {} : { body }) });
    expect(res.status, name).toBe(status);
    expect(res.json.code).toBe(code);
    expect(typeof res.json.details, name).toBe('string');
  });

  it('a preset validation 400 drops the issue list in production and keeps it outside', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const bad = { ...validPreset, settings: { ...validPreset.settings, scoringPoints: 'nope' } };
    const prod = await server.request({ method: 'POST', path: '/api/scoring-presets', body: bad });
    expect(prod.status).toBe(400);
    expect(prod.json.code).toBe('INVALID_PRESET');
    expect(prod.json).not.toHaveProperty('details');
    vi.stubEnv('NODE_ENV', 'test');
    const dev = await server.request({ method: 'POST', path: '/api/scoring-presets', body: bad });
    expect(Array.isArray(dev.json.details)).toBe(true);
  });
});

describe('host guard and the last-resort handler', () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer(port => {
      const app = express();
      app.use('/api', createHostOriginGuard({ port, captureRoutePrefix: '/api/swimcloud/capture' }));
      app.use(express.json());
      app.post('/api/echo', (req, res) => res.json(req.body));
      app.get('/api/throws', () => {
        throw new Error(SECRET);
      });
      app.get('/plain', () => {
        throw new Error('plain page failure');
      });
      app.use(apiErrorHandler);
      return app;
    });
  });
  afterAll(() => server.close());

  it('a refused Host is HOST_NOT_ALLOWED, with the guidance in details outside production only', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const prod = await server.request({ path: '/api/echo', headers: { Host: 'evil.example' } });
    expect(prod.status).toBe(421);
    expect(prod.json).toEqual({ error: 'Host not allowed', code: 'HOST_NOT_ALLOWED' });
    vi.stubEnv('NODE_ENV', 'test');
    const dev = await server.request({ path: '/api/echo', headers: { Host: 'evil.example' } });
    expect(dev.json.details).toMatch(/OMNI_ALLOWED_HOSTS/);
  });

  it('malformed JSON is one JSON 400, not an HTML page with a stack', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const res = await server.request({
      method: 'POST',
      path: '/api/echo',
      body: '{ "a": ',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('BAD_JSON');
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.text).not.toMatch(/<html/i);
  });

  it('an exception thrown in a handler is INTERNAL_ERROR with no text in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await server.request({ path: '/api/throws' });
      expect(res.status).toBe(500);
      expect(res.json.code).toBe('INTERNAL_ERROR');
      expectNoLeak(res, 'throws');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves a non-/api failure to the next handler', async () => {
    const res = await server.request({ path: '/plain' });
    expect(res.status).toBe(500);
    expect(res.json).toBeUndefined();
  });
});

describe('parse failures that carry rows keep them in production', () => {
  let sandbox: string;
  let server: TestServer;
  const rows = [
    'row 12 (Pat Lee, Event 5 Men 200 Yard Freestyle): NT with 16 points',
    'row 13 (Sam Roe, Event 5 Men 200 Yard Freestyle): DQ with 14 points',
  ];
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

  const script = (name: string, stdout: unknown, exit = 0): string => {
    const file = path.join(sandbox, `${name}.py`);
    fs.writeFileSync(
      file,
      `import sys\nsys.stdout.write(${JSON.stringify(JSON.stringify(stdout))})\nsys.exit(${exit})\n`
    );
    return file;
  };

  /** One server per unified-parser behaviour. */
  const mountWith = async (unified: unknown, exit: number): Promise<TestServer> =>
    startTestServer(() => {
      const app = express();
      app.use(express.json());
      registerParsingRoutes(app, {
        projectRoot: sandbox,
        dataDir: sandbox,
        pdfParserScript: script('legacy', [goodRow]),
        parseMeetScript: script('unified', unified, exit),
        parsePsychScript: script('psych', { results: [] }),
        pointCalculatorScript: script('calc', []),
        teamRankingsScript: script('rankings', { eventThrough: null, men: {}, women: {}, markerFound: false }),
        aiEnabled: false,
      });
      return app;
    });

  beforeAll(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-api-error-rows-'));
  });
  afterEach(async () => {
    await server?.close();
  });
  afterAll(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const body = { base64: Buffer.from('%PDF-1.4 fake').toString('base64'), format: 'auto' };

  it('points_on_status_clock: 422, its own code and rows, no details', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    server = await mountWith(
      { error: 'two rows print points beside a status clock', code: 'points_on_status_clock', rows },
      1
    );
    const res = await server.request({ method: 'POST', path: '/api/parse-pdf', body });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('points_on_status_clock');
    expect(res.json.rows).toEqual(rows);
    expect(res.json.error).toBe('Place points sit beside an NT, DQ, NS, SCR or DNF time');
    expect(res.json).not.toHaveProperty('details');
  });

  it('unusable rows: 422 with the row problems and no details', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    server = await mountWith(
      { athletes: [{ ...goodRow, gender: undefined }], conference: null, officialTeamScores: null },
      0
    );
    const res = await server.request({ method: 'POST', path: '/api/parse-pdf', body });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('PDF_ROWS_UNREADABLE');
    expect(res.json.rows).toHaveLength(1);
    expect(res.json).not.toHaveProperty('details');
  });

  it('scoring_settings_missing: keeps 500 and its own code', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    server = await mountWith({ error: 'No scoring settings file', code: 'scoring_settings_missing' }, 1);
    const res = await server.request({ method: 'POST', path: '/api/parse-pdf', body });
    expect(res.status).toBe(500);
    expect(res.json.code).toBe('scoring_settings_missing');
    expect(res.json).not.toHaveProperty('details');
    expect(res.json).not.toHaveProperty('rows');
  });
});
