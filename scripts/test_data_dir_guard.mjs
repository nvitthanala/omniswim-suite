/**
 * Guard test for scripts/lib/dataDir.mjs and the scripts that use it
 * (migrate-json-to-sqlite). Run: npx tsx scripts/test_data_dir_guard.mjs
 *
 * Proves: OMNI_DATA_DIR is honoured, a listening server blocks the write and the
 * DB is NOT created, a free port lets it through, and --force overrides.
 * Every write goes to a throwaway directory; the real data/ is never touched.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDir, resolveServerPort, probeServer } from './lib/dataDir.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATE = path.join(repoRoot, 'scripts', 'migrate-json-to-sqlite.mjs');

// --- resolution ---------------------------------------------------------------
assert.strictEqual(resolveDataDir({}), path.join(repoRoot, 'data'));
assert.strictEqual(resolveDataDir({ OMNI_DATA_DIR: os.tmpdir() }), path.resolve(os.tmpdir()));
assert.strictEqual(resolveServerPort({}), 3000);
assert.strictEqual(resolveServerPort({ OMNI_PORT: '3100' }), 3100);
assert.strictEqual(resolveServerPort({ PORT: '3200', OMNI_PORT: '3100' }), 3200);

// --- a listener that answers like a server -----------------------------------
const listener = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.end('[]');
});
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const busyPort = listener.address().port;
// A port that was just closed is free.
const freeProbe = http.createServer();
await new Promise(r => freeProbe.listen(0, '127.0.0.1', r));
const freePort = freeProbe.address().port;
await new Promise(r => freeProbe.close(r));

assert.strictEqual((await probeServer(busyPort)).state, 'answered');
assert.strictEqual((await probeServer(freePort)).state, 'free');

function runMigrate(dir, port, extra = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', MIGRATE, ...extra], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, OMNI_DATA_DIR: dir, PORT: String(port) },
    timeout: 120_000,
  });
}
function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-guard-'));
  fs.writeFileSync(path.join(dir, 'meets.json'), '[]');
  return dir;
}

try {
  // server answering -> refuse, and no DB file appears
  const d1 = freshDir();
  const blocked = runMigrate(d1, busyPort);
  assert.strictEqual(blocked.status, 1, `expected refusal, got ${blocked.status}\n${blocked.stderr}`);
  assert.match(blocked.stderr, /server may be holding/);
  assert.ok(!fs.existsSync(path.join(d1, 'omniswim.db')), 'DB must not be created while a server answers');
  assert.ok(blocked.stdout.includes(d1), 'resolved data dir is printed before the refusal');

  // free port -> proceeds and writes inside OMNI_DATA_DIR
  const d2 = freshDir();
  const ok = runMigrate(d2, freePort);
  assert.strictEqual(ok.status, 0, `expected success, got ${ok.status}\n${ok.stderr}`);
  assert.ok(fs.existsSync(path.join(d2, 'omniswim.db')), 'DB is created in OMNI_DATA_DIR');

  // --force overrides the guard
  const d3 = freshDir();
  const forced = runMigrate(d3, busyPort, ['--force']);
  assert.strictEqual(forced.status, 0, `expected --force success, got ${forced.status}\n${forced.stderr}`);
  assert.ok(fs.existsSync(path.join(d3, 'omniswim.db')));
} finally {
  await new Promise(r => listener.close(r));
}
console.log('data-dir guard: all checks passed');
