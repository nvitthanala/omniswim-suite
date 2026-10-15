/**
 * Versioned cutline tables. The built-in dataset (compiled from core) is the
 * default version; additional/override versions hot-reload from
 * `data/cutlines/*.json`.
 *
 * Extracted from `server.ts`'s `startServer` (H2, code-health refactor,
 * 2026-09-25) with no behavior change.
 */
import type { Express } from 'express';
import fs from 'fs';
import path from 'path';
import { apiError } from '../middleware/apiError.ts';

export interface CutlineRoutesDeps {
  cutlinesDir: string;
  fallbackCutlineVersion: string;
  builtinCutlines: unknown;
}

export function registerCutlineRoutes(app: Express, deps: CutlineRoutesDeps): void {
  const { cutlinesDir: CUTLINES_DIR, fallbackCutlineVersion: FALLBACK_CUTLINE_VERSION, builtinCutlines } = deps;

  function listCutlineVersions(): string[] {
    const versions = new Set<string>([defaultCutlineVersion()]);
    if (fs.existsSync(CUTLINES_DIR)) {
      for (const f of fs.readdirSync(CUTLINES_DIR)) {
        if (f.endsWith('.json') && f !== 'index.json') versions.add(f.replace(/\.json$/, ''));
      }
    }
    return [...versions].sort().reverse();
  }

  /** Read the generated index each call so a re-extract is picked up without a restart. */
  function defaultCutlineVersion(): string {
    const indexFile = path.join(CUTLINES_DIR, 'index.json');
    if (fs.existsSync(indexFile)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        if (typeof idx?.default === 'string' && idx.default) return idx.default;
      } catch {
        // Fall through to the constant — a malformed index must not take the API down.
      }
    }
    return FALLBACK_CUTLINE_VERSION;
  }

  app.get('/api/cutlines/versions', (_req, res) => {
    res.json({ versions: listCutlineVersions(), default: defaultCutlineVersion() });
  });

  // path-to-regexp 8 (Express 5) dropped `:version?`; `{/:version}` is the optional segment.
  app.get('/api/cutlines{/:version}', (req, res) => {
    const version = req.params.version || defaultCutlineVersion();
    const safe = version.replace(/[^0-9a-zA-Z._-]/g, '');
    const filePath = path.join(CUTLINES_DIR, `${safe}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const cutlines = Array.isArray(data) ? data : data?.cutlines;
        // A file with no `cutlines` array is a broken table, not an empty one: answering
        // 200 with [] reads as "no standards published", which is the silent-empty failure.
        if (!Array.isArray(cutlines)) {
          return apiError(
            res,
            500,
            'CUTLINES_MALFORMED',
            'Failed to read cutlines version',
            `${safe}.json has no "cutlines" array`
          );
        }
        return res.json({ version: safe, cutlines });
      } catch (err) {
        return apiError(res, 500, 'CUTLINES_READ_FAILED', 'Failed to read cutlines version', String(err));
      }
    }
    // Last resort: serve the compiled-in table. Core now loads from these same
    // JSON files, so this only helps if the data dir is missing entirely.
    if (safe === defaultCutlineVersion()) {
      return res.json({ version: safe, cutlines: builtinCutlines });
    }
    return apiError(res, 404, 'CUTLINE_VERSION_NOT_FOUND', `Cutline version not found: ${safe}`);
  });
}
