/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `POST /api/parse-pdf` size limit and `%PDF-` magic check
 * (`apps/shell/lib/middleware/parsePdfGuard.ts`).
 *
 * The guard is mounted in front of a 50 MB app-wide `express.json`, as
 * `server.ts` mounts it, so a pass here also proves the cap is not defeated by
 * body-parser's "already parsed" no-op.
 */
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createParsePdfGuards,
  DEFAULT_PARSE_PDF_MAX_BYTES,
  mountPdfUploadGuards,
  parsePdfBodyLimitBytes,
  parsePdfMaxBytesFromEnv,
  PDF_UPLOAD_ROUTES,
} from '../apps/shell/lib/middleware/parsePdfGuard';
import { startTestServer, type TestServer } from './helpers/rawHttp';

/** A small limit keeps the tests fast. The logic does not depend on its size. */
const LIMIT = 2000;

let server: TestServer;
let reachedHandler = 0;

beforeAll(async () => {
  server = await startTestServer(() => {
    const app = express();
    app.post('/api/parse-pdf', ...createParsePdfGuards({ maxPdfBytes: LIMIT }));
    app.use(express.json({ limit: '50mb' }));
    app.post('/api/parse-pdf', (req, res) => {
      reachedHandler += 1;
      res.json({ reached: true, base64Length: String(req.body?.base64 ?? '').length });
    });
    return app;
  });
});
afterAll(() => server.close());

const pdfBase64 = (totalBytes: number): string =>
  Buffer.concat([Buffer.from('%PDF-1.5\n'), Buffer.alloc(Math.max(0, totalBytes - 9), 0x20)]).toString('base64');

const post = (body: unknown, opts: { chunked?: boolean } = {}) =>
  server.request({ method: 'POST', path: '/api/parse-pdf', body, ...opts });

describe('parse-pdf size limit', () => {
  it('lets a PDF under the limit through to the route', async () => {
    const before = reachedHandler;
    const res = await post({ base64: pdfBase64(500), format: 'auto' });
    expect(res.status).toBe(200);
    expect(reachedHandler).toBe(before + 1);
  });

  it('answers 413 when the decoded PDF is over the limit, without reaching the route', async () => {
    const before = reachedHandler;
    const res = await post({ base64: pdfBase64(LIMIT + 200) });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe('PDF too large');
    expect(res.json.details).toMatch(/limited to/);
    expect(reachedHandler).toBe(before);
  });

  it('answers 413 from Content-Length alone for a body far over the limit', async () => {
    const before = reachedHandler;
    const res = await post({ base64: pdfBase64(parsePdfBodyLimitBytes(LIMIT) * 3) });
    expect(res.status).toBe(413);
    expect(reachedHandler).toBe(before);
  });

  it('answers 413 for a chunked body over the limit, which declares no Content-Length', async () => {
    const before = reachedHandler;
    const res = await post({ base64: pdfBase64(parsePdfBodyLimitBytes(LIMIT) * 3) }, { chunked: true });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe('PDF too large');
    expect(reachedHandler).toBe(before);
  });

  it('refuses an over-long body from its headers, before the body is sent', async () => {
    // Declares 10 MB and sends 20 bytes. A guard that waited for the body would hang.
    const answered = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.port,
          method: 'POST',
          path: '/api/parse-pdf',
          headers: { Host: `127.0.0.1:${server.port}`, 'Content-Type': 'application/json', 'Content-Length': '10000000' },
        },
        res => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        }
      );
      req.on('error', err => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(err)));
      req.write('{"base64":"JVBERi0=');
      setTimeout(() => reject(new Error('no response while the body was still pending')), 3000);
    });
    expect(answered).toBe(413);
  });

  it('caps the whole body, not only the base64 field', async () => {
    const before = reachedHandler;
    const res = await post({ filler: 'x'.repeat(parsePdfBodyLimitBytes(LIMIT) * 3) }, { chunked: true });
    expect(res.status).toBe(413);
    expect(reachedHandler).toBe(before);
  });

  it('applies to this route only: another route keeps the app-wide limit', async () => {
    const other = await startTestServer(() => {
      const app = express();
      app.post('/api/parse-pdf', ...createParsePdfGuards({ maxPdfBytes: LIMIT }));
      app.use(express.json({ limit: '50mb' }));
      app.post('/api/other', (_req, res) => res.json({ ok: true }));
      return app;
    });
    try {
      const res = await other.request({
        method: 'POST',
        path: '/api/other',
        body: { base64: pdfBase64(LIMIT * 10) },
      });
      expect(res.status).toBe(200);
    } finally {
      await other.close();
    }
  });
});

describe('parse-pdf %PDF- magic check', () => {
  it('answers 400 when the decoded bytes are not a PDF, without reaching the route', async () => {
    const before = reachedHandler;
    const res = await post({ base64: Buffer.from('<html>not a pdf</html>').toString('base64') });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('Not a PDF');
    expect(res.json.details).toMatch(/%PDF-/);
    expect(reachedHandler).toBe(before);
  });

  it('answers 400 for a data: URL prefix instead of raw base64', async () => {
    const res = await post({ base64: `data:application/pdf;base64,${pdfBase64(200)}` });
    expect(res.status).toBe(400);
    expect(res.json.details).toMatch(/data: URL/);
  });

  it('answers 400 when the magic is present but not at the start', async () => {
    const res = await post({ base64: Buffer.from(' %PDF-1.4 body').toString('base64') });
    expect(res.status).toBe(400);
  });

  it('accepts line-wrapped base64, which Node decodes by skipping whitespace', async () => {
    const wrapped = pdfBase64(300).replace(/(.{60})/g, '$1\n');
    const res = await post({ base64: wrapped });
    expect(res.status).toBe(200);
  });

  it('accepts a real PDF from the repo fixtures', async () => {
    const file = path.join(import.meta.dirname, 'fixtures', 'nsisc_psych_sheet.pdf');
    const bytes = fs.readFileSync(file);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const big = await startTestServer(() => {
      const app = express();
      mountPdfUploadGuards(app);
      for (const route of PDF_UPLOAD_ROUTES) app.post(route, (_req, res) => res.json({ reached: true }));
      return app;
    });
    try {
      // The psych route takes the same file: this fixture is a psych sheet.
      for (const route of PDF_UPLOAD_ROUTES) {
        const res = await big.request({ method: 'POST', path: route, body: { base64: bytes.toString('base64') } });
        expect(res.status, route).toBe(200);
      }
    } finally {
      await big.close();
    }
  });

  it('leaves a missing or empty base64 to the route schema, which answers its own 400', async () => {
    const before = reachedHandler;
    expect((await post({ format: 'auto' })).status).toBe(200);
    expect((await post({ base64: '' })).status).toBe(200);
    expect(reachedHandler).toBe(before + 2);
  });
});

describe('parse-pdf limit configuration', () => {
  it('defaults to 25 MB and sizes the body limit for base64 overhead', () => {
    expect(parsePdfMaxBytesFromEnv(undefined)).toBe(DEFAULT_PARSE_PDF_MAX_BYTES);
    expect(parsePdfMaxBytesFromEnv('')).toBe(DEFAULT_PARSE_PDF_MAX_BYTES);
    expect(DEFAULT_PARSE_PDF_MAX_BYTES).toBe(25 * 1024 * 1024);
    expect(parsePdfBodyLimitBytes(3000)).toBeGreaterThanOrEqual(4000);
  });

  it('reads OMNI_PARSE_PDF_MAX_MB and rejects a value that is not a positive number', () => {
    expect(parsePdfMaxBytesFromEnv('10')).toBe(10 * 1024 * 1024);
    expect(() => parsePdfMaxBytesFromEnv('abc')).toThrow(/OMNI_PARSE_PDF_MAX_MB/);
    expect(() => parsePdfMaxBytesFromEnv('0')).toThrow(/OMNI_PARSE_PDF_MAX_MB/);
    expect(() => parsePdfMaxBytesFromEnv('-5')).toThrow(/OMNI_PARSE_PDF_MAX_MB/);
  });
});

describe.each([...PDF_UPLOAD_ROUTES])('PDF upload guard on %s, mounted as server.ts mounts it', route => {
  // One shared mount helper, in front of a 50 MB app-wide parser, then a handler
  // that records whether it was reached. The same shape server.ts builds.
  let upload: TestServer;
  let reached = 0;
  beforeAll(async () => {
    upload = await startTestServer(() => {
      const app = express();
      mountPdfUploadGuards(app, { maxPdfBytes: LIMIT });
      app.use(express.json({ limit: '50mb' }));
      for (const r of PDF_UPLOAD_ROUTES) {
        app.post(r, (_req, res) => {
          reached += 1;
          res.json({ reached: true });
        });
      }
      return app;
    });
  });
  afterAll(() => upload.close());

  const send = (body: unknown, opts: { chunked?: boolean } = {}) =>
    upload.request({ method: 'POST', path: route, body, ...opts });

  it('lets a small PDF through', async () => {
    const before = reached;
    expect((await send({ base64: pdfBase64(500), format: 'auto' })).status).toBe(200);
    expect(reached).toBe(before + 1);
  });

  it('answers 413 over the limit and never reaches the route', async () => {
    const before = reached;
    const res = await send({ base64: pdfBase64(LIMIT + 200) });
    expect(res.status).toBe(413);
    expect(res.json.code).toBe('PDF_TOO_LARGE');
    expect(reached).toBe(before);
  });

  it('answers 413 for a chunked body far over the limit, which declares no Content-Length', async () => {
    const before = reached;
    const res = await send({ base64: pdfBase64(parsePdfBodyLimitBytes(LIMIT) * 3) }, { chunked: true });
    expect(res.status).toBe(413);
    expect(reached).toBe(before);
  });

  it('answers 400 for a body that is not a PDF', async () => {
    const before = reached;
    const res = await send({ base64: Buffer.from('<html>not a pdf</html>').toString('base64') });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('NOT_A_PDF');
    expect(reached).toBe(before);
  });
});

describe('parse-pdf guard mount in server.ts', () => {
  const read = (...parts: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...parts), 'utf8');

  it('is mounted before the app-wide JSON parser', () => {
    const source = read('apps', 'shell', 'server.ts');
    const guard = source.indexOf('mountPdfUploadGuards(app,');
    const wide = source.indexOf("app.use(express.json({ limit: '50mb' }))");
    const routes = source.indexOf('registerParsingRoutes(app');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(wide);
    expect(wide).toBeLessThan(routes);
  });

  it('guards every route in parsingRoutes.ts that reads a base64 PDF schema', () => {
    const source = read('apps', 'shell', 'lib', 'routes', 'parsingRoutes.ts');
    const uploadRoutes: string[] = [];
    for (const chunk of source.split("app.post('").slice(1)) {
      const route = chunk.slice(0, chunk.indexOf("'"));
      if (/(parsePdfSchema|parsePsychPdfSchema).safeParse/.test(chunk.slice(0, 600))) uploadRoutes.push(route);
    }
    // A wrong path or a renamed schema would leave this empty and pass vacuously.
    expect(uploadRoutes.length).toBeGreaterThanOrEqual(2);
    for (const route of uploadRoutes) expect(PDF_UPLOAD_ROUTES as readonly string[]).toContain(route);
  });
});
