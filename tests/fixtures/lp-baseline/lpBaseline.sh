#!/usr/bin/env bash
# No-flag LP baseline for the AutoBuilder (slice A9 and after).
#
# Each file next to this script (`engineAutoBuild*`) lists one line per `buildLp` call that the matching
# `tests/engineAutoBuild*.test.ts` makes, in call order: `<first 16 hex of sha256(LP text)> <LP text length>`.
# A later slice that must not change any LP text runs `bash tests/fixtures/lp-baseline/lpBaseline.sh check`.
# It copies each test file to `tests/_gold_*.test.ts` with a `buildLp` spy, runs the copies, compares, and removes the copies.
#
#   check   (default)  compare the current code with the stored baseline; exit 1 on any difference
#   update             overwrite the stored baseline with the current code (do this only when an LP text change is intended)
#
# The lines depend on the test files: adding or removing a test that calls `buildLp` changes them. Re-run `update` in the
# same commit as such a test change, and say so.
set -u
cd "$(dirname "$0")/../../.."
BASE="tests/fixtures/lp-baseline"
NAMES="engineAutoBuild engineAutoBuildRelay engineAutoBuildLoad engineAutoBuildModes engineAutoBuildRobust"
MODE="${1:-check}"
OUT="$(mktemp -d)"
# Remove only the copies this run makes, never another file that matches the pattern.
trap 'for n in $NAMES; do rm -f "tests/_gold_$n.test.ts"; done; rm -rf "$OUT"' EXIT

node - <<'JS'
const fs = require('node:fs');
const mock = `
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
vi.mock('../packages/engine/src/autobuilder/lp', async (importOriginal) => {
  const real = await importOriginal<typeof import('../packages/engine/src/autobuilder/lp')>();
  return {
    ...real,
    buildLp: (...args: Parameters<typeof real.buildLp>) => {
      const b = real.buildLp(...args);
      if (process.env.GOLD_OUT) appendFileSync(process.env.GOLD_OUT, createHash('sha256').update(b.text).digest('hex').slice(0, 16) + ' ' + b.text.length + String.fromCharCode(10));
      return b;
    },
  };
});
`;
for (const n of 'engineAutoBuild engineAutoBuildRelay engineAutoBuildLoad engineAutoBuildModes engineAutoBuildRobust'.split(' ')) {
  const src = fs.readFileSync(`tests/${n}.test.ts`, 'utf8');
  const out = src.replace(/import \{ describe, expect, it(, vi)? \} from 'vitest';/, (m) => "import { describe, expect, it, vi } from 'vitest';" + mock);
  if (out === src) throw new Error(`${n}: the vitest import line did not match`);
  fs.writeFileSync(`tests/_gold_${n}.test.ts`, out);
}
JS

status=0
for n in $NAMES; do
  GOLD_OUT="$OUT/$n" SKIP_BUDGET_ENV=local npx vitest run "tests/_gold_$n.test.ts" --maxWorkers=2 > "$OUT/$n.log" 2>&1 || { echo "$n: the test run failed"; tail -20 "$OUT/$n.log"; status=1; continue; }
  if [ "$MODE" = "update" ]; then
    cp "$OUT/$n" "$BASE/$n" && echo "$n: baseline updated ($(wc -l < "$BASE/$n") lines)"
  elif cmp -s "$OUT/$n" "$BASE/$n"; then
    echo "$n: identical"
  else
    echo "$n: DIFFERENT"; status=1
  fi
done
exit $status
