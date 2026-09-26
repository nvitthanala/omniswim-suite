/**
 * Unified Omni Swim Suite server (Matrix API + Metrics video route).
 */
import express from 'express';
import http from 'node:http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import { Workspace, ScoringSettings } from '../../packages/core/src/types.ts';
import { JsonRepo, SqliteRepo, PgRepo, type WorkspaceRepo } from './lib/workspaceRepo.ts';
import { staleCutTableLines } from './lib/cutTableFreshness.ts';
import { isLoopbackHost } from './lib/loopbackHost.ts';
import { FileSystemSwimCloudCaptureStore } from '../../packages/swimcloud/src/captureStore.ts';
import {
  loadOrCreateSwimCloudPairingToken,
  registerSwimCloudCaptureRoutes,
  swimCloudCaptureBannerLines,
} from './lib/swimcloudCaptureRoutes.ts';
import { createAuthMiddleware } from './lib/authMiddleware.ts';
import { AuthService, ShareLinkService } from '../../packages/db/src/AuthService.ts';
import { DEFAULT_SCORING_SETTINGS } from '../../packages/core/src/lib/scoringDefaults.ts';
import { cutlines as builtinCutlines } from '../../packages/core/src/cutlines.ts';
import { registerAuthRoutes } from './lib/routes/authRoutes.ts';
import { registerWorkspaceRoutes } from './lib/routes/workspaceRoutes.ts';
import { registerScoringPresetRoutes } from './lib/routes/scoringPresetRoutes.ts';
import { registerCutlineRoutes } from './lib/routes/cutlineRoutes.ts';
import { registerDevRoutes } from './lib/routes/devRoutes.ts';
import { registerParsingRoutes } from './lib/routes/parsingRoutes.ts';

const PORT = Number(process.env.PORT ?? process.env.OMNI_PORT ?? 3000);
/**
 * Bind loopback only, unless the operator explicitly opts out.
 *
 * This suite is local-first and ships with authentication OFF (see
 * AUTH_REQUIRED below), so the previous hardcoded `0.0.0.0` put the entire
 * roster — athlete names, class years, performance history for identifiable
 * minors — on whatever network the laptop had joined, readable AND writable by
 * anyone on it. A coach running this at a meet is on venue or hotel wifi.
 *
 * `127.0.0.1` is reachable from this machine only. Set OMNI_HOST=0.0.0.0 to
 * serve the network deliberately; startup then prints a warning rather than
 * refusing, because sharing with an assistant coach is a legitimate use.
 */
const HOST = process.env.OMNI_HOST ?? '127.0.0.1';
const __filename = fileURLToPath(import.meta.url);

/**
 * `chrome-extension://<id>` the SwimCloud capture routes should answer CORS
 * for. Unset is the expected configuration — the extension's background
 * service worker posts with `host_permissions` and is not subject to page
 * CORS. See `narrowCors` in `./lib/swimcloudCaptureRoutes.ts`.
 */
const SWIMCLOUD_EXTENSION_ORIGIN = process.env.OMNI_SWIMCLOUD_EXTENSION_ORIGIN ?? '';

/** Bracket bare IPv6 literals so the printed URL is actually clickable. */
function urlHost(host: string): string {
  if (!host) return '0.0.0.0';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
const SHELL_ROOT = path.dirname(__filename);

/**
 * Walk up from the entry file to the monorepo root.
 *
 * A fixed `../..` only holds in dev, where the entry is `apps/shell/server.ts`.
 * The production bundle is emitted to `apps/shell/dist/server.js`, one level
 * deeper, so `../..` resolved to `apps/` — the prod server then looked for
 * `apps/data/meets.json` (seeding an empty database) and served static files
 * from `apps/dist` (404 on every page). Find the root by its markers instead,
 * so dev, prod and a relocated bundle all agree.
 */
function findProjectRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const hasWorkspaces = fs.existsSync(path.join(dir, 'packages'));
    const hasManifest = fs.existsSync(path.join(dir, 'package.json'));
    if (hasWorkspaces && hasManifest) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fall back to the historical dev-layout guess rather than throwing at import time.
  return path.join(start, '../..');
}

const PROJECT_ROOT = findProjectRoot(SHELL_ROOT);
/**
 * Where workspaces, backups, presets and captures live.
 *
 * `OMNI_DATA_DIR` overrides it. That exists so a fresh-install path can be
 * exercised against a throwaway directory without moving anybody's real data
 * aside -- the seeding behaviour below decides what a brand-new user sees, and
 * it was previously impossible to check without risking the live store.
 */
const DATA_DIR = process.env.OMNI_DATA_DIR
  ? path.resolve(process.env.OMNI_DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
const MEETS_FILE = path.join(DATA_DIR, 'meets.json');
/**
 * The workspace a fresh install starts from.
 *
 * `data/meets.json` is this machine's LIVE working store. It used to be tracked
 * in git as well, so cloning the repo handed you somebody else's real roster --
 * real athlete names, recruit lists and history -- as your starting data. That
 * is fine for one person's own checkout and wrong for anybody else's.
 *
 * So the two roles are now separate files. `meets.json` is local and untracked;
 * `demo-seed.json` is small, committed, and entirely invented. Seeding prefers a
 * local `meets.json` when one exists, so an existing install keeps its own data.
 */
const DEMO_SEED_FILE = path.join(DATA_DIR, 'demo-seed.json');
const DB_FILE = path.join(DATA_DIR, 'omniswim.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const STORAGE_BACKEND = (process.env.OMNI_DB ?? 'sqlite').toLowerCase();
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const AUTH_REQUIRED = process.env.OMNI_AUTH_REQUIRED === 'true' || STORAGE_BACKEND === 'postgres';
const SCORING_PRESETS_DIR = path.join(DATA_DIR, 'scoring_presets');
const CUTLINES_DIR = path.join(DATA_DIR, 'cutlines');
/** Root of the local SwimCloud capture store — `plans/2026-09-08/02-capture-store.md`'s layout. */
const SWIMCLOUD_CAPTURE_ROOT = path.join(DATA_DIR, 'swimcloud-captures');
/**
 * Fallback only. The real default comes from data/cutlines/index.json, which is
 * regenerated by scripts/extract-cutlines.py. Hardcoding it here previously meant
 * a no-version request served the D1 2025-2026 table to a D2 workspace.
 */
const FALLBACK_CUTLINE_VERSION = '2026-2027';
const SCORING_SETTINGS_FILE = path.join(DATA_DIR, 'scoring_settings.json');
const AI_ENABLED = process.env.OMNI_AI_ENABLED === 'true';
/** Bump when chart mounting architecture changes (client stale-bundle guard). */
const CHART_BUILD_EPOCH = 2;
const PARSE_MEET_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'parse_meet.py');
const PARSE_PSYCH_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'psych_parser.py');
const PDF_PARSER_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'pdf_parser.py');
const POINT_CALCULATOR_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'point_calculator.py');
const TEAM_RANKINGS_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'team_rankings_parser.py');

/**
 * The scoring settings a brand-new workspace starts with.
 *
 * `data/scoring_settings.json` is an explicit operator override and still wins.
 * Otherwise this is core's own default — the same object the `generic-top16`
 * built-in serves, rather than a second copy of its numbers living here. The old
 * code read `data/scoring_presets/generic-top16.json` first; that file is a stale
 * seed copy of a built-in, the preset API no longer serves it, and reading it
 * here would let it silently disagree with what the picker shows.
 */
function loadDefaultScoringSettings(): ScoringSettings {
  if (fs.existsSync(SCORING_SETTINGS_FILE)) {
    return JSON.parse(fs.readFileSync(SCORING_SETTINGS_FILE, 'utf-8')) as ScoringSettings;
  }
  return { ...DEFAULT_SCORING_SETTINGS };
}

const defaultScoringSettings = loadDefaultScoringSettings();

/**
 * Startup-banner lines for the SwimCloud capture routes, filled in by
 * `startServer()` and printed by `logServerReady()`. They carry the pairing
 * token, or the reason the routes were not registered at all.
 */
let swimCloudCaptureBanner: readonly string[] = [];

function venvPythonPath(venvPath: string): string {
  return process.platform === 'win32'
    ? path.join(venvPath, 'Scripts', 'python.exe')
    : path.join(venvPath, 'bin', 'python');
}

function ensurePythonVenv() {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const venvPath = path.join(PROJECT_ROOT, 'venv');

  const createVenv = () => {
    execSync(`${pythonCmd} -m venv venv`, { stdio: 'ignore', cwd: PROJECT_ROOT });
  };

  const venvPythonUsable = (interpreter: string): boolean => {
    try {
      execSync(`"${interpreter}" -c "import sys"`, { stdio: 'ignore', cwd: PROJECT_ROOT });
      return true;
    } catch {
      return false;
    }
  };

  if (!fs.existsSync(venvPath)) {
    createVenv();
  }

  let venvPython = venvPythonPath(venvPath);
  if (!venvPythonUsable(venvPython)) {
    fs.rmSync(venvPath, { recursive: true, force: true });
    createVenv();
    venvPython = venvPythonPath(venvPath);
    if (!venvPythonUsable(venvPython)) {
      throw new Error('Python venv could not be created or repaired');
    }
  }

  try {
    execSync(`"${venvPython}" -c "import pdfplumber"`, { stdio: 'ignore', cwd: PROJECT_ROOT });
  } catch {
    execSync(`"${venvPython}" -m pip install pdfplumber`, { stdio: 'inherit', cwd: PROJECT_ROOT });
  }
}

const ALLOWED_VIDEO_MIMETYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/mpeg',
]);

/**
 * Hardened video upload middleware. Defined but deliberately NOT mounted —
 * `/api/analyze-video` returns 501, and multer writes the file to disk before
 * the route handler runs, so mounting it while the feature is unimplemented is
 * an unauthenticated write with nothing on the other end. Call this only when
 * the route actually consumes the file.
 *
 * The client-supplied `file.originalname` is never used in the stored path. It
 * is attacker-controlled, and the old `${Date.now()}-${originalname}` scheme
 * only absorbed a LEADING `../`: a `..` following a path segment still escaped,
 * so `x/../../../evil.txt` resolved outside the project root entirely. The
 * stored name is generated server-side from a uuid; only a length-capped
 * extension is carried over, and `path.extname` reads the basename, so it can
 * never reintroduce a separator. See scripts/test_server_binding.mjs.
 */
export function createVideoUpload() {
  const uploadDir = path.join(PROJECT_ROOT, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname).slice(0, 10)}`),
    }),
    limits: { fileSize: 512 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (!ALLOWED_VIDEO_MIMETYPES.has(file.mimetype)) {
        // Reject loudly rather than silently dropping the file.
        cb(new Error(`Unsupported upload type: ${file.mimetype}`));
        return;
      }
      cb(null, true);
    },
  });
}

async function startServer() {
  try {
    ensurePythonVenv();
  } catch (err) {
    console.warn('Python venv setup warning:', err);
  }

  const app = express();

  // --- SwimCloud capture routes (browser extension -> local capture store) ---
  //
  // Mounted FIRST, deliberately, and the order is load-bearing: body-parser is
  // a no-op once `req.body` is set, so mounting these after the app-wide 50 MB
  // `express.json` below would silently give them a 50 MB cap instead of their
  // own 2 MB one. They also carry a Content-Length guard of their own so the
  // cap survives if this ordering is ever changed. See
  // `plans/2026-09-08/03-extension-crawler.md`'s security requirements 1-5;
  // every one of them lives in `./lib/swimcloudCaptureRoutes.ts` and is
  // exercised by `tests/swimcloudCaptureRoutes.test.ts`.
  const swimCloudPairing = loadOrCreateSwimCloudPairingToken(DATA_DIR);
  const swimCloudCaptureRegistration = registerSwimCloudCaptureRoutes(app, {
    store: new FileSystemSwimCloudCaptureStore(SWIMCLOUD_CAPTURE_ROOT),
    captureRoot: SWIMCLOUD_CAPTURE_ROOT,
    pairingToken: swimCloudPairing.token,
    host: HOST,
    ...(SWIMCLOUD_EXTENSION_ORIGIN === '' ? {} : { extensionOrigin: SWIMCLOUD_EXTENSION_ORIGIN }),
  });
  swimCloudCaptureBanner = swimCloudCaptureBannerLines(swimCloudCaptureRegistration, swimCloudPairing);

  app.use(express.json({ limit: '50mb' }));

  const blankWorkspace = (): Workspace[] => [
    {
      id: uuidv4(),
      name: 'Blank Workspace 1',
      menResults: [],
      womenResults: [],
      recruits: [],
      deletedSwimmers: [],
      createdAt: Date.now(),
      scoringSettings: defaultScoringSettings,
    },
  ];

  /**
   * What a store with nothing in it should contain.
   *
   * The committed demo when it is readable, otherwise one empty workspace. A
   * demo that fails to parse must not take the server down or leave a new user
   * staring at an error -- it degrades to the blank workspace and says why,
   * because the demo is a convenience and the app is not.
   *
   * Every id is regenerated per install. The file ships fixed ids so it stays
   * byte-stable in git, and two installs must not share a workspace id.
   */
  const seedWorkspaces = (): Workspace[] => {
    if (!fs.existsSync(DEMO_SEED_FILE)) return blankWorkspace();
    try {
      const parsed = JSON.parse(fs.readFileSync(DEMO_SEED_FILE, 'utf-8')) as Workspace[];
      if (!Array.isArray(parsed) || parsed.length === 0) return blankWorkspace();
      return parsed.map(ws => ({ ...ws, id: uuidv4(), createdAt: Date.now() }));
    } catch (err) {
      console.warn(`Demo seed at ${DEMO_SEED_FILE} could not be read; starting empty instead:`, err);
      return blankWorkspace();
    }
  };

  let repo: WorkspaceRepo;
  let auth: AuthService | null = null;
  let shareLinks: ShareLinkService | null = null;

  if (STORAGE_BACKEND === 'postgres') {
    if (!DATABASE_URL) {
      console.error('OMNI_DB=postgres requires DATABASE_URL');
      process.exit(1);
    }
    auth = new AuthService(DATABASE_URL);
    shareLinks = new ShareLinkService(DATABASE_URL);
    repo = new PgRepo(DATABASE_URL, BACKUP_DIR);
    await repo.init();
    console.log('Storage backend: PostgreSQL (shared multi-user)');
  } else if (STORAGE_BACKEND === 'sqlite') {
    try {
      repo = new SqliteRepo(DB_FILE, BACKUP_DIR, seedWorkspaces, MEETS_FILE);
      await repo.init();
      console.log('Storage backend: SQLite (data/omniswim.db)');
    } catch (err) {
      console.warn('SQLite backend failed to initialize, falling back to JSON:', err);
      repo = new JsonRepo(MEETS_FILE, BACKUP_DIR, seedWorkspaces);
      await repo.init();
    }
  } else {
    repo = new JsonRepo(MEETS_FILE, BACKUP_DIR, seedWorkspaces);
    await repo.init();
    console.log('Storage backend: JSON (data/meets.json)');
  }

  // One backup per server start. The backup route existed from the beginning
  // but nothing ever called it -- not the UI, not a schedule -- so the only
  // copies on disk were hand-made months apart. A coach losing a roster is the
  // worst realistic failure this app has, and a start-up snapshot costs one
  // JSON write. Retention keeps it bounded (see DEFAULT_BACKUP_KEEP).
  //
  // Never fatal: a suite that will not boot because it could not write a
  // backup is worse than one running without today's snapshot.
  try {
    const startupBackup = await repo.backup('startup');
    console.log(`Startup backup written: ${path.basename(startupBackup)}`);
  } catch (err) {
    console.warn('Startup backup failed; continuing without one:', err);
  }

  // A4 (production-readiness, 2026-09-24): report-only staleness check for
  // the archived cut-standard tables. Never fetches anything -- it only logs
  // which divisions' newest table is behind the current season, so a coach
  // knows to re-run scripts/fetch-cutlines.py once the NCAA/NAIA publish.
  // Never fatal: a missing or malformed manifest logs a warning, same
  // posture as the startup backup above.
  try {
    const manifestPath = path.join(PROJECT_ROOT, 'data', 'cutlines', 'sources', 'manifest.json');
    const manifestJson = fs.readFileSync(manifestPath, 'utf-8');
    for (const line of staleCutTableLines(manifestJson, new Date())) {
      console.log(line);
    }
  } catch (err) {
    console.warn('Cut-table freshness check failed; continuing without it:', err);
  }

  const optionalAuth = createAuthMiddleware(auth, false);
  const requireAuth = createAuthMiddleware(auth, true);

  /**
   * Lets Matrix's own frontend obtain the SwimCloud pairing token so
   * `SwimCloudCapturePicker.tsx` can call the capture routes without a coach
   * copying the token out of the startup banner by hand.
   *
   * Gap found during Phase 4 integration: the capture routes (registered
   * above, before this app's own auth middleware existed yet) require
   * `X-Omniswim-Capture-Token` on every request, including `GET`. The picker
   * had no way to learn that token, so every request from the app's own UI
   * would 401. This route is that missing path — and only that path, not a
   * general relaxation of the capture routes' own guard, which stays as-is
   * for the extension's requests.
   *
   * Security posture, reasoned explicitly rather than assumed:
   * - Gated by this app's own auth (`requireAuth` when `AUTH_REQUIRED`,
   *   `optionalAuth` otherwise) — the same protection every other
   *   workspace-data route in this file already has. It grants no more trust
   *   than the rest of the app already extends to its own frontend.
   * - No CORS header is set here, matching `swimcloudCaptureRoutes.ts`'s own
   *   default posture. A page on another origin can still cause the browser
   *   to *send* this request, but cannot *read* the JSON response without an
   *   `Access-Control-Allow-Origin` this route never emits — so the token
   *   stays opaque to any page but this app's own same-origin frontend,
   *   which is the actual property this token exists to protect.
   * - Registered only when the capture routes themselves were (loopback
   *   bind) — serving a token for routes that do not exist would be a
   *   confusing half-truth, not a convenience.
   */
  if (swimCloudCaptureRegistration.registered) {
    app.get(
      '/api/swimcloud/pairing-token',
      AUTH_REQUIRED ? requireAuth : optionalAuth,
      (_req, res) => {
        res.json({ token: swimCloudPairing.token });
      }
    );
  }

  registerAuthRoutes(app, { auth, optionalAuth, requireAuth, AUTH_REQUIRED });

  registerWorkspaceRoutes(app, {
    repo,
    auth,
    shareLinks,
    AUTH_REQUIRED,
    requireAuth,
    optionalAuth,
    defaultScoringSettings,
  });

  registerScoringPresetRoutes(app, { scoringPresetsDir: SCORING_PRESETS_DIR });

  registerCutlineRoutes(app, {
    cutlinesDir: CUTLINES_DIR,
    fallbackCutlineVersion: FALLBACK_CUTLINE_VERSION,
    builtinCutlines,
  });

  registerDevRoutes(app, { projectRoot: PROJECT_ROOT, chartBuildEpoch: CHART_BUILD_EPOCH });

  registerParsingRoutes(app, {
    projectRoot: PROJECT_ROOT,
    dataDir: DATA_DIR,
    pdfParserScript: PDF_PARSER_SCRIPT,
    parseMeetScript: PARSE_MEET_SCRIPT,
    parsePsychScript: PARSE_PSYCH_SCRIPT,
    pointCalculatorScript: POINT_CALCULATOR_SCRIPT,
    teamRankingsScript: TEAM_RANKINGS_SCRIPT,
    aiEnabled: AI_ENABLED,
  });

  if (process.env.NODE_ENV !== 'production') {
    const httpServer = http.createServer(app);
    const vite = await createViteServer({
      configFile: path.join(SHELL_ROOT, 'vite.config.ts'),
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `Port ${PORT} is already in use. Close the other server window or run with OMNI_PORT=3001 npm run dev`
        );
        process.exit(1);
      }
      throw err;
    });

    httpServer.listen(PORT, HOST, () => {
      logServerReady();
    });
  } else {
    app.use(express.static(path.join(PROJECT_ROOT, 'dist')));
    app.use('/api', (_req, res) => {
      res.status(404).json({ error: 'API route not found — restart the server after updating' });
    });
    app.get('*', (_req, res) => {
      res.sendFile(path.join(PROJECT_ROOT, 'dist', 'index.html'));
    });

    const httpServer = http.createServer(app);
    httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `Port ${PORT} is already in use. Close the other server or set OMNI_PORT to a free port.`
        );
        process.exit(1);
      }
      throw err;
    });
    httpServer.listen(PORT, HOST, () => {
      logServerReady();
    });
  }
}

function logServerReady() {
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD', {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* not a git checkout */
  }
  // Print the host actually bound, never a friendly fiction: the old banner said
  // "localhost" while the server was listening on every interface, which made the
  // exposure invisible to the person running it.
  const loopback = isLoopbackHost(HOST);
  console.log(`Omni Swim Suite running at http://${urlHost(HOST)}:${PORT} (commit ${commit})`);
  console.log(
    `Bind host: ${HOST || '(all interfaces)'} — ${
      loopback ? 'loopback, reachable from this machine only' : 'REACHABLE FROM THE NETWORK'
    }`
  );
  console.log(
    AUTH_REQUIRED
      ? `Authentication: REQUIRED (${STORAGE_BACKEND} backend) — every workspace request needs a session.`
      : 'Authentication: DISABLED — any request reaching this port can read and write roster data.'
  );
  console.log('Charts: ChartShell → ChartFrame → Recharts (no ResponsiveContainer). Hard-refresh after git pull.');
  swimCloudCaptureBanner.forEach(line => console.log(line));
  warnIfNetworkExposed();
}

/**
 * Loud, unmissable banner for the one combination that leaks a roster: bound to
 * a routable interface with no authentication. Warn, do not throw — an operator
 * may be deliberately sharing with an assistant coach on a trusted network.
 */
function warnIfNetworkExposed() {
  if (isLoopbackHost(HOST) || AUTH_REQUIRED) return;
  const bar = '='.repeat(74);
  console.warn('');
  console.warn(bar);
  console.warn('  WARNING: THIS SERVER IS REACHABLE FROM THE NETWORK, WITH NO AUTHENTICATION');
  console.warn(bar);
  console.warn(`  Bound to ${HOST || '0.0.0.0'}, so every device on this wifi can reach port ${PORT}.`);
  console.warn('  Authentication is off, so anyone who reaches it can READ and OVERWRITE');
  console.warn('  roster data: athlete names, class years and performance history.');
  console.warn('');
  console.warn('  On venue, hotel or other shared wifi, stop the server and restart it');
  console.warn('  without OMNI_HOST (it then binds 127.0.0.1 — this machine only).');
  console.warn(bar);
  console.warn('');
}

/**
 * Without these, an unhandled promise rejection ANYWHERE in this process —
 * this file, a route module, a dependency, a stray async callback — kills
 * the whole server with no log line, since Node (v15+) treats an unhandled
 * rejection as fatal by default. Found 2026-09-10 after this exact server
 * process died silently, twice, mid-session, with nothing in its own log to
 * explain why — the only trace was the port going free and a `tasklist`
 * check showing the PID gone. A coach mid-import who hits that timing sees
 * a plain connection failure ("Failed to update workspace") with nothing
 * about the real cause anywhere, including in this file's own logs.
 *
 * This does not fix whatever throws — it turns "the whole app is down, no
 * clue why" into "one request failed, and here is exactly what threw,"
 * which is the difference between a debuggable incident and a mystery. A
 * request already in flight when this fires still fails (the response was
 * never sent), but every OTHER request, and every other open browser tab,
 * keeps working instead of losing the server entirely.
 */
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED PROMISE REJECTION (server would have crashed here before 2026-09-10):', reason);
});
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION (server would have crashed here before 2026-09-10):', error);
});

startServer();
