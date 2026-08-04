/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * RETIRED 2026-07-26.
 *
 * This script used to write `data/cutlines/<version>.json` from the hand-authored
 * `cutlines` array in packages/core. That direction is now backwards and
 * destructive: `data/cutlines/*.json` is the generated source of truth, produced
 * from the archived PDFs under `data/cutlines/sources/`, and
 * `packages/core/src/cutlines.ts` is a thin typed loader over it. Running the old
 * export would overwrite provenance-carrying published data with a flattened,
 * lossy view of itself.
 *
 * Use instead:
 *
 *     python scripts/fetch-cutlines.py      # archive the published PDFs + manifest
 *     python scripts/extract-cutlines.py    # parse them into data/cutlines/*.json
 *
 * See the "Data provenance" section of CLAUDE.md.
 */
console.error(
  [
    'scripts/export-cutlines.mjs is retired and does nothing.',
    '',
    'data/cutlines/*.json is now generated from the archived PDFs, not from TypeScript.',
    'Regenerate it with:',
    '',
    '  python scripts/fetch-cutlines.py',
    '  python scripts/extract-cutlines.py',
    '',
  ].join('\n')
);
process.exit(1);
