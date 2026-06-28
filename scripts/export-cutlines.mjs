/**
 * Export the built-in cutline dataset to data/cutlines/<version>.json so it can
 * be versioned and hot-reloaded/overridden without rebuilding.
 * Run: npx tsx scripts/export-cutlines.mjs [version]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cutlines } from '../packages/core/src/cutlines.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CUTLINES_DIR = path.join(__dirname, '..', 'data', 'cutlines');
const version = process.argv[2] || '2025-2026';

fs.mkdirSync(CUTLINES_DIR, { recursive: true });
const outFile = path.join(CUTLINES_DIR, `${version}.json`);
fs.writeFileSync(outFile, JSON.stringify(cutlines, null, 2), 'utf-8');

const indexFile = path.join(CUTLINES_DIR, 'index.json');
const existing = fs.existsSync(indexFile)
  ? JSON.parse(fs.readFileSync(indexFile, 'utf-8'))
  : { versions: [] };
const versions = new Set(existing.versions ?? []);
versions.add(version);
fs.writeFileSync(
  indexFile,
  JSON.stringify(
    {
      description:
        'Versioned NCAA cutline tables. Each <version>.json is an array of CutlineRecord. The server serves these via GET /api/cutlines/:version with hot-reload.',
      default: version,
      versions: [...versions].sort().reverse(),
      updatedAt: new Date().toISOString(),
    },
    null,
    2
  ),
  'utf-8'
);

console.log(`Wrote ${cutlines.length} cutline rows → ${outFile}`);
console.log(`Updated ${indexFile}`);
