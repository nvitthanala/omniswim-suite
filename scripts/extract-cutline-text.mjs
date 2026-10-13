#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Archive the `pdftotext -table` text of each cut-line source PDF next to the PDF.
 *
 * ## Why
 *
 * `tests/altitudeAdjustment.test.ts` re-reads the archived NCAA PDFs with xpdf's
 * `pdftotext -table`. That flag exists only in xpdf. Poppler, which is what
 * ubuntu-latest ships, has no `-table`, so on CI those tests used to skip. The text
 * this script writes is the tool's own output, saved so the same assertions run
 * without xpdf. Nothing in it is typed by hand: the file is whatever the tool
 * printed, and the manifest records the tool, its version, the command and a sha256
 * of the file and of the PDF it came from.
 *
 * ## Usage
 *
 *   node scripts/extract-cutline-text.mjs            write the text files and the manifest fields
 *   node scripts/extract-cutline-text.mjs --check    compare the live tool's output to the files
 *
 * Needs xpdf's pdftotext (not poppler) on PATH. It refuses to run, and writes
 * nothing, when the tool is missing or rejects `-table`.
 *
 * Run it again after `scripts/fetch-cutlines.py` reports a CHANGED source: that
 * script drops the `extractedText` field of a source whose bytes changed, so a stale
 * text file cannot be kept by mistake.
 *
 * Line endings are normalised to LF. xpdf on Windows prints CRLF by default, and the
 * hash must not depend on the machine that ran the tool.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const sourcesDir = join(repoRoot, 'data', 'cutlines', 'sources');
const manifestPath = join(sourcesDir, 'manifest.json');
const check = process.argv.includes('--check');

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const lf = text => text.replace(/\r\n/g, '\n');

function die(message) {
  console.error(`extract-cutline-text: ${message}`);
  process.exit(1);
}

const version = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' });
if (version.error) die('pdftotext is not on PATH. Install the xpdf command line tools.');
const versionLine = `${version.stdout}${version.stderr}`.split(/\r?\n/).find(l => /pdftotext version/i.test(l));
if (!versionLine) die('could not read the pdftotext version from `pdftotext -v`.');
const toolVersion = versionLine.replace(/^.*version\s+/i, '').trim();

const manifestRaw = readFileSync(manifestPath, 'utf8');
const manifest = JSON.parse(manifestRaw);
// Keep the manifest's own line endings so a Windows working copy does not show a whole-file diff.
const manifestEol = manifestRaw.includes('\r\n') ? '\r\n' : '\n';
let mismatches = 0;

for (const source of manifest.sources) {
  const pdfPath = join(sourcesDir, source.filename);
  const pdfBytes = readFileSync(pdfPath);
  if (sha256(pdfBytes) !== source.sha256) {
    die(`${source.filename} does not hash to the manifest's sha256. Fix the archive first.`);
  }
  const run = spawnSync('pdftotext', ['-eol', 'unix', '-table', pdfPath, '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) {
    die(
      `\`pdftotext -table\` failed on ${source.filename}. ` +
        'Poppler has no -table flag; this needs xpdf. ' +
        (run.stderr ? `Tool said: ${run.stderr.trim().split('\n')[0]}` : ''),
    );
  }
  const text = lf(run.stdout);
  if (!/\S/.test(text)) die(`${source.filename} produced no text. It may be a scanned PDF.`);

  const textName = `${source.filename.replace(/\.pdf$/i, '')}.table.txt`;
  const textPath = join(sourcesDir, textName);

  if (check) {
    let committed;
    try {
      committed = lf(readFileSync(textPath, 'utf8'));
    } catch {
      committed = null;
    }
    if (committed !== text) {
      mismatches += 1;
      console.error(`DIFFERS  ${textName} (xpdf ${toolVersion})`);
    } else {
      console.log(`OK       ${textName}`);
    }
    continue;
  }

  const bytes = Buffer.from(text, 'utf8');
  writeFileSync(textPath, bytes);
  source.extractedText = {
    filename: textName,
    sha256: sha256(bytes),
    bytes: bytes.length,
    pdfSha256: source.sha256,
    tool: 'xpdf pdftotext',
    toolVersion,
    command: `pdftotext -eol unix -table ${source.filename} -`,
    pageSeparator: 'form feed (U+000C) after each page',
  };
  console.log(`WROTE    ${textName} ${bytes.length} bytes sha256 ${source.extractedText.sha256.slice(0, 16)}`);
}

if (check) {
  process.exit(mismatches ? 1 : 0);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2).split('\n').join(manifestEol) + manifestEol);
console.log(`Wrote ${manifestPath}`);
