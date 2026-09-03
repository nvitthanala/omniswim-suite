/** @license SPDX-License-Identifier: Apache-2.0 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const harness = `
import json, os, sys, tempfile
sys.path.insert(0, 'backend')
import point_calculator
with tempfile.TemporaryDirectory() as directory:
    with open(os.path.join(directory, 'scoring_settings.json'), 'w', encoding='utf-8') as f:
        f.write('{ not valid JSON')
    os.environ['OMNI_DATA_DIR'] = directory
    try:
        point_calculator._resolve_scoring_settings()
    except json.JSONDecodeError:
        print('raised')
    else:
        raise AssertionError('corrupt scoring settings silently used defaults')
`;
const run = spawnSync('python', ['-c', harness], { cwd: repoRoot, encoding: 'utf8' });
assert.equal(run.status, 0, `python harness failed:\n${run.stderr}`);
assert.equal(run.stdout.trim(), 'raised');
console.log('PASS  corrupt scoring settings raise instead of using NCAA-D2 defaults');
