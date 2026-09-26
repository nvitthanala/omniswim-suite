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

  app.get('/api/cutlines/:version?', (req, res) => {
    const version = req.params.version || defaultCutlineVersion();
    const safe = version.replace(/[^0-9a-zA-Z._-]/g, '');
    const filePath = path.join(CUTLINES_DIR, `${safe}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return res.json({ version: safe, cutlines: Array.isArray(data) ? data : data.cutlines ?? [] });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to read cutlines version', details: String(err) });
      }
    }
    // Last resort: serve the compiled-in table. Core now loads from these same
    // JSON files, so this only helps if the data dir is missing entirely.
    if (safe === defaultCutlineVersion()) {
      return res.json({ version: safe, cutlines: builtinCutlines });
    }
    return res.status(404).json({ error: `Cutline version not found: ${safe}` });
  });
}
