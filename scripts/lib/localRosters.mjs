/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Where the local-only roster text files live, in one place.
 *
 * The roster exports (`hsuroster26-27.txt`, `oburoster202627.txt`,
 * `possible_hsu_scoringteam2627.txt`, `NSISC_2026-27_ROSTER_FRAMEWORK.txt`)
 * name real swimmers. They are untracked and gitignored. Put them in
 * `data/local-rosters/` (see docs/ONBOARDING.md, section 5).
 *
 * ## The rules
 *
 * - A seed script needs the real file. `requireLocalRoster` throws and names
 *   the docs page when the file is absent. A seed never falls back to
 *   invented text: that would write made-up swims into a workspace.
 * - A test may fall back to the invented stand-in in
 *   `tests/fixtures/synthetic-rosters/` (see `tests/helpers/localRosterPath.ts`).
 *   `localRosterPath` and `hasLocalRoster` never invent a value.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The one local-only directory for roster text files. */
export const LOCAL_ROSTER_DIR = join(REPO_ROOT, 'data', 'local-rosters');
/** The committed stand-ins, same file names, invented names. */
export const SYNTHETIC_ROSTER_DIR = join(REPO_ROOT, 'tests', 'fixtures', 'synthetic-rosters');

/** Absolute path of a local roster file. It may not exist. */
export function localRosterPath(fileName) {
  return join(LOCAL_ROSTER_DIR, fileName);
}

/** True when this machine holds the local roster file. */
export function hasLocalRoster(fileName) {
  return existsSync(localRosterPath(fileName));
}

/** The path of a local roster file, or a thrown error that says where to put it. */
export function requireLocalRoster(fileName) {
  const p = localRosterPath(fileName);
  if (!existsSync(p)) {
    throw new Error(
      `Missing local roster file ${fileName}. Put it in data/local-rosters/ ` +
        '(gitignored; see docs/ONBOARDING.md, section 5). This script does not fall back to invented text.'
    );
  }
  return p;
}
