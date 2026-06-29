/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Psych sheet layout auto-detect: NSISC fixture is two-column (divided).
 * Verifies divided beats regular and yields clean event names / distance seeds.
 *
 * Usage: node --import tsx scripts/test_nsisc_psych.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  badDistanceSeedCount,
  corruptPsychEventCount,
  normalizePsychAthleteRows,
  pickBestPsychParseCandidate,
  psychParseFormatsToTry,
  scorePsychParseQuality,
} from '../packages/core/src/lib/psychParseQuality.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const fixture = path.join(root, 'tests', 'fixtures', 'nsisc_psych_sheet.pdf');

function resolvePython() {
  const win = process.platform === 'win32';
  const venv = win
    ? path.join(root, 'venv', 'Scripts', 'python.exe')
    : path.join(root, 'venv', 'bin', 'python3');
  return fs.existsSync(venv) ? venv : win ? 'python' : 'python3';
}

function runPdfParser(pdfPath, format) {
  const py = resolvePython();
  const parser = path.join(root, 'backend', 'pdf_parser.py');
  const out = execFileSync(py, [parser, pdfPath, format], {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.trim());
  if (!Array.isArray(parsed)) {
    throw new Error(`pdf_parser ${format}: unexpected JSON`);
  }
  return parsed;
}

function runPsychParser(pdfPath, format) {
  const py = resolvePython();
  const script = path.join(root, 'backend', 'psych_parser.py');
  const out = execFileSync(py, [script, pdfPath, format], {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsed = JSON.parse(out.trim());
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

if (!fs.existsSync(fixture)) {
  console.log('SKIP nsisc psych — fixture missing (tests/fixtures/nsisc_psych_sheet.pdf)');
  process.exit(0);
}

// --- TypeScript quality path (mirrors server parsePsychPdfFile) ---
const candidates = [];
for (const fmt of psychParseFormatsToTry('auto')) {
  const raw = runPdfParser(fixture, fmt);
  candidates.push({ format: fmt, normalized: normalizePsychAthleteRows(raw) });
}
const best = pickBestPsychParseCandidate(candidates);
if (!best) {
  console.error('FAIL: no psych parse candidate');
  process.exit(1);
}

const regular = candidates.find(c => c.format === 'regular')?.normalized ?? [];
const divided = candidates.find(c => c.format === 'divided')?.normalized ?? [];

if (scorePsychParseQuality(divided) <= scorePsychParseQuality(regular)) {
  console.error('FAIL: divided layout should score higher than regular on NSISC psych', {
    divided: scorePsychParseQuality(divided),
    regular: scorePsychParseQuality(regular),
  });
  process.exit(1);
}

if (best.format !== 'divided') {
  console.error('FAIL: auto-detect should pick divided for NSISC psych, got', best.format);
  process.exit(1);
}

if (best.normalized.length < 450) {
  console.error('FAIL: expected ≥450 psych rows, got', best.normalized.length);
  process.exit(1);
}

const corrupt = corruptPsychEventCount(best.normalized);
if (corrupt > 0) {
  console.error('FAIL: corrupt event names:', corrupt);
  process.exit(1);
}

const badDist = badDistanceSeedCount(best.normalized);
if (badDist > 0) {
  console.error('FAIL: implausible distance seed times:', badDist);
  process.exit(1);
}

// --- Python psych_parser.py path (fallback used by server) ---
const pyResult = runPsychParser(fixture, 'auto');
if (pyResult.format_used !== 'divided') {
  console.error('FAIL: psych_parser.py should use divided, got', pyResult.format_used);
  process.exit(1);
}
if (!Array.isArray(pyResult.results) || pyResult.results.length < 450) {
  console.error('FAIL: psych_parser.py row count', pyResult.results?.length);
  process.exit(1);
}

// One-column psych: when divided parse is corrupt, regular should win.
const synthCandidates = [
  {
    format: 'divided',
    normalized: normalizePsychAthleteRows([
      {
        event: 'Event 1 Men 1000 Yard Freestyle FR 5:00.00 merged junk',
        time: '1:30.00',
        name: 'Bad',
        team: 'T',
        is_relay: false,
      },
    ]),
  },
  {
    format: 'regular',
    normalized: normalizePsychAthleteRows([
      {
        event: 'Event 1 Men 1000 Yard Freestyle',
        time: '9:30.00',
        name: 'Good',
        team: 'T',
        is_relay: false,
      },
    ]),
  },
];
const synthBest = pickBestPsychParseCandidate(synthCandidates);
if (!synthBest || synthBest.format !== 'regular') {
  console.error('FAIL: one-column psych should prefer regular when divided is corrupt');
  process.exit(1);
}

console.log(
  `OK nsisc psych: ${best.normalized.length} rows, format=${best.format}, corrupt=0, badDistance=0`
);
