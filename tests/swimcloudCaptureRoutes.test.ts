/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `apps/shell/lib/swimcloudCaptureRoutes.ts` — the local HTTP surface the
 * SwimCloud browser extension posts a crawl into.
 *
 * Every test here drives a real Express app on a real socket against a real
 * temp directory. Nothing is mocked, because the five guards under test
 * (`plans/2026-09-08/03-extension-crawler.md`, "Security requirements") are
 * exactly the things a mock would paper over: a token compared, a route that
 * must not exist on a routable bind, a path that must not escape the store, a
 * body that must not be buffered past 2 MB.
 *
 * The path-traversal case asserts a **filesystem** outcome, not a status code.
 * A 400 proves the request was refused; it does not prove nothing was written.
 * `capture store writes outside its root without the route guard` first shows
 * that the store really does escape when handed a hostile id — otherwise the
 * guard test would prove nothing, the same argument `scripts/test_server_binding.mjs`
 * makes for its own "the regression guard only means something if at least one
 * case escaped" assertion.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterAll, describe, expect, it } from 'vitest';

import {
  createSwimCloudCaptureRouter,
  isValidSwimCloudCaptureId,
  loadOrCreateSwimCloudPairingToken,
  readCaptureSubject,
  registerSwimCloudCaptureRoutes,
  resolveCaptureFilePathWithinRoot,
  swimCloudCaptureBannerLines,
  swimCloudPairingTokenFilePath,
  timingSafeTokenEquals,
  SWIMCLOUD_CAPTURE_BODY_LIMIT_BYTES,
  SWIMCLOUD_CAPTURE_ROUTE_BASE,
  SWIMCLOUD_CAPTURE_TOKEN_HEADER,
} from '../apps/shell/lib/swimcloudCaptureRoutes.ts';
import type { SwimCloudCaptureParseResponse } from '../apps/shell/lib/swimcloudCaptureRoutes.ts';
import { FileSystemSwimCloudCaptureStore } from '../packages/swimcloud/src/captureStore.ts';

const TOKEN = 'a'.repeat(48);
const WRONG_TOKEN = 'b'.repeat(48);

const tmpRoot = mkdtempSync(path.join(tmpdir(), 'omniswim-capture-routes-'));
let dirCounter = 0;
function freshDir(label: string): string {
  dirCounter += 1;
  return path.join(tmpRoot, `${label}-${dirCounter}`);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

interface Harness {
  readonly url: string;
  readonly captureRoot: string;
  readonly store: FileSystemSwimCloudCaptureStore;
  close(): Promise<void>;
}

interface HarnessOptions {
  readonly host?: string;
  readonly token?: string;
  readonly extensionOrigin?: string;
  /**
   * Mount the app-wide 50 MB `express.json` first, exactly as `server.ts`'s
   * default ordering would if the capture router were ever moved below it.
   * The 2 MB cap must survive that.
   */
  readonly globalJsonParserFirst?: boolean;
  /** Skip `registerSwimCloudCaptureRoutes` and mount the router unconditionally. */
  readonly mountRouterDirectly?: boolean;
}

let lastRegistration: ReturnType<typeof registerSwimCloudCaptureRoutes> | undefined;

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const captureRoot = freshDir('store');
  const store = new FileSystemSwimCloudCaptureStore(captureRoot);
  const app = express();
  if (options.globalJsonParserFirst === true) {
    app.use(express.json({ limit: '50mb' }));
  }
  const routerOptions = {
    store,
    captureRoot,
    pairingToken: options.token ?? TOKEN,
    ...(options.extensionOrigin === undefined ? {} : { extensionOrigin: options.extensionOrigin }),
  };
  if (options.mountRouterDirectly === true) {
    app.use(SWIMCLOUD_CAPTURE_ROUTE_BASE, createSwimCloudCaptureRouter(routerOptions));
    lastRegistration = undefined;
  } else {
    lastRegistration = registerSwimCloudCaptureRoutes(app, {
      ...routerOptions,
      host: options.host ?? '127.0.0.1',
    });
  }

  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    captureRoot,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close(err => (err ? reject(err) : resolve()));
      }),
  };
}

interface CallOptions {
  readonly token?: string | null;
  readonly body?: unknown;
  readonly rawBody?: string;
  readonly origin?: string;
}

interface CallResult {
  readonly status: number;
  readonly json: Record<string, unknown> | unknown[] | undefined;
  readonly headers: Headers;
}

async function call(
  harness: Harness,
  method: string,
  route: string,
  options: CallOptions = {},
): Promise<CallResult> {
  const headers: Record<string, string> = {};
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers[SWIMCLOUD_CAPTURE_TOKEN_HEADER] = token;
  if (options.origin !== undefined) headers['Origin'] = options.origin;

  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${harness.url}${route}`, { method, headers, body });
  const text = await response.text();
  let json: CallResult['json'];
  try {
    json = JSON.parse(text) as Record<string, unknown> | unknown[];
  } catch {
    json = undefined;
  }
  return { status: response.status, json, headers: response.headers };
}

const BASE = SWIMCLOUD_CAPTURE_ROUTE_BASE;

/** A real page URL from the meet whose captures are archived in `tests/fixtures/`. */
const SOURCE_URL = 'https://www.swimcloud.com/results/356467/team/58/swims/?gender=F&page=3';
const CANONICAL_URL = 'https://www.swimcloud.com/results/356467/team/58/swims/?gender=F&page=3';
const PAGE_HTML = '<html><body><table class="c-table-clean"><tr><td>50 Y Free</td></tr></table></body></html>';

function pagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    omniswimSwimCloudCapture: 2,
    subject: { kind: 'meet', meetId: '356467' },
    sourceUrl: SOURCE_URL,
    retrievedAt: '2026-09-08T12:00:00.000Z',
    track: 'browser-extension',
    html: PAGE_HTML,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

describe('pairing token', () => {
  it('mints a 48-hex token, persists it, and reads the same one back', () => {
    const dir = freshDir('token');
    const first = loadOrCreateSwimCloudPairingToken(dir);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[0-9a-f]{48}$/);
    expect(first.filePath).toBe(swimCloudPairingTokenFilePath(dir));
    expect(existsSync(first.filePath)).toBe(true);

    const second = loadOrCreateSwimCloudPairingToken(dir);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);

    const onDisk = JSON.parse(readFileSync(first.filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.token).toBe(first.token);
    expect(typeof onDisk.createdAt).toBe('string');
  });

  it('replaces a malformed token file rather than trusting a weak secret', () => {
    const dir = freshDir('token-bad');
    const filePath = swimCloudPairingTokenFilePath(dir);
    loadOrCreateSwimCloudPairingToken(dir);
    writeFileSync(filePath, JSON.stringify({ token: 'short' }), 'utf8');

    const replaced = loadOrCreateSwimCloudPairingToken(dir);
    expect(replaced.created).toBe(true);
    expect(replaced.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('compares tokens without a short-circuit on the value', () => {
    expect(timingSafeTokenEquals(TOKEN, TOKEN)).toBe(true);
    expect(timingSafeTokenEquals(TOKEN, WRONG_TOKEN)).toBe(false);
    // Length mismatch must be false, not a throw — crypto.timingSafeEqual
    // rejects unequal-length buffers outright.
    expect(timingSafeTokenEquals(TOKEN, '')).toBe(false);
    expect(timingSafeTokenEquals(TOKEN, `${TOKEN}c`)).toBe(false);
  });
});

describe('captureId validation', () => {
  it('accepts exactly the shapes captureIdForSubject produces', () => {
    expect(isValidSwimCloudCaptureId('meet-356467')).toBe(true);
    expect(isValidSwimCloudCaptureId('team-58')).toBe(true);
    expect(isValidSwimCloudCaptureId('team-58-2026-2027')).toBe(true);
  });

  it('rejects every shape that could reach outside the captures directory', () => {
    for (const bad of [
      '../../pwned',
      '..',
      '.',
      'meet-1/../../x',
      'meet-1\\..\\x',
      'meet-1.json',
      '-meet-1',
      'MEET-1',
      '',
      'meet 1',
      'a'.repeat(200),
    ]) {
      expect(isValidSwimCloudCaptureId(bad)).toBe(false);
      expect(resolveCaptureFilePathWithinRoot('/tmp/store', bad)).toBeUndefined();
    }
  });

  it('resolves a valid id to a file directly inside <root>/captures', () => {
    const root = path.join(tmpRoot, 'resolve-check');
    const resolved = resolveCaptureFilePathWithinRoot(root, 'meet-356467');
    expect(resolved).toBe(path.resolve(root, 'captures', 'meet-356467.json'));
  });
});

describe('readCaptureSubject', () => {
  it('accepts meet and team subjects', () => {
    expect(readCaptureSubject({ kind: 'meet', meetId: '356467' })).toStrictEqual({
      ok: true,
      value: { kind: 'meet', meetId: '356467' },
    });
    expect(readCaptureSubject({ kind: 'team', teamId: '58', season: '2026-2027' })).toStrictEqual({
      ok: true,
      value: { kind: 'team', teamId: '58', season: '2026-2027' },
    });
  });

  it('rejects a season that would become a path segment', () => {
    const read = readCaptureSubject({ kind: 'team', teamId: '58', season: '../../pwned' });
    expect(read.ok).toBe(false);
  });

  it('rejects an unknown kind and a missing id', () => {
    expect(readCaptureSubject({ kind: 'conference', slug: 'nsisc' }).ok).toBe(false);
    expect(readCaptureSubject({ kind: 'meet' }).ok).toBe(false);
    expect(readCaptureSubject(null).ok).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 1. Pairing token gate                                                       */
/* -------------------------------------------------------------------------- */

describe('pairing token gate', () => {
  it('refuses every route without a token, and never touches the store', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const seeded = await harness.store.listCaptures();
      expect(seeded).toHaveLength(1);

      const calls: Array<[string, string, CallOptions]> = [
        ['POST', BASE, { body: { subject: { kind: 'meet', meetId: '999999' } } }],
        ['GET', BASE, {}],
        ['GET', `${BASE}/meet-356467`, {}],
        ['POST', `${BASE}/meet-356467/pages`, { body: pagePayload() }],
        ['POST', `${BASE}/meet-356467/parse`, {}],
        ['DELETE', `${BASE}/meet-356467`, {}],
      ];

      for (const [method, route, options] of calls) {
        const missing = await call(harness, method, route, { ...options, token: null });
        expect(missing.status, `${method} ${route} without a token`).toBe(401);
        expect(JSON.stringify(missing.json)).not.toContain('356467');

        const wrong = await call(harness, method, route, { ...options, token: WRONG_TOKEN });
        expect(wrong.status, `${method} ${route} with a wrong token`).toBe(403);
        expect(JSON.stringify(wrong.json)).not.toContain('356467');
      }

      // Nothing an unauthenticated caller sent was written, deleted or altered.
      const after = await harness.store.listCaptures();
      expect(after).toHaveLength(1);
      expect(after[0].captureId).toBe('meet-356467');
      expect(after[0].pages).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('rejects a token that is a prefix of the real one', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'GET', BASE, { token: TOKEN.slice(0, 47) });
      expect(res.status).toBe(403);
    } finally {
      await harness.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Loopback-only registration                                               */
/* -------------------------------------------------------------------------- */

describe('loopback-only registration', () => {
  it('does not register the routes at all on a routable bind', async () => {
    const harness = await startHarness({ host: '0.0.0.0' });
    try {
      expect(lastRegistration).toBeDefined();
      expect(lastRegistration?.registered).toBe(false);
      if (lastRegistration?.registered === false) {
        expect(lastRegistration.reason).toBe('non-loopback-host');
        expect(lastRegistration.detail).toMatch(/loopback/i);
      }

      // Not 401 and not 403 — the path does not exist, so the server does not
      // even advertise that a capture store is here.
      for (const [method, route] of [
        ['GET', BASE],
        ['POST', BASE],
        ['GET', `${BASE}/meet-356467`],
        ['POST', `${BASE}/meet-356467/pages`],
        ['POST', `${BASE}/meet-356467/parse`],
        ['DELETE', `${BASE}/meet-356467`],
      ] as const) {
        const res = await call(harness, method, route, {
          ...(method === 'POST' ? { body: { subject: { kind: 'meet', meetId: '1' } } } : {}),
        });
        expect(res.status, `${method} ${route} on a routable bind`).toBe(404);
      }
    } finally {
      await harness.close();
    }
  });

  it('registers on every loopback form', async () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.5.5.5', '::ffff:127.0.0.1']) {
      const harness = await startHarness({ host });
      try {
        expect(lastRegistration?.registered, host).toBe(true);
        const res = await call(harness, 'GET', BASE);
        expect(res.status, host).toBe(200);
      } finally {
        await harness.close();
      }
    }
  });

  it('names the pairing token in the banner when registered, and the reason when not', () => {
    const token = { token: TOKEN, filePath: '/data/swimcloud-pairing-token.json', created: false };
    const registered = swimCloudCaptureBannerLines(
      { registered: true, base: BASE, corsOrigin: undefined },
      token,
    ).join('\n');
    expect(registered).toContain(BASE);
    expect(registered).toContain(TOKEN);

    const skipped = swimCloudCaptureBannerLines(
      { registered: false, reason: 'non-loopback-host', detail: 'Bound to 0.0.0.0, ...' },
      token,
    ).join('\n');
    expect(skipped).toContain('NOT REGISTERED');
    expect(skipped).not.toContain(TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. CORS                                                                     */
/* -------------------------------------------------------------------------- */

describe('CORS', () => {
  it('sends no Access-Control-Allow-Origin by default', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'GET', BASE, { origin: 'chrome-extension://abcdefghijklmnop' });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('allows exactly the configured extension origin when one is set, and no other', async () => {
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const harness = await startHarness({ extensionOrigin: origin });
    try {
      const allowed = await call(harness, 'GET', BASE, { origin });
      expect(allowed.headers.get('access-control-allow-origin')).toBe(origin);

      const other = await call(harness, 'GET', BASE, { origin: 'https://evil.example' });
      expect(other.headers.get('access-control-allow-origin')).toBeNull();

      // A preflight carries no token by definition and must still be answered.
      const preflight = await call(harness, 'OPTIONS', BASE, { origin, token: null });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-headers')).toContain(
        SWIMCLOUD_CAPTURE_TOKEN_HEADER,
      );
    } finally {
      await harness.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Path traversal                                                           */
/* -------------------------------------------------------------------------- */

describe('captureId path traversal', () => {
  it('capture store writes outside its root without the route guard', async () => {
    // Proves the guard has something to guard against. FileSystemSwimCloudCaptureStore
    // builds its path by string concatenation and does no containment check of
    // its own — see resolveCaptureFilePathWithinRoot's doc comment.
    const outer = freshDir('escape-demo');
    const inner = path.join(outer, 'store');
    const store = new FileSystemSwimCloudCaptureStore(inner);
    await store.upsertCapture({
      captureId: '../../pwned',
      subject: { kind: 'meet', meetId: '1' },
      createdAt: '2026-09-08T00:00:00.000Z',
      updatedAt: '2026-09-08T00:00:00.000Z',
      track: 'browser-extension',
      completeness: 'in-progress',
      plannedPageCount: 0,
      pages: [],
      notes: [],
    });
    expect(existsSync(path.join(outer, 'pwned.json'))).toBe(true);
  });

  it('refuses a traversing id before the store is reached, writing nothing', async () => {
    const harness = await startHarness();
    try {
      const escaped = path.resolve(harness.captureRoot, 'captures', '..', '..', 'pwned.json');
      const escapedBackslash = path.resolve(harness.captureRoot, 'captures', '..', '..', 'pwned-bs.json');

      const cases: Array<[string, string, CallOptions]> = [
        // Percent-encoded separators survive URL parsing and arrive as one path
        // segment, which Express then decodes into `../../pwned`.
        ['POST', `${BASE}/..%2F..%2Fpwned/pages`, { body: pagePayload() }],
        ['POST', `${BASE}/..%2F..%2Fpwned/parse`, {}],
        ['GET', `${BASE}/..%2F..%2Fpwned`, {}],
        ['DELETE', `${BASE}/..%2F..%2Fpwned`, {}],
        ['POST', `${BASE}/..%5C..%5Cpwned-bs/pages`, { body: pagePayload() }],
        // A hostile id supplied in the body rather than the path.
        ['POST', BASE, { body: { subject: { kind: 'meet', meetId: '1' }, captureId: '../../pwned' } }],
        // A hostile id the server would otherwise derive itself, via `season`.
        ['POST', BASE, { body: { subject: { kind: 'team', teamId: '58', season: '../../pwned' } } }],
      ];

      for (const [method, route, options] of cases) {
        const res = await call(harness, method, route, options);
        expect(res.status, `${method} ${route}`).toBe(400);
      }

      expect(existsSync(escaped), escaped).toBe(false);
      expect(existsSync(escapedBackslash), escapedBackslash).toBe(false);
      expect(await harness.store.listCaptures()).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Body size cap                                                            */
/* -------------------------------------------------------------------------- */

describe('body size cap', () => {
  const oversized = () =>
    JSON.stringify(pagePayload({ html: 'x'.repeat(SWIMCLOUD_CAPTURE_BODY_LIMIT_BYTES + 512) }));

  it('rejects a body past 2 MB with 413 and stores nothing', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, {
        body: { subject: { kind: 'meet', meetId: '356467' }, plannedPageCount: 1 },
      });
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, { rawBody: oversized() });
      expect(res.status).toBe(413);

      const capture = await harness.store.getCapture('meet-356467');
      expect(capture?.pages).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('still caps at 2 MB when the app-wide 50 MB JSON parser ran first', async () => {
    // The regression this guards: body-parser is a no-op once req.body exists,
    // so a route-level express.json mounted below the global one inherits 50 MB
    // silently. The Content-Length check is what keeps the cap real.
    const harness = await startHarness({ globalJsonParserFirst: true, mountRouterDirectly: true });
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, { rawBody: oversized() });
      expect(res.status).toBe(413);
    } finally {
      await harness.close();
    }
  });

  it('accepts a body comfortably under the cap', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, {
        body: pagePayload({ html: `<html>${'y'.repeat(200_000)}</html>` }),
      });
      expect(res.status).toBe(200);
    } finally {
      await harness.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* End-to-end                                                                  */
/* -------------------------------------------------------------------------- */

describe('capture lifecycle with a valid token', () => {
  it('creates, lists, reads, pages, and deletes one capture', async () => {
    const harness = await startHarness();
    try {
      const created = await call(harness, 'POST', BASE, {
        body: { subject: { kind: 'meet', meetId: '356467' }, plannedPageCount: 66, label: 'New South Championships' },
      });
      expect(created.status).toBe(201);
      const record = created.json as Record<string, unknown>;
      expect(record.captureId).toBe('meet-356467');
      expect(record.plannedPageCount).toBe(66);
      expect(record.completeness).toBe('in-progress');
      expect(record.track).toBe('browser-extension');
      expect(record.pages).toStrictEqual([]);

      const listed = await call(harness, 'GET', BASE);
      expect(listed.status).toBe(200);
      expect(Array.isArray(listed.json)).toBe(true);
      expect((listed.json as Array<Record<string, unknown>>).map(r => r.captureId)).toStrictEqual([
        'meet-356467',
      ]);

      const posted = await call(harness, 'POST', `${BASE}/meet-356467/pages`, { body: pagePayload() });
      expect(posted.status).toBe(200);
      const page = (posted.json as Record<string, unknown>).page as Record<string, unknown>;
      expect(page.canonicalUrl).toBe(CANONICAL_URL);
      expect(page.resourceKind).toBe('meetTeamSwims');
      expect(page.meetId).toBe('356467');
      expect(page.teamId).toBe('58');
      // gender is carried verbatim; urlClassifier is explicit that M/F is an
      // unverified encoding and must not be mapped to Men/Women here.
      expect(page.gender).toBe('F');
      expect(page.page).toBe(3);
      expect(page.outcome).toBe('ok');
      expect(page.cacheStatus).toBe('provisional');
      expect(page.sha256).toBe(crypto.createHash('sha256').update(PAGE_HTML, 'utf8').digest('hex'));
      expect(page.bytes).toBe(Buffer.byteLength(PAGE_HTML, 'utf8'));

      const stored = await harness.store.readPage(CANONICAL_URL);
      expect(stored?.html).toBe(PAGE_HTML);
      expect(stored?.captureId).toBe('meet-356467');
      expect(stored?.status).toBe('provisional');

      const fetched = await call(harness, 'GET', `${BASE}/meet-356467`);
      expect(fetched.status).toBe(200);
      expect((fetched.json as Record<string, unknown>).pages).toHaveLength(1);
      expect((fetched.json as Record<string, unknown>).label).toBe('New South Championships');

      const deleted = await call(harness, 'DELETE', `${BASE}/meet-356467`);
      expect(deleted.status).toBe(200);
      expect((deleted.json as Record<string, unknown>).pagesDeleted).toBe(1);

      expect((await call(harness, 'GET', `${BASE}/meet-356467`)).status).toBe(404);
      expect(await harness.store.readPage(CANONICAL_URL)).toBeUndefined();
      expect((await call(harness, 'DELETE', `${BASE}/meet-356467`)).status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('re-posting the same page replaces its ref instead of appending a second one', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      await call(harness, 'POST', `${BASE}/meet-356467/pages`, { body: pagePayload() });
      await call(harness, 'POST', `${BASE}/meet-356467/pages`, { body: pagePayload() });
      const capture = await harness.store.getCapture('meet-356467');
      expect(capture?.pages).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });

  it('updates a record without wiping fields the update omitted', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, {
        body: { subject: { kind: 'meet', meetId: '356467' }, plannedPageCount: 66, label: 'New South' },
      });
      const updated = await call(harness, 'POST', BASE, {
        body: { subject: { kind: 'meet', meetId: '356467' }, completeness: 'partial' },
      });
      expect(updated.status).toBe(200);
      const record = updated.json as Record<string, unknown>;
      expect(record.completeness).toBe('partial');
      expect(record.plannedPageCount).toBe(66);
      expect(record.label).toBe('New South');
    } finally {
      await harness.close();
    }
  });

  it('records a 404 page as an http-error outcome and stores no bytes for it', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const missingWomens =
        'https://www.swimcloud.com/results/356467/team/58/swims/?gender=F&page=1';
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, {
        body: pagePayload({ sourceUrl: missingWomens, httpStatus: 404 }),
      });
      expect(res.status).toBe(200);
      const page = (res.json as Record<string, unknown>).page as Record<string, unknown>;
      expect(page.outcome).toBe('http-error');
      expect(page.httpStatus).toBe(404);
      expect(page.sha256).toBeUndefined();
      expect(page.bytes).toBeUndefined();
      expect(typeof page.detail).toBe('string');
      // A 404 body is an error page, not the resource — recorded as a fact, not cached as content.
      expect(await harness.store.readPage(missingWomens)).toBeUndefined();
    } finally {
      await harness.close();
    }
  });
});

describe('page upload validation', () => {
  it('refuses a page for a capture that was never opened', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, { body: pagePayload() });
      expect(res.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it('refuses a version 1 clipboard payload, which carries no subject', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, {
        body: {
          omniswimSwimCloudCapture: 1,
          sourceUrl: SOURCE_URL,
          retrievedAt: '2026-09-08T12:00:00.000Z',
          track: 'browser-extension',
          html: PAGE_HTML,
        },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toMatch(/version 2/i);
    } finally {
      await harness.close();
    }
  });

  it('refuses a page whose subject names a different meet', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, {
        body: pagePayload({ subject: { kind: 'meet', meetId: '379295' } }),
      });
      expect(res.status).toBe(409);
      const capture = await harness.store.getCapture('meet-356467');
      expect(capture?.pages).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('refuses a sourceUrl that is not a fetchable SwimCloud resource', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      for (const sourceUrl of [
        'https://evil.example/results/356467/',
        // robots.txt disallows /api/ — refused here as it is everywhere else.
        'https://www.swimcloud.com/api/results/356467/',
        'https://www.swimcloud.com/results/abc/',
        'not a url at all',
      ]) {
        const res = await call(harness, 'POST', `${BASE}/meet-356467/pages`, {
          body: pagePayload({ sourceUrl }),
        });
        expect(res.status, sourceUrl).toBe(400);
      }
      const capture = await harness.store.getCapture('meet-356467');
      expect(capture?.pages).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('rejects malformed JSON and a non-object body without throwing', async () => {
    const harness = await startHarness();
    try {
      await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId: '356467' } } });
      const notJson = await call(harness, 'POST', `${BASE}/meet-356467/pages`, { rawBody: '{ nope' });
      expect(notJson.status).toBe(400);
      const empty = await call(harness, 'POST', `${BASE}/meet-356467/pages`, { rawBody: '{}' });
      expect(empty.status).toBe(400);
    } finally {
      await harness.close();
    }
  });
});

describe('capture record validation', () => {
  it('rejects a bad track, completeness, plannedPageCount, notes and teamDiscovery', async () => {
    const harness = await startHarness();
    try {
      const subject = { kind: 'meet', meetId: '356467' };
      const bad: Array<Record<string, unknown>> = [
        { subject, track: 'hand-typed' },
        { subject, completeness: 'complete' },
        { subject, plannedPageCount: -1 },
        { subject, plannedPageCount: 1.5 },
        { subject, notes: [1, 2] },
        { subject, teamDiscovery: { source: 'guessing', completeness: 'unproven' } },
        { subject, teamDiscovery: { source: 'topteams' } },
        { subject: { kind: 'meet' } },
        {},
      ];
      for (const body of bad) {
        const res = await call(harness, 'POST', BASE, { body });
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(await harness.store.listCaptures()).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it('refuses client-supplied pages on the record route', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'POST', BASE, {
        body: {
          subject: { kind: 'meet', meetId: '356467' },
          pages: [{ canonicalUrl: CANONICAL_URL, resourceKind: 'meetTeamSwims', retrievedAt: 'x', cacheStatus: 'final', outcome: 'ok' }],
        },
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.json)).toContain('/pages');
    } finally {
      await harness.close();
    }
  });

  it('accepts a valid teamDiscovery block and round-trips it', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'POST', BASE, {
        body: {
          subject: { kind: 'meet', meetId: '356467' },
          teamDiscovery: {
            source: 'topteams',
            genders: ['M', 'F'],
            teamIds: ['58', '405'],
            completeness: 'user-confirmed',
          },
        },
      });
      expect(res.status).toBe(201);
      const stored = await harness.store.getCapture('meet-356467');
      expect(stored?.teamDiscovery).toStrictEqual({
        source: 'topteams',
        genders: ['M', 'F'],
        teamIds: ['58', '405'],
        completeness: 'user-confirmed',
      });
    } finally {
      await harness.close();
    }
  });

  it('derives a team captureId, season included', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'POST', BASE, {
        body: { subject: { kind: 'team', teamId: '58', season: '2026-2027' } },
      });
      expect(res.status).toBe(201);
      expect((res.json as Record<string, unknown>).captureId).toBe('team-58-2026-2027');
    } finally {
      await harness.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/swimcloud/captures/:id/parse                                      */
/* -------------------------------------------------------------------------- */

/**
 * These drive real archived SwimCloud markup through the real store and the real
 * parser. The numbers asserted below (30 rows, 14 events, `356467:swim:171560736`)
 * are the same ones `tests/swimcloudParser.test.ts` pins against the same
 * fixture, on purpose: if SwimCloud's markup drifts and the parser is updated,
 * both files fail together rather than this one quietly reporting `parses: []`
 * as though the capture were empty. A silent empty is the failure mode this
 * route is most able to hide.
 */
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => readFileSync(path.join(fixturesDir, name), 'utf8');

/** The archived page-1 capture of Henderson State's men's swims at meet 356467. */
const SWIMS_HTML = fixture('swimcloud-real-meet-team-swims-356467-team58-page1.html');
/** The archived team landing page for the same team and meet — a `meetTeam`, not a `meetTeamSwims`. */
const TEAM_LANDING_HTML = fixture('swimcloud-real-meet-team-landing-356467-team58.html');
/** The archived full team-standings page of meet 379295 — a `meetTopTeams`. */
const TOPTEAMS_HTML = fixture('swimcloud-real-meet-topteams-379295-gender-m.html');

/** The archived men's and women's roster captures of Henderson State (team 58) — `teamRoster`. */
const ROSTER_MEN_HTML = fixture('swimcloud-real-team-roster-58-gender-m.html');
const ROSTER_WOMEN_HTML = fixture('swimcloud-real-team-roster-58-gender-f.html');
/** The archived times page of swimmer 1472365 (River Paulk) — `swimmerTimes`. */
const SWIMMER_TIMES_HTML = fixture('swimcloud-real-swimmer-times-1472365.html');
/** The archived per-event results page of event 26 at meet 356467 — `meetEvent` (fixture F9). */
const EVENT_26_HTML = fixture('swimcloud-real-meet-event-356467-event26.html');
const EVENT_26_URL = 'https://www.swimcloud.com/results/356467/event/26/';
/** The archived meet root of 379295 — a `meet`, which is not a parse candidate at all. */
const MEET_LANDING_HTML = fixture('swimcloud-real-meet-landing-379295-gender-m.html');

const SWIMS_PAGE_1 = 'https://www.swimcloud.com/results/356467/team/58/swims/';
const SWIMS_PAGE_2 = 'https://www.swimcloud.com/results/356467/team/58/swims/?page=2';
const TEAM_LANDING = 'https://www.swimcloud.com/results/356467/team/58/';

/**
 * The roster and swimmer-times capture URLs, verbatim from each fixture's own
 * provenance header — the same strings `tests/swimcloudTeamRosterParser.test.ts`
 * and `tests/swimcloudSwimmerTimesParser.test.ts` drive their parsers with.
 */
const ROSTER_MEN_URL = 'https://www.swimcloud.com/team/58/roster/?page=1&gender=M&season_id=29&sort=name';
const ROSTER_WOMEN_URL = 'https://www.swimcloud.com/team/58/roster/?page=1&gender=F&season_id=29&sort=name';
const SWIMMER_TIMES_URL = 'https://www.swimcloud.com/swimmer/1472365/times/';
const MEET_LANDING_URL = 'https://www.swimcloud.com/results/379295/?gender=M';

/**
 * A team subject, which is what a roster crawl is filed under.
 *
 * A capture's subject names the crawl target, not the shape of each page in it:
 * `subjectsAgree` compares subjects and never the page URL, so one team capture
 * legitimately holds that team's roster, its swimmers' times pages, and its
 * swims at a meet. That is the crawl this suite's team track actually produces.
 */
const TEAM_SUBJECT = { kind: 'team', teamId: '58' } as const;
const TEAM_CAPTURE_ID = 'team-58';

/** Open a meet capture and post one page into it, exactly as the extension would. */
async function seedPage(
  harness: Harness,
  meetId: string,
  sourceUrl: string,
  html: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await call(harness, 'POST', `${BASE}/meet-${meetId}/pages`, {
    body: pagePayload({ subject: { kind: 'meet', meetId }, sourceUrl, html, ...extra }),
  });
  expect(res.status, `seeding ${sourceUrl}`).toBe(200);
}

async function openCapture(harness: Harness, meetId: string): Promise<void> {
  const res = await call(harness, 'POST', BASE, { body: { subject: { kind: 'meet', meetId } } });
  expect(res.status, `opening meet-${meetId}`).toBe(201);
}

/** The same two steps for a team-subject capture, which is what holds a roster. */
async function openTeamCapture(harness: Harness): Promise<void> {
  const res = await call(harness, 'POST', BASE, { body: { subject: TEAM_SUBJECT } });
  expect(res.status, `opening ${TEAM_CAPTURE_ID}`).toBe(201);
}

async function seedTeamPage(
  harness: Harness,
  sourceUrl: string,
  html: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const res = await call(harness, 'POST', `${BASE}/${TEAM_CAPTURE_ID}/pages`, {
    body: pagePayload({ subject: TEAM_SUBJECT, sourceUrl, html, ...extra }),
  });
  expect(res.status, `seeding ${sourceUrl}`).toBe(200);
}

async function parseCapture(harness: Harness, captureId: string) {
  const res = await call(harness, 'POST', `${BASE}/${captureId}/parse`);
  return { status: res.status, body: res.json as unknown as SwimCloudCaptureParseResponse };
}

describe('capture parse route', () => {
  it('parses every stored meetTeamSwims page and returns the real swims', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      await seedPage(harness, '356467', SWIMS_PAGE_1, SWIMS_HTML);
      // The same archived bytes filed under a second page URL. This is a claim
      // about the ROUTE (it parses every meetTeamSwims page, not only the first),
      // not a claim that page 2 of the real meet holds these thirty swims.
      await seedPage(harness, '356467', SWIMS_PAGE_2, SWIMS_HTML);
      // A real sibling page of a different kind. It parses fine on its own — the
      // route must still skip it, because it is a top-10 summary card and reading
      // it as a team's full list is exactly the wrong-page mistake
      // parseTeamMeetSwimsHtml's doc comment warns about.
      await seedPage(harness, '356467', TEAM_LANDING, TEAM_LANDING_HTML);

      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      expect(body.captureId).toBe('meet-356467');
      expect(body.subject).toStrictEqual({ kind: 'meet', meetId: '356467' });
      // Two swims pages in, two parses out. The meetTeam page is excluded with
      // no warning: it was never a candidate for this parser.
      expect(body.parses).toHaveLength(2);
      expect(body.warnings).toStrictEqual([]);

      const [first] = body.parses;
      expect(first.swimCloudMeetId).toBe('356467');
      expect(first.swimCloudTeamId).toBe('58');
      expect(first.teamName).toBe('Henderson State University');
      expect(first.meetName).toBe('New South Championships');
      expect(first.gender).toBe('Men');
      expect(first.rowCount).toBe(30);
      expect(first.swims).toHaveLength(30);
      expect(first.events).toHaveLength(14);
      expect(first.pagination).toStrictEqual({
        currentPage: 1,
        totalPages: 8,
        nextPageHref: '?page=2',
      });
      // A real swim, not a shape check: Avery Henke's row, keyed off SwimCloud's
      // own swim id.
      expect(first.swims[0].swimKey).toBe('356467:swim:171560736');
      expect(first.swims[0].event.label).toBe('100 Y Breast');
      expect(first.swims[0].result.place).toBe(1);
      // The three relay leadoff splits survive the round trip flagged, so a
      // consumer of this route can still refuse to score them as individual swims.
      expect(first.swims.filter(swim => swim.relayLeadoff)).toHaveLength(3);
    } finally {
      await harness.close();
    }
  });

  it('parses a stored meetEvent page and returns the real rounds and meet points', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      await seedPage(harness, '356467', EVENT_26_URL, EVENT_26_HTML);
      // The page really is filed as a meetEvent, so an empty `eventResults`
      // below would be the route failing to read it rather than the seeding
      // having quietly gone somewhere else.
      const stored = await harness.store.getCapture('meet-356467');
      expect(stored?.pages.map(page => page.resourceKind)).toStrictEqual(['meetEvent']);

      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      expect(body.captureId).toBe('meet-356467');
      expect(body.eventResults).toHaveLength(1);
      // A per-event page is not a swims list, not a roster and not a times
      // page, so it contributes to exactly one of the four lists.
      expect(body.parses).toStrictEqual([]);
      expect(body.rosters).toStrictEqual([]);
      expect(body.swimmerTimes).toStrictEqual([]);
      expect(body.warnings).toStrictEqual([]);

      const [event] = body.eventResults;
      expect(event.swimCloudMeetId).toBe('356467');
      expect(event.eventRef).toBe('26');
      expect(event.eventLabel).toBe('100 Breast');
      expect(event.meetName).toBe('New South Championships');
      // Read off the page's own gender dropdown. Event-id arithmetic would
      // answer wrongly here — this page's toggle points at event 100 and 400.
      expect(event.gender).toBe('Men');
      expect(event.rowCount).toBe(40);

      // The four captioned round tables, in printed (program) order rather
      // than chronological order: Preliminaries swam first and prints last.
      expect(event.rounds.map(round => [round.round, round.rowCount])).toStrictEqual([
        ['A Final', 8],
        ['B Final', 7],
        ['C Final', 5],
        ['Preliminaries', 20],
      ]);
      // Two different quantities, survived the round trip apart: A/B Final
      // publish the real meet Score, C Final and Prelims publish SwimCloud's
      // power index. A caller that confused them would multiply a team score.
      expect(event.rounds.map(round => round.pointsColumn)).toStrictEqual([
        'score',
        'score',
        'pts',
        'pts',
      ]);
      const [aFinal, , cFinal, prelims] = event.rounds;
      expect(aFinal.swims.map(swim => swim.meetScore)).toStrictEqual([20, 17, 16, 15, 14, 13, 12, 11]);
      // The rounds that did not score carry no meetScore at all — absent
      // across JSON, never a zero a consumer would add up.
      expect(cFinal.swims.every(swim => swim.meetScore === undefined)).toBe(true);
      expect(prelims.swims.every(swim => swim.meetScore === undefined)).toBe(true);
      expect(cFinal.swims.map(swim => swim.result.points)).toStrictEqual([709, 638, 547, 502, 424]);

      // A real swim, not a shape check: Avery Henke's A Final row, keyed off
      // SwimCloud's own swim id, with the slower of her two 100 Breast times.
      const henkeA = aFinal.swims.find(swim => swim.entry.athleteName === 'Avery Henke');
      expect(henkeA).toMatchObject({
        swimKey: '356467:swim:171560737',
        swimCloudSwimId: '171560737',
        roundLabel: 'A Final',
        meetScore: 20,
      });
      expect(henkeA?.result.finalTime).toBe('54.27');
      expect(henkeA?.result.place).toBe(1);
      expect(henkeA?.entry).toMatchObject({ teamName: 'Henderson State', swimCloudTeamId: '58' });

      // All five C Final swimmers are exhibition, marked from the rank cell.
      // The marker replaced the ordinal, so those rows print no place — absent,
      // not zero, and not a parse failure.
      expect(cFinal.swims.map(swim => swim.exhibition)).toStrictEqual([true, true, true, true, true]);
      expect(cFinal.swims.every(swim => swim.result.flags?.exhibition === true)).toBe(true);
      expect(cFinal.swims.every(swim => swim.result.place === undefined)).toBe(true);
      expect(prelims.swims.filter(swim => swim.exhibition).map(swim => swim.entry.athleteName)).toStrictEqual([
        'Camden Mask',
        'Benjamin Skinner',
        'Theo Scarpino',
        'Donovan Stangl',
        'Aiden Killackey',
      ]);
    } finally {
      await harness.close();
    }
  });

  it('returns a meetEvent page and a meetTeamSwims page that join on swimKey', async () => {
    const harness = await startHarness();
    try {
      // The join the whole per-event page exists for. Both kinds in one meet
      // capture, through one parse call, is exactly what
      // `swimCloudTeamMeetSwimsToSwimmerResults` is handed.
      await openCapture(harness, '356467');
      await seedPage(harness, '356467', SWIMS_PAGE_1, SWIMS_HTML);
      await seedPage(harness, '356467', EVENT_26_URL, EVENT_26_HTML);

      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      expect(body.parses).toHaveLength(1);
      expect(body.eventResults).toHaveLength(1);
      expect(body.warnings).toStrictEqual([]);

      // Avery Henke's two "100 Y Breast" rows on the swims list. Both read
      // "1st", in two different pools, which is why the swims list's own Place
      // could never tell them apart on its own.
      const swimsKeys = body.parses[0].swims
        .filter(swim => swim.entry.athleteName === 'Avery Henke' && swim.event.label === '100 Y Breast')
        .map(swim => swim.swimKey);
      expect(swimsKeys.sort()).toStrictEqual(['356467:swim:171560736', '356467:swim:171560737']);

      // The event page names the round for each of them, keyed identically.
      const byKey = new Map(
        body.eventResults[0].rounds.flatMap(round => round.swims.map(swim => [swim.swimKey, swim] as const)),
      );
      expect(byKey.get('356467:swim:171560737')?.roundLabel).toBe('A Final');
      expect(byKey.get('356467:swim:171560736')?.roundLabel).toBe('Preliminaries');
      // And only the finals swim carries meet points — the prelim swim scored
      // nothing, which is absent rather than zero on both sides of the join.
      expect(byKey.get('356467:swim:171560737')?.meetScore).toBe(20);
      expect(byKey.get('356467:swim:171560736')?.meetScore).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it('warns about a page with no stored bytes and parses the rest', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      await seedPage(harness, '356467', SWIMS_PAGE_1, SWIMS_HTML);
      const missingWomens = 'https://www.swimcloud.com/results/356467/team/58/swims/?gender=F';
      // A 404 is a real outcome (this team may field no women's program), stored
      // as a page ref with no bytes. It must not crash the parse and must not
      // silently vanish either.
      await seedPage(harness, '356467', missingWomens, PAGE_HTML, { httpStatus: 404 });

      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      expect(body.parses).toHaveLength(1);
      expect(body.warnings).toStrictEqual([
        `No stored content for ${missingWomens} (outcome: http-error)`,
      ]);
    } finally {
      await harness.close();
    }
  });

  it('warns about a meetTeamSwims page that will not parse, and keeps the others', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      await seedPage(harness, '356467', SWIMS_PAGE_1, SWIMS_HTML);
      const broken = 'https://www.swimcloud.com/results/356467/team/58/swims/?page=3';
      await seedPage(harness, '356467', broken, '<html><body><p>nope</p></body></html>');

      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      // One bad page costs one page, never the whole capture.
      expect(body.parses).toHaveLength(1);
      expect(body.parses[0].swims).toHaveLength(30);
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain(`Could not parse ${broken}: `);
      expect(body.warnings[0]).toContain('<table>');
    } finally {
      await harness.close();
    }
  });

  it('flattens a successful page\'s own parser warnings, keeping the page and the row', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      const warnUrl = 'https://www.swimcloud.com/results/356467/team/58/swims/?page=5';
      // A results table this parser reads, holding one row it can only partly
      // read: no swim link, and a time cell that is not a time. Both are
      // warnings, not failures — the row is kept, the time is not invented.
      await seedPage(
        harness,
        '356467',
        warnUrl,
        [
          '<html><body><table class="c-table-clean">',
          '<thead><tr><th>#</th><th>Name</th><th>Event</th><th>Time</th><th>Place</th></tr></thead>',
          '<tbody><tr><td>1</td><td><a href="/results/356467/swimmer/1865160/">Avery Henke</a></td>',
          '<td>100 Y Free</td><td>banana</td><td>1st</td></tr></tbody>',
          '</table></body></html>',
        ].join(''),
      );

      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      // The page still parsed, so it is still in `parses`.
      expect(body.parses).toHaveLength(1);
      expect(body.parses[0].swims).toHaveLength(1);
      // Neither warning invented a value: no time was recorded, and the raw
      // token survives for a human to look at.
      expect(body.parses[0].swims[0].result.finalTime).toBeUndefined();
      expect(body.parses[0].swims[0].result.rawTimeToken).toBe('banana');
      // Each warning names the page it came from, the row, and the parser's own
      // code. This is the string shape the picker renders.
      expect(body.warnings.map(line => line.split(' — ')[0])).toStrictEqual([
        `${warnUrl} (row 0): missing-swim-link`,
        `${warnUrl} (row 0): unrecognized-time-token`,
      ]);
      expect(body.warnings[1]).toContain('"banana"');
    } finally {
      await harness.close();
    }
  });

  it('answers 200 with an empty parses list when the capture holds no swims page', async () => {
    const harness = await startHarness();
    try {
      // A meet-standings page is fetched to discover which teams competed. A
      // capture that holds only that is mid-crawl, not broken — an empty result
      // is a fact about its contents, so it is a 200, not a 4xx.
      await openCapture(harness, '379295');
      await seedPage(
        harness,
        '379295',
        'https://www.swimcloud.com/results/379295/topteams/?gender=M',
        TOPTEAMS_HTML,
      );

      const { status, body } = await parseCapture(harness, 'meet-379295');
      expect(status).toBe(200);
      expect(body.captureId).toBe('meet-379295');
      expect(body.subject).toStrictEqual({ kind: 'meet', meetId: '379295' });
      expect(body.parses).toStrictEqual([]);
      // Nor for the other three: a meetTopTeams page is not a roster, not a
      // swimmer's times page, and not one event's results page either.
      expect(body.rosters).toStrictEqual([]);
      expect(body.swimmerTimes).toStrictEqual([]);
      expect(body.eventResults).toStrictEqual([]);
      // No warning: a meetTopTeams page was never a candidate for any parser.
      expect(body.warnings).toStrictEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('answers 200 with every result list empty for a capture with no pages at all', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      const { status, body } = await parseCapture(harness, 'meet-356467');
      expect(status).toBe(200);
      expect(body.parses).toStrictEqual([]);
      // An old capture, stored before this route learned to read rosters,
      // swimmer times and event results, answers exactly this: four empty
      // lists and no warning. Absent and empty are both honest here, and
      // neither is an error.
      expect(body.rosters).toStrictEqual([]);
      expect(body.swimmerTimes).toStrictEqual([]);
      expect(body.eventResults).toStrictEqual([]);
      expect(body.warnings).toStrictEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('404s for a capture that does not exist', async () => {
    const harness = await startHarness();
    try {
      const res = await call(harness, 'POST', `${BASE}/meet-999999/parse`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.json)).toContain('meet-999999');
    } finally {
      await harness.close();
    }
  });

  it('accepts and ignores a request body', async () => {
    const harness = await startHarness();
    try {
      await openCapture(harness, '356467');
      await seedPage(harness, '356467', SWIMS_PAGE_1, SWIMS_HTML);
      const res = await call(harness, 'POST', `${BASE}/meet-356467/parse`, {
        body: { somethingTheRouteDoesNotModel: true },
      });
      expect(res.status).toBe(200);
      expect((res.json as unknown as SwimCloudCaptureParseResponse).parses).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* /parse — the two kinds added alongside meetTeamSwims                        */
/* -------------------------------------------------------------------------- */

/**
 * `teamRoster` and `swimmerTimes` through the same route, with the same rules.
 *
 * The values asserted here are the same ones `tests/swimcloudTeamRosterParser.test.ts`
 * and `tests/swimcloudSwimmerTimesParser.test.ts` pin against the same archived
 * markup — 35 men, 16 women, Colin Candebat's row, River Paulk's 19.42 — so a
 * SwimCloud layout change breaks both files together instead of this one
 * quietly reporting `rosters: []` as though the capture held no roster. A
 * silent empty is the failure mode this route is most able to hide, and it now
 * has three lists to hide it in rather than one.
 */
describe('capture parse route — rosters and swimmer times', () => {
  it('parses both stored roster pages and returns the real athletes', async () => {
    const harness = await startHarness();
    try {
      await openTeamCapture(harness);
      await seedTeamPage(harness, ROSTER_MEN_URL, ROSTER_MEN_HTML);
      await seedTeamPage(harness, ROSTER_WOMEN_URL, ROSTER_WOMEN_HTML);

      const { status, body } = await parseCapture(harness, TEAM_CAPTURE_ID);
      expect(status).toBe(200);
      expect(body.captureId).toBe(TEAM_CAPTURE_ID);
      expect(body.subject).toStrictEqual({ kind: 'team', teamId: '58' });
      // A roster is one page per gender with no combined view, so a fully
      // crawled team is two entries, in stored page order.
      expect(body.rosters).toHaveLength(2);
      // The other two lists are untouched by a roster-only capture.
      expect(body.parses).toStrictEqual([]);
      expect(body.swimmerTimes).toStrictEqual([]);
      expect(body.warnings).toStrictEqual([]);

      const [men, women] = body.rosters;
      expect(men.swimCloudTeamId).toBe('58');
      expect(men.teamName).toBe('Henderson State University');
      // Read off the page's own "Season 2025-2026 Men" heading, never off the
      // URL's ?gender=M — which is why `genderSource` is 'page' even though the
      // capture URL carried the parameter.
      expect(men.gender).toBe('Men');
      expect(men.genderSource).toBe('page');
      expect(men.season).toBe('2025-2026');
      expect(men.rowCount).toBe(35);
      expect(men.athletes).toHaveLength(35);
      // A real row, not a shape check.
      expect(men.athletes.find(a => a.name === 'Colin Candebat')).toStrictEqual({
        swimCloudSwimmerId: '1865160',
        name: 'Colin Candebat',
        swimCloudTeamId: '58',
        classYear: 'SO',
        gender: 'Men',
        season: '2025-2026',
        hometown: 'Norco, LA',
      });

      expect(women.gender).toBe('Women');
      expect(women.genderSource).toBe('page');
      expect(women.rowCount).toBe(16);
      expect(women.athletes).toHaveLength(16);
      expect(women.athletes.find(a => a.name === 'Emma Crowe')).toStrictEqual({
        swimCloudSwimmerId: '1828356',
        name: 'Emma Crowe',
        swimCloudTeamId: '58',
        classYear: 'SO',
        gender: 'Women',
        season: '2025-2026',
        hometown: 'Hot Springs National Park, AR',
      });
    } finally {
      await harness.close();
    }
  });

  it('parses a stored swimmer-times page and returns the real personal bests', async () => {
    const harness = await startHarness();
    try {
      await openTeamCapture(harness);
      await seedTeamPage(harness, SWIMMER_TIMES_URL, SWIMMER_TIMES_HTML);

      const { status, body } = await parseCapture(harness, TEAM_CAPTURE_ID);
      expect(status).toBe(200);
      expect(body.swimmerTimes).toHaveLength(1);
      expect(body.parses).toStrictEqual([]);
      expect(body.rosters).toStrictEqual([]);
      expect(body.warnings).toStrictEqual([]);

      const [times] = body.swimmerTimes;
      expect(times.swimCloudSwimmerId).toBe('1472365');
      // The page's own #swimmer-info block answered, not the capture URL — and
      // the name survives family-name-first, never reshaped into display order.
      expect(times.swimmerIdSource).toBe('swimmer-info-json');
      expect(times.name).toBe('Paulk, River J');
      expect(times.rowCount).toBe(9);
      expect(times.personalBests).toHaveLength(9);

      const fiftyFree = times.personalBests.find(best => best.eventLabel === '50 Free SCY');
      expect(fiftyFree?.time).toBe('19.42');
      expect(fiftyFree?.meetName).toBe('James E Martin Invitational');
      expect(fiftyFree?.swimCloudMeetId).toBe('338673');
      expect(fiftyFree?.swimCloudSwimId).toBe('147489244');
      expect(fiftyFree?.date).toBe('Mar 1, 2025');
      expect(fiftyFree?.relayLeadoff).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it('keeps all three kinds apart in one capture, none clobbering another', async () => {
    const harness = await startHarness();
    try {
      // One team crawl that reached all three page kinds: the team's roster,
      // one of its swimmers' times, and the team's swims at a meet it entered.
      await openTeamCapture(harness);
      await seedTeamPage(harness, ROSTER_MEN_URL, ROSTER_MEN_HTML);
      await seedTeamPage(harness, SWIMMER_TIMES_URL, SWIMMER_TIMES_HTML);
      await seedTeamPage(harness, SWIMS_PAGE_1, SWIMS_HTML);
      // A fourth page of a kind no parser claims. It must still contribute
      // nothing to any of the three lists and no warning.
      await seedTeamPage(harness, TEAM_LANDING, TEAM_LANDING_HTML);

      const { status, body } = await parseCapture(harness, TEAM_CAPTURE_ID);
      expect(status).toBe(200);
      expect(body.warnings).toStrictEqual([]);

      expect(body.parses).toHaveLength(1);
      expect(body.rosters).toHaveLength(1);
      expect(body.swimmerTimes).toHaveLength(1);

      // Each list holds its own shape, and each holds the real page's values —
      // so nothing was routed into the wrong list or overwritten by a later page.
      expect(body.parses[0].swimCloudMeetId).toBe('356467');
      expect(body.parses[0].swims).toHaveLength(30);
      expect(body.parses[0].swims[0].swimKey).toBe('356467:swim:171560736');
      expect(body.rosters[0].athletes).toHaveLength(35);
      expect(body.rosters[0].gender).toBe('Men');
      expect(body.swimmerTimes[0].swimCloudSwimmerId).toBe('1472365');
      expect(body.swimmerTimes[0].personalBests).toHaveLength(9);
    } finally {
      await harness.close();
    }
  });

  it('warns about a roster page with no stored bytes in the existing shape', async () => {
    const harness = await startHarness();
    try {
      await openTeamCapture(harness);
      await seedTeamPage(harness, ROSTER_MEN_URL, ROSTER_MEN_HTML);
      // A 404 for the women's roster is a real outcome — this school may field
      // no women's program. It is stored as a page ref with no bytes, and gets
      // the same warning line a swims page with no bytes gets.
      await seedTeamPage(harness, ROSTER_WOMEN_URL, ROSTER_WOMEN_HTML, { httpStatus: 404 });

      const { status, body } = await parseCapture(harness, TEAM_CAPTURE_ID);
      expect(status).toBe(200);
      expect(body.rosters).toHaveLength(1);
      expect(body.rosters[0].gender).toBe('Men');
      expect(body.warnings).toStrictEqual([
        `No stored content for ${ROSTER_WOMEN_URL} (outcome: http-error)`,
      ]);
    } finally {
      await harness.close();
    }
  });

  it('warns about a swimmer-times page with no stored bytes in the existing shape', async () => {
    const harness = await startHarness();
    try {
      await openTeamCapture(harness);
      await seedTeamPage(harness, SWIMMER_TIMES_URL, SWIMMER_TIMES_HTML, { httpStatus: 503 });

      const { status, body } = await parseCapture(harness, TEAM_CAPTURE_ID);
      expect(status).toBe(200);
      expect(body.swimmerTimes).toStrictEqual([]);
      expect(body.warnings).toStrictEqual([
        `No stored content for ${SWIMMER_TIMES_URL} (outcome: http-error)`,
      ]);
    } finally {
      await harness.close();
    }
  });

  it('warns about a roster page that will not parse, and keeps the other kinds', async () => {
    const harness = await startHarness();
    try {
      await openTeamCapture(harness);
      await seedTeamPage(harness, ROSTER_MEN_URL, ROSTER_MEN_HTML);
      await seedTeamPage(harness, SWIMMER_TIMES_URL, SWIMMER_TIMES_HTML);
      const broken = 'https://www.swimcloud.com/team/58/roster/?gender=F';
      await seedTeamPage(harness, broken, '<html><body><p>nope</p></body></html>');

      const { status, body } = await parseCapture(harness, TEAM_CAPTURE_ID);
      expect(status).toBe(200);
      // One bad page costs one page, and costs the other two kinds nothing.
      expect(body.rosters).toHaveLength(1);
      expect(body.swimmerTimes).toHaveLength(1);
      expect(body.warnings).toHaveLength(1);
      expect(body.warnings[0]).toContain(`Could not parse ${broken}: `);
      expect(body.warnings[0]).toContain('<table>');
    } finally {
      await harness.close();
    }
  });

  it('still excludes a non-parseable kind silently, for all three result lists', async () => {
    const harness = await startHarness();
    try {
      // A meet root, fetched to discover which teams competed. It is not a
      // swims list, not a roster and not a times page, so it was never a
      // candidate for any of the three parsers — no entry anywhere, no warning.
      await openCapture(harness, '379295');
      await seedPage(harness, '379295', MEET_LANDING_URL, MEET_LANDING_HTML);
      // The page really is stored, so the empty lists below are the route
      // skipping it rather than the seeding having quietly failed.
      const stored = await harness.store.getCapture('meet-379295');
      expect(stored?.pages.map(page => page.resourceKind)).toStrictEqual(['meet']);

      const { status, body } = await parseCapture(harness, 'meet-379295');
      expect(status).toBe(200);
      expect(body.parses).toStrictEqual([]);
      expect(body.rosters).toStrictEqual([]);
      expect(body.swimmerTimes).toStrictEqual([]);
      expect(body.warnings).toStrictEqual([]);
    } finally {
      await harness.close();
    }
  });
});
