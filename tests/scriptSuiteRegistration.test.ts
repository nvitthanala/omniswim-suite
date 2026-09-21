/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every `scripts/test_*.mjs` must either run in `scripts/run-tests.mjs` or say
 * out loud why it does not.
 *
 * ## Why this is worth a test of its own
 *
 * A test script that no runner invokes is worse than no test: it reads as
 * coverage in a directory listing and in a commit message, and it fails
 * nowhere. This repo has been bitten three times.
 *
 *   - `scripts/test_scoring_preset_routes.mjs` passed standalone and was
 *     registered in no runner, so it never ran (recorded 2026-09-20).
 *   - `scripts/test_roster_catalog.mjs` and `scripts/test_eligibility_toggle.mjs`
 *     shipped with commit 63321628 and were likewise never registered. Both
 *     crashed on the first line of the product code they exercise
 *     (`JsonRosterCatalog.init` called `existsSync`, which that module had
 *     bound to `fs.promises` -- an object, not a function). The crash sat in
 *     the tree for two months because the only two things that would have
 *     caught it were unregistered.
 *
 * `console.assert` has the same shape and already has a backstop in
 * `run-tests.mjs` (INVARIANTS item 8). This is the backstop for the other half:
 * a real assertion nobody runs.
 *
 * ## The escape hatch
 *
 * Three scripts in `scripts/` are named `test_*` but are not suite tests: they
 * need a PDF that is not in the repo, a live server on port 3000, or the Python
 * backend. They are listed below WITH A REASON. Adding a name here is a
 * deliberate, reviewable act; forgetting to register a real test is not.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDir = path.join(repoRoot, 'scripts');

/**
 * Scripts named `test_*` that deliberately do not run in the suite, each with
 * the reason it cannot. A name may only be added here with a reason.
 */
const NOT_SUITE_TESTS: Record<string, string> = {
  'test_post.mjs':
    'manual probe: needs 2026_NSISC_Championships_Final_Results.pdf in the cwd and a server on port 3000',
  'test_acc_post.mjs':
    'manual probe: needs 2026_acc_championship_full_meet_results_1col.pdf in the cwd and a server on port 3000',
  'test_conference_pdfs.mjs':
    'manual probe: needs the Python venv backend and four conference PDFs that are not in the repo',
};

function scriptTestFiles(): string[] {
  return readdirSync(scriptsDir)
    .filter(f => f.startsWith('test_') && f.endsWith('.mjs'))
    .sort();
}

function registeredNames(): Set<string> {
  const runner = readFileSync(path.join(scriptsDir, 'run-tests.mjs'), 'utf-8');
  return new Set(runner.match(/test_[a-zA-Z0-9_]+\.mjs/g) ?? []);
}

describe('script suite registration', () => {
  it('runs every test_*.mjs in scripts/, or declares why it cannot', () => {
    const registered = registeredNames();
    const unaccounted = scriptTestFiles().filter(
      f => !registered.has(f) && !(f in NOT_SUITE_TESTS)
    );
    expect(unaccounted, 'add to scripts/run-tests.mjs TESTS, or to NOT_SUITE_TESTS with a reason').toEqual([]);
  });

  it('does not excuse a script that is actually registered', () => {
    const registered = registeredNames();
    const bothWays = Object.keys(NOT_SUITE_TESTS).filter(f => registered.has(f));
    expect(bothWays, 'listed as not-a-suite-test but registered in run-tests.mjs').toEqual([]);
  });

  it('does not register a script that is not on disk', () => {
    const onDisk = new Set(scriptTestFiles());
    const missing = [...registeredNames()].filter(f => !onDisk.has(f));
    expect(missing, 'run-tests.mjs names a script that does not exist').toEqual([]);
  });

  it('only excuses scripts that exist', () => {
    const onDisk = new Set(scriptTestFiles());
    const stale = Object.keys(NOT_SUITE_TESTS).filter(f => !onDisk.has(f));
    expect(stale, 'NOT_SUITE_TESTS names a script that no longer exists').toEqual([]);
  });
});
