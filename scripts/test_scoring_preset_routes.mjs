/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The scoring-preset HTTP contract, against a real server process.
 *
 * These routes decide what rule set a coach's meet is scored with, so the
 * assertions that matter here are the refusals: a built-in id cannot be
 * overwritten, a points table that goes up as places get worse is rejected with
 * a message naming the place, an unknown key is named rather than swallowed, and
 * a format the NCAA publishes no table for answers "absent" rather than handing
 * back a default nobody sourced.
 *
 * The test creates exactly one preset file, under a fixed id, and removes it in
 * a finally block whether or not the assertions pass. `data/scoring_presets/` is
 * tracked, so a leftover file would show up as an untracked change.
 *
 * Test: npx tsx scripts/test_scoring_preset_routes.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.OMNI_PRESET_TEST_PORT ?? 3209);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_ID = 'zz-preset-route-test';
const TEST_FILE = path.join(REPO_ROOT, 'data', 'scoring_presets', `${TEST_ID}.json`);

/** A valid, minimal rule set: a real published table, so nothing here is invented. */
const VALID_SETTINGS = {
  scoringPoints: [9, 4, 3, 2, 1, 0],
  relayPoints: [11, 4, 2, 0],
  relayMultiplier: 2,
  halfRateRelaySwimmer: true,
  maxIndividualScorersPerTeam: 999,
  maxRelaysScoringPerTeam: 2,
  maxIndividualScorersPerTeamPerEvent: 3,
  aFinalBracketSize: 6,
  scorerCapScope: 'event',
  diverScorerWeight: 1,
  relayEligibleFromScorerPool: false,
  diverEventPattern: ['DIVING', 'DIVE'],
};

async function waitForServer(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/scoring-presets`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server did not answer on ${BASE} in time`);
    await new Promise(r => setTimeout(r, 300));
  }
}

async function json(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, body: payload };
}

if (fs.existsSync(TEST_FILE)) fs.rmSync(TEST_FILE);

/**
 * Run the server directly, not through `npx`.
 *
 * `npx tsx server.ts` puts the real server one level down as a grandchild of
 * npx. Killing npx leaves it running: it keeps the port, keeps the inherited
 * stdio pipes open, and so keeps this script's event loop from draining. The
 * script then never exits. On GitHub Actions that stalls `npm test` until the
 * job's own six-hour ceiling kills it -- which happened fifteen times in
 * September 2026 before anyone read the run times, and on a private repo those
 * are billed minutes.
 *
 * `process.execPath --import tsx` is the same thing one process shallower, and
 * it is exactly how `scripts/run-tests.mjs` launches every other script here.
 * `detached` puts it in its own process group so the teardown below can take
 * the whole group down, not just the leader.
 */
const server = spawn(process.execPath, ['--import', 'tsx', path.join('apps', 'shell', 'server.ts')], {
  cwd: REPO_ROOT,
  env: { ...process.env, OMNI_PORT: String(PORT), OMNI_HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: process.platform !== 'win32',
});
let serverLog = '';
server.stdout.on('data', d => {
  serverLog += d.toString();
});
server.stderr.on('data', d => {
  serverLog += d.toString();
});

/**
 * Kill the server and everything it started.
 *
 * On POSIX the negative pid targets the whole process group, which is why the
 * spawn above is `detached`. Without that, a grandchild survives and holds the
 * port. Wrapped because the group may already be gone, and a teardown that
 * throws would mask whatever the test actually found.
 */
function stopServer() {
  try {
    if (process.platform !== 'win32' && server.pid !== undefined) {
      process.kill(-server.pid, 'SIGKILL');
      return;
    }
    server.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

// Belt and braces: if an assertion throws past the finally block, or the runner
// kills this script, do not leave a server holding the port.
process.on('exit', stopServer);

let failed = null;
try {
  await waitForServer(90_000);

  // --- 1. The list merges built-ins with user presets and says which is which
  {
    const { status, body } = await json('GET', '/api/scoring-presets');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body), 'the list route returns an array');

    const byId = new Map(body.map(p => [p.id, p]));
    for (const id of ['generic-top16', 'nsisc', 'ncaa-dual-six-lanes-or-more']) {
      assert.ok(byId.has(id), `built-in "${id}" is listed`);
      assert.equal(byId.get(id).builtIn, true, `"${id}" is marked built-in`);
    }
    assert.ok(
      byId.get('ncaa-invitational-host-published')?.requiresHostPublishedTable === true,
      'the invitational format declares that the host must publish the table'
    );
    assert.equal(
      new Set(body.map(p => p.id)).size,
      body.length,
      'no id appears twice — a disk file must not shadow a built-in'
    );
  }

  // --- 2. A built-in's settings come from core, not from a stale disk copy ----
  {
    const { status, body } = await json('GET', '/api/scoring-presets/ncaa-dual-six-lanes-or-more');
    assert.equal(status, 200);
    assert.deepEqual(body.scoringPoints, [9, 4, 3, 2, 1, 0]);
    assert.deepEqual(body.relayPoints, [11, 4, 2, 0]);
    assert.equal(body.maxIndividualScorersPerTeamPerEvent, 3);

    // data/scoring_presets/nsisc.json is a stale seed copy carrying the
    // pre-2026-07-19 per-type entry caps. The built-in must win.
    const nsisc = await json('GET', '/api/scoring-presets/nsisc');
    assert.equal(nsisc.status, 200);
    assert.equal(
      nsisc.body.maxTotalEntriesPerSwimmer,
      7,
      'NSISC is a 7-event total rule; the built-in, not the stale file, is served'
    );
  }

  // --- 3. A table the NCAA does not publish answers absent, never a default --
  {
    const { status, body } = await json(
      'GET',
      '/api/scoring-presets/ncaa-invitational-host-published'
    );
    assert.equal(status, 409, 'an unpublished table is a refusal, not an empty success');
    assert.equal(body.requiresHostPublishedTable, true);
    assert.equal(body.citation, 'NCAA Rule 7-4');
    assert.ok(!('scoringPoints' in body), 'no invented table is returned');
  }

  // --- 4. Built-ins are immutable -------------------------------------------
  {
    const post = await json('POST', '/api/scoring-presets', {
      id: 'nsisc',
      label: 'Hijacked',
      settings: VALID_SETTINGS,
    });
    assert.equal(post.status, 409, 'creating over a built-in id is refused');
    assert.match(post.body.error, /built-in/i);

    const put = await json('PUT', '/api/scoring-presets/generic-top16', {
      label: 'Hijacked',
      settings: VALID_SETTINGS,
    });
    assert.equal(put.status, 409, 'updating a built-in is refused');

    const del = await json('DELETE', '/api/scoring-presets/ncaa-relay-meet');
    assert.equal(del.status, 409, 'deleting a built-in is refused');

    const after = await json('GET', '/api/scoring-presets/nsisc');
    assert.deepEqual(
      after.body.scoringPoints,
      [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
      'a refused write changed nothing'
    );
  }

  // --- 5. A malformed points table is rejected, and the message says why -----
  {
    const increasing = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Bad table',
      settings: { ...VALID_SETTINGS, scoringPoints: [9, 4, 7, 2] },
    });
    assert.equal(increasing.status, 400);
    assert.match(
      JSON.stringify(increasing.body.details),
      /place 3 is worth 7 but place 2 is worth 4/,
      'the error names the place that goes the wrong way'
    );

    const empty = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Empty table',
      settings: { ...VALID_SETTINGS, scoringPoints: [] },
    });
    assert.equal(empty.status, 400);
    assert.match(JSON.stringify(empty.body.details), /at least one place value/);

    const nonNumeric = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Text table',
      settings: { ...VALID_SETTINGS, scoringPoints: [9, '4', 3] },
    });
    assert.equal(nonNumeric.status, 400);

    const negative = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Negative',
      settings: { ...VALID_SETTINGS, scoringPoints: [9, 4, -1] },
    });
    assert.equal(negative.status, 400);
    assert.match(JSON.stringify(negative.body.details), /cannot be negative/);

    const unknownKey = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Typo',
      settings: { ...VALID_SETTINGS, relayPoint: [11, 4, 2] },
    });
    assert.equal(unknownKey.status, 400, 'a misspelled key is named, not silently dropped');
    assert.match(JSON.stringify(unknownKey.body.details), /relayPoint/);

    const badId = await json('POST', '/api/scoring-presets', {
      id: 'Has Spaces',
      label: 'Bad id',
      settings: VALID_SETTINGS,
    });
    assert.equal(badId.status, 400);

    assert.ok(!fs.existsSync(TEST_FILE), 'no file was written by any rejected create');
  }

  // --- 6. Create / read / update / delete a user preset ----------------------
  {
    const created = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Route test dual',
      description: 'Created by scripts/test_scoring_preset_routes.mjs',
      conferenceMatches: ['ZZTESTCONF'],
      settings: VALID_SETTINGS,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.id, TEST_ID);
    assert.equal(created.body.builtIn, false);
    assert.ok(fs.existsSync(TEST_FILE), 'the preset was written to disk');

    const listed = await json('GET', '/api/scoring-presets');
    const entry = listed.body.find(p => p.id === TEST_ID);
    assert.ok(entry, 'the new preset is listed');
    assert.equal(entry.builtIn, false, 'and is marked as a user preset');

    const read = await json('GET', `/api/scoring-presets/${TEST_ID}`);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.scoringPoints, VALID_SETTINGS.scoringPoints);
    assert.deepEqual(read.body.relayPoints, VALID_SETTINGS.relayPoints);
    assert.ok(!('label' in read.body), 'GET /:id returns settings, not metadata');

    const duplicate = await json('POST', '/api/scoring-presets', {
      id: TEST_ID,
      label: 'Again',
      settings: VALID_SETTINGS,
    });
    assert.equal(duplicate.status, 409, 'creating twice is refused');

    const updated = await json('PUT', `/api/scoring-presets/${TEST_ID}`, {
      label: 'Route test dual (edited)',
      settings: { ...VALID_SETTINGS, scoringPoints: [5, 3, 1, 0], relayPoints: [7, 0] },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.label, 'Route test dual (edited)');

    const reread = await json('GET', `/api/scoring-presets/${TEST_ID}`);
    assert.deepEqual(reread.body.scoringPoints, [5, 3, 1, 0]);
    assert.deepEqual(reread.body.relayPoints, [7, 0]);

    const mismatched = await json('PUT', `/api/scoring-presets/${TEST_ID}`, {
      id: 'something-else',
      label: 'Mismatch',
      settings: VALID_SETTINGS,
    });
    assert.equal(mismatched.status, 400, 'a body id that contradicts the URL is refused');

    const missing = await json('PUT', '/api/scoring-presets/zz-does-not-exist', {
      label: 'Nope',
      settings: VALID_SETTINGS,
    });
    assert.equal(missing.status, 404, 'PUT creates nothing');

    const removed = await json('DELETE', `/api/scoring-presets/${TEST_ID}`);
    assert.equal(removed.status, 200);
    assert.ok(!fs.existsSync(TEST_FILE), 'the file is gone');

    const goneRead = await json('GET', `/api/scoring-presets/${TEST_ID}`);
    assert.equal(goneRead.status, 404);

    const goneDelete = await json('DELETE', `/api/scoring-presets/${TEST_ID}`);
    assert.equal(goneDelete.status, 404, 'deleting twice is a 404, not a silent success');
  }

  console.log('scoring preset routes: all assertions passed');
} catch (err) {
  failed = err;
} finally {
  if (fs.existsSync(TEST_FILE)) fs.rmSync(TEST_FILE);
  stopServer();
  // Give the port a moment to be released before this process exits.
  await new Promise(r => setTimeout(r, 300));
}

if (failed) {
  console.error(serverLog.split('\n').slice(-25).join('\n'));
  throw failed;
}
