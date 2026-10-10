/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Access to the two workspace stores a test script may read, and the one rule
 * that goes with them.
 *
 *   data/meets.json      LOCAL ONLY. The live working store. It holds real roster
 *                        data, so it is untracked and never committed or copied
 *                        into a fixture. A clean checkout and CI do not have it.
 *   data/demo-seed.json  COMMITTED. Small, invented, labelled "not real results".
 *
 * ## The rule
 *
 * A check that needs `meets.json` runs only when it exists. When it does not,
 * the script prints a `LOCAL-ONLY SKIPPED` line that names the part it skipped,
 * and every check that needs nothing local still runs. The script is never
 * skipped whole just because one section needs the local store.
 *
 * `scripts/run-tests.mjs` counts those lines and shows them next to the PASS,
 * so a skipped section cannot hide inside a green run.
 *
 * What this helper must NOT do: stand in a made-up value for the missing file.
 * `loadLocalMeets()` returns `null` when the file is absent. It does not return
 * an empty list, because "no local data" and "no workspaces" are different facts
 * and a check that reads one as the other passes without checking anything.
 * A file that exists but does not parse still throws.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MEETS_PATH = join(REPO_ROOT, 'data', 'meets.json');
export const DEMO_SEED_PATH = join(REPO_ROOT, 'data', 'demo-seed.json');

/** True when the local working store is present on this machine. */
export function hasLocalMeets() {
  return existsSync(MEETS_PATH);
}

/** The parsed `data/meets.json`, or `null` when the file is absent. Throws if it exists but is not valid JSON. */
export function loadLocalMeets() {
  if (!hasLocalMeets()) return null;
  return JSON.parse(readFileSync(MEETS_PATH, 'utf8'));
}

/**
 * The committed demo workspaces. Throws when the file is missing or empty: it is
 * tracked, so its absence is a broken checkout, not a reason to skip.
 */
export function loadDemoSeed() {
  const seed = JSON.parse(readFileSync(DEMO_SEED_PATH, 'utf8'));
  if (!Array.isArray(seed) || seed.length === 0) {
    throw new Error('data/demo-seed.json must hold at least one workspace');
  }
  return seed;
}

/**
 * Say which part of which script did not run, and why. Always call this on the
 * branch that skips a local-only section. The runner looks for the
 * `LOCAL-ONLY SKIPPED` prefix. Do not start a script's output with `SKIP`:
 * the runner reads a leading `SKIP` as "the whole script skipped itself".
 */
export function noteLocalOnlySkipped(script, part) {
  console.log(`LOCAL-ONLY SKIPPED  ${script}: ${part} (needs data/meets.json, which is untracked and absent here)`);
}
