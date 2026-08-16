/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the network exposure of the local-first shell server.
 *
 * Three defects this locks down (see plans/2026-08-14/10-security-exposure.md):
 *  1. `httpServer.listen(PORT, '0.0.0.0')` bound the wifi adapter as well as
 *     loopback, while the banner printed "localhost" — so a coach on venue wifi
 *     could not see that the roster was being served to the whole network.
 *  2. Authentication is OFF in the default (sqlite) configuration, so anything
 *     reachable on that port can read AND overwrite athlete data.
 *  3. `/api/analyze-video` mounted a multer disk-storage middleware whose stored
 *     filename interpolated the attacker-controlled `file.originalname`. multer
 *     writes BEFORE the handler runs, so the route's 501 prevented nothing.
 *
 * This script starts no server and uploads nothing: assertions 1 and 3 read the
 * server source as text, and assertion 2 is pure `path` arithmetic on strings.
 *
 * Test: npx tsx scripts/test_server_binding.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = path.join(REPO_ROOT, 'apps', 'shell', 'server.ts');
const src = fs.readFileSync(SERVER_PATH, 'utf8');

// --- 1. The server binds loopback by default -------------------------------
{
  const listenCalls = [...src.matchAll(/\.listen\(([^)]*)\)/g)].map(m => m[1]);
  assert.ok(
    listenCalls.length >= 2,
    `expected both the dev and prod listen() call sites, found ${listenCalls.length}`
  );

  for (const args of listenCalls) {
    assert.ok(
      !/0\.0\.0\.0|::\s*'|'::'/.test(args),
      `listen() must not hardcode a wildcard bind address, got: listen(${args})`
    );
    assert.ok(
      /\bHOST\b/.test(args),
      `listen() must bind the HOST constant so OMNI_HOST is honoured, got: listen(${args})`
    );
  }

  // The default must be loopback, and it must come from OMNI_HOST when set.
  const hostDecl = src.match(/const HOST\s*=\s*([^;]+);/);
  assert.ok(hostDecl, 'server.ts must declare a HOST constant');
  assert.match(
    hostDecl[1],
    /process\.env\.OMNI_HOST\s*\?\?\s*'127\.0\.0\.1'/,
    `HOST must default to loopback and consult OMNI_HOST, got: ${hostDecl[1].trim()}`
  );

  // The banner has to state the real bind host, not a friendly fiction.
  const banner = src.match(/function logServerReady\(\)[\s\S]*?\n}/);
  assert.ok(banner, 'logServerReady() must exist');
  assert.ok(
    !/http:\/\/localhost:\$\{PORT\}/.test(banner[0]),
    'the startup banner must print the actual bind host, not a hardcoded "localhost"'
  );
  assert.match(banner[0], /urlHost\(HOST\)/, 'the banner URL must be built from HOST');
  assert.match(banner[0], /AUTH_REQUIRED/, 'the banner must state whether authentication is enabled');
  assert.match(
    banner[0],
    /Charts: ChartShell/,
    'the existing Charts boot line must survive (a dev-server test asserts on it)'
  );

  // Exposure without auth warns loudly, but never throws: sharing with an
  // assistant coach on a trusted network is a legitimate choice.
  assert.match(src, /function warnIfNetworkExposed\(\)/, 'a network-exposure warning must exist');
  const warn = src.match(/function warnIfNetworkExposed\(\)[\s\S]*?\n}/)[0];
  assert.match(warn, /isLoopbackHost\(HOST\)\s*\|\|\s*AUTH_REQUIRED/, 'warn only when exposed AND unauthenticated');
  assert.ok(!/throw|process\.exit/.test(warn), 'the exposure warning must not throw or exit');
  assert.match(warn, /READ and OVERWRITE/, 'the warning must name the read/write risk to roster data');
}

// --- 2. Upload path containment: the old scheme escaped, the new one cannot --
{
  /**
   * Run the arithmetic under both path flavours so the result does not depend
   * on which OS the suite is tested on.
   */
  const flavours = [
    { name: 'win32', p: path.win32, uploadDir: 'C:\\proj\\uploads', outsideRoot: 'C:\\' },
    { name: 'posix', p: path.posix, uploadDir: '/proj/uploads', outsideRoot: '/' },
  ];

  const isContained = (p, uploadDir, joined) => {
    const root = p.resolve(uploadDir);
    const target = p.resolve(joined);
    return target === root || target.startsWith(root + p.sep);
  };

  /** The scheme that shipped: attacker-controlled originalname in the path. */
  const oldName = (originalname, now = 1786000000000) => `${now}-${originalname}`;
  /** The scheme now in server.ts: name generated server-side, extension capped. */
  const newName = (p, originalname, id) => `${id}${p.extname(originalname).slice(0, 10)}`;

  const cases = [
    // `escapedUnderOldScheme` is the documented behaviour, not an aspiration:
    // the `${Date.now()}-` prefix absorbs a LEADING `../` (it becomes a literal
    // directory name), so `../../evil.txt` stayed inside by accident. A `..`
    // that FOLLOWS a path segment still pops out of the upload dir. That
    // accident is exactly why the prefix was never a defence.
    { originalname: 'race.mp4', escapedUnderOldScheme: false, ext: '.mp4' },
    { originalname: '../../evil.txt', escapedUnderOldScheme: false, ext: '.txt' },
    { originalname: 'x/../../../evil.txt', escapedUnderOldScheme: true, ext: '.txt' },
    { originalname: 'a/b/../../../../../evil.txt', escapedUnderOldScheme: true, ext: '.txt' },
    // Extension-shaped abuse: a very long extension is length-capped, and a
    // name that is only dots yields no traversable extension.
    { originalname: `payload.${'z'.repeat(300)}`, escapedUnderOldScheme: false, ext: null },
    { originalname: '..', escapedUnderOldScheme: false, ext: '' },
  ];

  for (const { name, p, uploadDir, outsideRoot } of flavours) {
    for (const c of cases) {
      // --- old scheme: reproduce the regression -----------------------------
      const oldJoined = p.join(uploadDir, oldName(c.originalname));
      const oldContained = isContained(p, uploadDir, oldJoined);
      assert.equal(
        oldContained,
        !c.escapedUnderOldScheme,
        `[${name}] old scheme containment changed for ${JSON.stringify(c.originalname)} → ${oldJoined}`
      );
      if (c.escapedUnderOldScheme) {
        // Prove the escape was real and not merely "a different subdirectory".
        assert.ok(
          p.resolve(oldJoined).startsWith(p.resolve(outsideRoot)) && !oldContained,
          `[${name}] ${JSON.stringify(c.originalname)} must resolve outside the project under the old scheme`
        );
        assert.match(
          p.basename(oldJoined),
          /^evil\.txt$/,
          `[${name}] the crafted name must land as evil.txt outside the upload dir`
        );
      }

      // --- new scheme: containment holds for every input --------------------
      const id = uuidv4();
      const stored = newName(p, c.originalname, id);
      assert.ok(
        !/[\\/]/.test(stored),
        `[${name}] server-generated name must contain no path separator, got ${stored}`
      );
      assert.ok(
        !stored.includes('..'),
        `[${name}] server-generated name must contain no traversal, got ${stored}`
      );
      assert.ok(
        stored.startsWith(id),
        `[${name}] server-generated name must start with the uuid, got ${stored}`
      );
      assert.ok(
        stored.length <= id.length + 10,
        `[${name}] carried-over extension must be length-capped, got ${stored}`
      );
      if (c.ext !== null) {
        assert.equal(stored, `${id}${c.ext}`, `[${name}] extension handling for ${c.originalname}`);
      }

      const newJoined = p.join(uploadDir, stored);
      assert.ok(
        isContained(p, uploadDir, newJoined),
        `[${name}] ${JSON.stringify(c.originalname)} must stay inside the upload dir → ${newJoined}`
      );
      assert.equal(
        p.dirname(p.resolve(newJoined)),
        p.resolve(uploadDir),
        `[${name}] the stored file must sit directly in the upload dir`
      );
    }
  }

  // The regression guard only means something if at least one case escaped.
  assert.ok(
    cases.some(c => c.escapedUnderOldScheme),
    'at least one case must have escaped under the old scheme, else this proves nothing'
  );
}

// --- 3. No upload middleware is mounted while the route returns 501 ---------
{
  const routeIdx = src.indexOf("app.post('/api/analyze-video'");
  assert.notEqual(routeIdx, -1, '/api/analyze-video route must exist');

  const arrowIdx = src.indexOf('=>', routeIdx);
  assert.notEqual(arrowIdx, -1, 'could not find the /api/analyze-video handler');
  const head = src.slice(routeIdx, arrowIdx); // everything before the handler body
  const body = src.slice(routeIdx, src.indexOf('});', arrowIdx));

  const returns501 = /status\(501\)/.test(body);
  if (returns501) {
    // multer writes to disk before the handler runs, so a 501 does not protect
    // an unauthenticated write. While the feature is unimplemented, accept no
    // file at all. When the route is genuinely implemented, this branch stops
    // applying — but the hardening asserted below must remain.
    assert.ok(
      !/upload|multer|\.single\(|\.array\(|\.fields\(/.test(head),
      `/api/analyze-video must not mount an upload middleware while it returns 501, got: ${head.trim()}`
    );
  }

  // The old vulnerable filename scheme must never come back.
  assert.ok(
    !/\$\{Date\.now\(\)\}-\$\{file\.originalname\}/.test(src),
    'the stored filename must never interpolate the client-supplied originalname'
  );

  // The upload config stays hardened so a future re-mount is safe by default.
  const factory = src.match(/export function createVideoUpload\(\)[\s\S]*?\n}/);
  assert.ok(factory, 'createVideoUpload() must exist so the hardening is not lost');
  const cfg = factory[0];
  assert.match(cfg, /uuidv4\(\)/, 'stored filename must be generated server-side from a uuid');
  assert.match(cfg, /path\.extname\(file\.originalname\)\.slice\(0,\s*10\)/, 'extension must be length-capped');
  assert.match(cfg, /fileSize:\s*512 \* 1024 \* 1024/, 'a file size cap must be configured');
  assert.match(cfg, /files:\s*1/, 'a file count cap must be configured');
  assert.match(cfg, /fileFilter:/, 'a mimetype filter must be configured');
  assert.match(src, /ALLOWED_VIDEO_MIMETYPES/, 'the accepted mimetypes must be an explicit allowlist');
}

console.log('server binding: all assertions passed');
