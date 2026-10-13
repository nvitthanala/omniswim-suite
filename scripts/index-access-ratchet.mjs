#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Ratchet for `noUncheckedIndexedAccess`.
 *
 * The flag is not on in tsconfig.base.json yet. Turning it on at once breaks hundreds of
 * indexed reads (most of them in packages/core). This script lets the repo move toward the
 * flag one file at a time without letting the count rise again.
 *
 * What it does:
 *   1. Finds every workspace package that has a tsconfig.json (root package.json "workspaces").
 *   2. For each package, runs `tsc --noEmit -p <tsconfig>` twice: once with
 *      `--noUncheckedIndexedAccess true` and once with `--noUncheckedIndexedAccess false`.
 *   3. Keeps only the errors that appear in the first run and not in the second. Those are the
 *      errors the flag introduces. Errors that exist without the flag belong to `npm run lint:types`.
 *   4. Attributes each error to the file it points at (line + column + code is the key) and
 *      de-duplicates across packages. A package such as db compiles core through tsconfig
 *      paths, so the same core error shows up in several runs. It counts once.
 *   5. Compares per-file counts with scripts/index-access-baseline.json.
 *
 * Usage:
 *   node scripts/index-access-ratchet.mjs                    compare; exit 1 if a count rose or a
 *                                                            new file appears
 *   node scripts/index-access-ratchet.mjs --update           rewrite the baseline; refuses to
 *                                                            raise any count or add a file
 *   node scripts/index-access-ratchet.mjs --update --allow-raise
 *                                                            rewrite the baseline even if it rises
 *
 * Exit codes: 0 ok, 1 ratchet violated, 2 the script itself failed (tsc crashed, bad baseline).
 *
 * A file that reaches 0 errors is removed from the baseline. A package that sets the flag in its
 * own tsconfig reports 0 flag errors in its own files, so its files fall out of the baseline too.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus } from 'node:os';
import { join, relative } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const baselinePath = join(import.meta.dirname, 'index-access-baseline.json');
const require = createRequire(import.meta.url);
const tscBin = require.resolve('typescript/bin/tsc', { paths: [repoRoot] });

const args = new Set(process.argv.slice(2));
const unknownArgs = [...args].filter((a) => !['--update', '--allow-raise'].includes(a));
if (unknownArgs.length > 0) {
  console.error(`Unknown argument: ${unknownArgs.join(' ')}`);
  process.exit(2);
}
const update = args.has('--update');
const allowRaise = args.has('--allow-raise');
if (allowRaise && !update) {
  console.error('--allow-raise only makes sense with --update.');
  process.exit(2);
}

/** Workspace package directories (relative, forward slashes) that own a tsconfig.json. */
function discoverTsconfigs() {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const found = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (!pattern.endsWith('/*')) {
      throw new Error(`Unsupported workspace pattern "${pattern}"; expected "<dir>/*".`);
    }
    const base = pattern.slice(0, -2);
    const baseDir = join(repoRoot, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const tsconfig = join(baseDir, entry.name, 'tsconfig.json');
      if (existsSync(tsconfig)) found.push(`${base}/${entry.name}/tsconfig.json`);
    }
  }
  return found.sort();
}

/** Run tsc once. Resolves with the parsed error list. Rejects when tsc fails without diagnostics. */
function runTsc(tsconfig, flagValue) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tscBin,
        '--noEmit',
        '--pretty',
        'false',
        '--noUncheckedIndexedAccess',
        String(flagValue),
        '-p',
        tsconfig,
      ],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const errors = [];
      // tsc can report two errors at one position with one code (for example two bad
      // arguments in one expression). Number repeats so each one counts.
      const seen = new Map();
      for (const line of out.split(/\r?\n/)) {
        const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
        if (!m) continue;
        const file = m[1].replace(/\\/g, '/');
        const base = `${file}:${m[2]}:${m[3]}:${m[4]}:${m[5]}`;
        const ordinal = (seen.get(base) ?? 0) + 1;
        seen.set(base, ordinal);
        errors.push({ file, key: `${base}#${ordinal}` });
      }
      // tsc exits 2 when it reported diagnostics. Any other non-zero exit with no parsed
      // diagnostic means tsc itself failed (bad tsconfig, crash). Do not read that as "0 errors".
      if (code !== 0 && errors.length === 0) {
        reject(
          new Error(
            `tsc exited ${code} for ${tsconfig} (flag=${flagValue}) with no parsable diagnostics.\n${out}${err}`,
          ),
        );
        return;
      }
      resolve(errors);
    });
  });
}

/** Run async tasks with a concurrency cap. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function readBaseline() {
  if (!existsSync(baselinePath)) return null;
  const parsed = JSON.parse(readFileSync(baselinePath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.files !== 'object') {
    throw new Error(`${baselinePath} is not a baseline file (missing "files").`);
  }
  return parsed.files;
}

function sortedObject(obj) {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function topDir(file) {
  const parts = file.split('/');
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : file;
}

async function measure() {
  const tsconfigs = discoverTsconfigs();
  if (tsconfigs.length === 0) throw new Error('No workspace tsconfig.json found.');
  const jobs = tsconfigs.flatMap((t) => [
    { tsconfig: t, flag: true },
    { tsconfig: t, flag: false },
  ]);
  const limit = Math.max(1, Math.min(4, cpus().length));
  const results = await mapLimit(jobs, limit, (j) => runTsc(j.tsconfig, j.flag));

  const introduced = new Map(); // key -> file
  for (let i = 0; i < tsconfigs.length; i++) {
    const withFlag = results[i * 2];
    const withoutFlag = new Set(results[i * 2 + 1].map((e) => e.key));
    for (const e of withFlag) {
      if (!withoutFlag.has(e.key)) introduced.set(e.key, e.file);
    }
  }
  const counts = {};
  for (const file of introduced.values()) counts[file] = (counts[file] ?? 0) + 1;
  return { tsconfigs, counts: sortedObject(counts) };
}

function summarize(counts) {
  const byDir = {};
  for (const [file, n] of Object.entries(counts)) byDir[topDir(file)] = (byDir[topDir(file)] ?? 0) + n;
  return sortedObject(byDir);
}

function diff(baseline, current) {
  const raised = []; // { file, was, now }
  const added = []; // { file, now }
  const lowered = []; // { file, was, now }
  const files = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const file of [...files].sort()) {
    const was = baseline[file];
    const now = current[file] ?? 0;
    if (was === undefined) added.push({ file, now });
    else if (now > was) raised.push({ file, was, now });
    else if (now < was) lowered.push({ file, was, now });
  }
  return { raised, added, lowered };
}

function writeBaseline(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const body = {
    description:
      'Per-file count of errors that --noUncheckedIndexedAccess introduces. Written by ' +
      'scripts/index-access-ratchet.mjs --update. Counts may only fall.',
    total,
    byDirectory: summarize(counts),
    files: counts,
  };
  writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`);
}

try {
  const { tsconfigs, counts } = await measure();
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const baseline = readBaseline();

  if (update) {
    if (baseline !== null && !allowRaise) {
      const d = diff(baseline, counts);
      if (d.raised.length > 0 || d.added.length > 0) {
        console.error('Refusing to update: the count rose. Fix these or pass --allow-raise.');
        for (const r of d.raised) console.error(`  ${r.file}: ${r.was} -> ${r.now}`);
        for (const a of d.added) console.error(`  ${a.file}: new, ${a.now}`);
        process.exit(1);
      }
    }
    writeBaseline(counts);
    console.log(
      `Baseline written: ${total} error(s) in ${Object.keys(counts).length} file(s) ` +
        `across ${tsconfigs.length} package(s).`,
    );
    for (const [dir, n] of Object.entries(summarize(counts))) console.log(`  ${dir}: ${n}`);
    process.exit(0);
  }

  if (baseline === null) {
    console.error(
      `No baseline at ${relative(repoRoot, baselinePath)}. Run with --update to create it.`,
    );
    process.exit(2);
  }

  const d = diff(baseline, counts);
  if (d.raised.length > 0 || d.added.length > 0) {
    console.error('noUncheckedIndexedAccess ratchet failed. These files have more errors than the baseline:');
    for (const r of d.raised) console.error(`  ${r.file}: ${r.was} -> ${r.now}`);
    for (const a of d.added) console.error(`  ${a.file}: not in baseline, ${a.now} error(s)`);
    console.error(
      'Fix the new indexed reads (narrow, guard or throw; no `?? 0`, no `!` without a proven bound). ' +
        'Run `npx tsc --noEmit --noUncheckedIndexedAccess -p <package>/tsconfig.json` to see them.',
    );
    process.exit(1);
  }

  console.log(`noUncheckedIndexedAccess ratchet ok: ${total} error(s), baseline allows more or equal.`);
  if (d.lowered.length > 0) {
    console.log('Counts fell. Run `npm run lint:index-access -- --update` to lock them in:');
    for (const l of d.lowered) console.log(`  ${l.file}: ${l.was} -> ${l.now}`);
  }
  process.exit(0);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
