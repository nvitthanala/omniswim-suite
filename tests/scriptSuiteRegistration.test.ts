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
 * `scripts/run-tests.mjs` now enforces this itself and fails before it spawns
 * anything. A script that cannot run unattended either lives in
 * `scripts/probes/` (manual probes: they need a PDF that is not in the repo or a
 * live server on port 3000) or is named in the runner's `EXCLUDED` map with a
 * reason. This test is the same check inside `vitest run`.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptsDirs = [path.join(repoRoot, 'scripts'), path.join(repoRoot, 'legacy', 'scripts')];

function scriptTestFiles(): string[] {
  return scriptsDirs.flatMap(dir => readdirSync(dir)
    .filter(f => f.startsWith('test_') && f.endsWith('.mjs')))
    .sort();
}

function registeredNames(): Set<string> {
  const runners = scriptsDirs.map((dir, i) => readFileSync(path.join(dir, i === 0 ? 'run-tests.mjs' : 'run-tests.mjs'), 'utf-8'));
  return new Set(runners.flatMap(runner => runner.match(/test_[a-zA-Z0-9_]+\.mjs/g) ?? []));
}

describe('script suite registration', () => {
  it('runs every test_*.mjs in the active or legacy scripts folder, or declares why it cannot', () => {
    const registered = registeredNames();
    const unaccounted = scriptTestFiles().filter(f => !registered.has(f));
    expect(unaccounted, 'add the script to its runner TESTS list, or to that runner EXCLUDED map').toEqual([]);
  });

  it('does not register a script that is not on disk', () => {
    const onDisk = new Set(scriptTestFiles());
    const missing = [...registeredNames()].filter(f => !onDisk.has(f));
    expect(missing, 'run-tests.mjs names a script that does not exist').toEqual([]);
  });
});
