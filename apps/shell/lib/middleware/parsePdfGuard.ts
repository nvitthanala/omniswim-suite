/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Size and format guard for `POST /api/parse-pdf` (improvement plan, section 4
 * note "limit /api/parse-pdf size and check the %PDF- magic").
 *
 * The app-wide `express.json` limit is 50 MB, which the server then writes to a
 * temp file and hands to a Python subprocess. This guard puts a tighter, route-
 * specific cap in front of that and refuses a payload that is not a PDF before
 * any file is written.
 *
 * ## Mount order is load-bearing
 *
 * body-parser does nothing once `req.body` is set. These handlers carry their own
 * route-scoped `express.json`, so they must be mounted BEFORE the app-wide parser.
 * Mounted after it, the 50 MB parse has already happened and the cap protects
 * nothing. `server.ts` mounts them first, and `tests/parsePdfGuard.test.ts` mounts
 * them in front of a 50 MB global parser to prove the cap still holds.
 *
 * ## Status codes
 *
 * - 413: the body or the decoded PDF is over the limit.
 * - 400: `base64` decodes to bytes that do not start with `%PDF-`.
 * - A body with no usable `base64` string passes through untouched, so the
 *   route's own schema check keeps producing its existing 400.
 */
import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';

/** Largest decoded PDF accepted. Real meet-results PDFs are well under 5 MB; this is generous. */
export const DEFAULT_PARSE_PDF_MAX_BYTES = 25 * 1024 * 1024;
/** Room for the JSON envelope (`{"base64":"...","format":"..."}`) around the base64 text. */
const ENVELOPE_SLACK_BYTES = 4096;
const PDF_MAGIC = '%PDF-';

/** Largest request body that can still hold a PDF of `maxPdfBytes`: base64 is 4/3 the size. */
export function parsePdfBodyLimitBytes(maxPdfBytes: number): number {
  return Math.ceil((maxPdfBytes * 4) / 3) + ENVELOPE_SLACK_BYTES;
}

/**
 * Read `OMNI_PARSE_PDF_MAX_MB`. Unset gives the default. A value that is not a
 * positive number throws, because a silently ignored limit reads as "enforced".
 */
export function parsePdfMaxBytesFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PARSE_PDF_MAX_BYTES;
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    throw new Error(`OMNI_PARSE_PDF_MAX_MB must be a positive number of megabytes, got ${JSON.stringify(raw)}.`);
  }
  return Math.floor(megabytes * 1024 * 1024);
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export interface ParsePdfGuardOptions {
  /** Largest decoded PDF, in bytes. Defaults to {@link DEFAULT_PARSE_PDF_MAX_BYTES}. */
  readonly maxPdfBytes?: number;
}

/**
 * Handlers for `app.post('/api/parse-pdf', ...createParsePdfGuards())`, in order:
 * Content-Length check, route-scoped JSON parse, parse-error translation, then the
 * decoded-size and magic-byte check.
 */
export function createParsePdfGuards(
  options: ParsePdfGuardOptions = {}
): Array<RequestHandler | ErrorRequestHandler> {
  const maxPdfBytes = options.maxPdfBytes ?? DEFAULT_PARSE_PDF_MAX_BYTES;
  const bodyLimit = parsePdfBodyLimitBytes(maxPdfBytes);

  const tooLarge = (res: Parameters<RequestHandler>[1]): void => {
    res.status(413).json({
      error: 'PDF too large',
      details: `The PDF upload is limited to ${megabytes(maxPdfBytes)}. Split the file or remove pages and try again.`,
    });
  };

  const declaredLength: RequestHandler = (req, res, next) => {
    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > bodyLimit) {
      tooLarge(res);
      return;
    }
    next();
  };

  const parseErrors: ErrorRequestHandler = (err, _req, res, next) => {
    if ((err as { type?: unknown } | null)?.type === 'entity.too.large') {
      tooLarge(res);
      return;
    }
    next(err);
  };

  const checkPayload: RequestHandler = (req, res, next) => {
    const body: unknown = req.body;
    const base64 =
      typeof body === 'object' && body !== null ? (body as { base64?: unknown }).base64 : undefined;
    if (typeof base64 !== 'string' || base64.length === 0) {
      next();
      return;
    }
    // Decoded size from the text length. Whitespace in the text makes this a slight
    // over-estimate, which errs toward refusing a file right at the limit.
    if ((base64.length * 3) / 4 > maxPdfBytes) {
      tooLarge(res);
      return;
    }
    // Decode only the head: the magic is in the first bytes and the route decodes the rest.
    const head = Buffer.from(base64.slice(0, 256).replace(/\s+/g, '').slice(0, 16), 'base64');
    if (head.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) {
      res.status(400).json({
        error: 'Not a PDF',
        details: `The upload does not start with ${PDF_MAGIC}. Send the raw PDF file as base64, without a data: URL prefix.`,
      });
      return;
    }
    next();
  };

  return [declaredLength, express.json({ limit: bodyLimit }), parseErrors, checkPayload];
}
