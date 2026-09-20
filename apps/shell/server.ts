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
import { spawn, execSync } from 'child_process';
import { Gender, SwimmerResult, Workspace, ScoringSettings } from '../../packages/core/src/types.ts';
import { normalizeSwimmerResultRelayFields } from '../../packages/core/src/lib/relaySplits.ts';
import { parseSwimCloudPasteDetailed } from '../../packages/core/src/lib/athleteHistory.ts';
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
  parsePdfSchema,
  parsePsychPdfSchema,
  parseAthleteHistorySchema,
} from '../../packages/core/src/schemas/workspace.ts';
import { JsonRepo, SqliteRepo, PgRepo, type WorkspaceRepo } from './lib/workspaceRepo.ts';
import { isLoopbackHost } from './lib/loopbackHost.ts';
import { FileSystemSwimCloudCaptureStore } from '../../packages/swimcloud/src/captureStore.ts';
import {
  loadOrCreateSwimCloudPairingToken,
  registerSwimCloudCaptureRoutes,
  swimCloudCaptureBannerLines,
} from './lib/swimcloudCaptureRoutes.ts';
import {
  createAuthMiddleware,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
  type AuthedRequest,
} from './lib/authMiddleware.ts';
import { AuthService, ShareLinkService } from '../../packages/db/src/AuthService.ts';
import { buildMeetReportHtml } from '../../packages/core/src/lib/reportBuilder.ts';
import {
  DEFAULT_SCORING_SETTINGS,
  HostPublishedTableRequiredError,
  SCORING_PRESET_META_KEYS,
  builtInScoringPresetMeta,
  isBuiltInScoringPresetId,
  setUserConferencePresetBindings,
  settingsForBuiltInScoringPreset,
} from '../../packages/core/src/lib/scoringDefaults.ts';
import { NCAA_MEET_FORMATS, type NcaaMeetFormat } from '../../packages/core/src/lib/ncaaScoringRules.ts';
import { z } from 'zod';
import { cutlines as builtinCutlines } from '../../packages/core/src/cutlines.ts';
import { expandTeamAbbrev } from '../../packages/core/src/data/teamAliases.ts';
import {
  normalizePsychAthleteRows,
  psychParseFormatsToTry,
  pickBestPsychParseCandidate,
  scorePsychParseQuality,
  type PsychAthleteRow,
} from '../../packages/core/src/lib/psychParseQuality.ts';

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
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const MEETS_FILE = path.join(DATA_DIR, 'meets.json');
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

/** Keys a stored preset carries about itself rather than about scoring. Defined once, in core. */
const PRESET_META_KEYS = new Set<string>(SCORING_PRESET_META_KEYS);

/** A saved preset id: lowercase, so two files cannot collide on a case-insensitive filesystem. */
const USER_PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,79}$/;

function userPresetFilePath(presetId: string): string {
  return path.join(SCORING_PRESETS_DIR, `${presetId}.json`);
}

function loadScoringPresetFile(presetId: string): Record<string, unknown> | null {
  const safeId = presetId.replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(SCORING_PRESETS_DIR, `${safeId}.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function stripPresetMeta(raw: Record<string, unknown>) {
  const settings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!PRESET_META_KEYS.has(k)) settings[k] = v;
  }
  return settings;
}

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

// ---------------------------------------------------------------------------
// Scoring-preset validation
// ---------------------------------------------------------------------------

/**
 * A place-value table.
 *
 * Rejects an empty table, a non-finite or negative value, and a table that goes
 * *up* as places get worse. None of those is a competition rule; accepting one
 * produces a plausible team total nobody can trace to a published table.
 */
function pointsTableSchema(field: string) {
  return z
    .array(z.number().finite(`${field}: every place value must be a finite number.`))
    .min(1, `${field} must list at least one place value.`)
    .superRefine((places, ctx) => {
      places.forEach((value, i) => {
        if (value < 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `${field}: place ${i + 1} is ${value}; place values cannot be negative.`,
          });
        }
      });
      for (let i = 1; i < places.length; i += 1) {
        if (places[i] > places[i - 1]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message:
              `${field}: place ${i + 1} is worth ${places[i]} but place ${i} is worth ` +
              `${places[i - 1]}. A place table must not increase as places get worse.`,
          });
        }
      }
    });
}

const scorerAutoRulesSchema = z
  .object({
    abFinalTiers: z.array(z.enum(['A', 'B'])).optional(),
    includeRelayLegsInFinals: z.boolean().optional(),
    distanceFinalRequired: z.boolean().optional(),
    distanceEventPattern: z.array(z.string()).optional(),
  })
  .strict();

/**
 * Strict on purpose. A misspelled key in a scoring rule set is exactly how a
 * silent wrong total is born: the engine ignores `relayPoint`, the coach sees
 * their table saved, and the relays score off the multiplier instead. Naming the
 * unknown key is far better than accepting it.
 */
const scoringSettingsSchema = z
  .object({
    scoringPoints: pointsTableSchema('scoringPoints'),
    relayMultiplier: z.number().finite().nonnegative(),
    halfRateRelaySwimmer: z.boolean(),
    maxIndividualScorersPerTeam: z.number().finite().nonnegative(),
    maxRelaysScoringPerTeam: z.number().finite().nonnegative(),
    aFinalBracketSize: z.number().int().positive().optional(),
    unscoredRounds: z.array(z.string()).optional(),
    scoredEventNumberMax: z.number().int().positive().optional(),
    scorerCapScope: z.enum(['meet', 'event']).optional(),
    diverScorerWeight: z.number().finite().positive().optional(),
    diverEventPattern: z.array(z.string().min(1)).optional(),
    relayEligibleFromScorerPool: z.boolean().optional(),
    scorerEligibilityMode: z.enum(['points_pool', 'roster']).optional(),
    usePdfPlacePoints: z.union([z.boolean(), z.literal('auto')]).optional(),
    scorerAutoRules: scorerAutoRulesSchema.optional(),
    maxIndividualEntriesPerSwimmer: z.number().int().nonnegative().optional(),
    maxRelayEntriesPerSwimmer: z.number().int().nonnegative().optional(),
    maxTotalEntriesPerSwimmer: z.number().int().nonnegative().optional(),
    relayPoints: pointsTableSchema('relayPoints').optional(),
    divingPoints: pointsTableSchema('divingPoints').optional(),
    maxIndividualScorersPerTeamPerEvent: z.number().int().positive().optional(),
    divingMaxScorersPerTeamPerEvent: z.number().int().positive().optional(),
    overCapPlaceBehavior: z.enum(['holds-place', 'removed-from-consideration']).optional(),
    meetFormat: z
      .enum([...NCAA_MEET_FORMATS] as [NcaaMeetFormat, ...NcaaMeetFormat[]])
      .optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    // The engine refuses this pair at scoring time (see `resolveTeamPlaceCap`);
    // refusing it at the API boundary means a coach learns at save time, not
    // mid-meet.
    if (
      settings.maxIndividualScorersPerTeamPerEvent != null &&
      settings.scorerCapScope === 'meet' &&
      settings.maxIndividualScorersPerTeam < 999
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['maxIndividualScorersPerTeamPerEvent'],
        message:
          'A per-event place cap cannot be combined with a meet-wide scorer pool ' +
          "(scorerCapScope 'meet' with maxIndividualScorersPerTeam below 999). The two rules " +
          'disagree about whether a contestant who takes a place but scores nothing spends a ' +
          'pool slot, and the rulebook settles neither. Use one or the other.',
      });
    }
  });

const scoringPresetWriteSchema = z
  .object({
    id: z.string().regex(USER_PRESET_ID_RE, {
      message:
        'A preset id must be lowercase letters, digits, hyphens or underscores, start with a ' +
        'letter or digit, and be at most 80 characters.',
    }),
    label: z.string().trim().min(1, 'A preset needs a label.').max(120),
    description: z.string().max(1000).optional(),
    conferenceMatches: z.array(z.string().trim().min(1)).max(50).optional(),
    settings: scoringSettingsSchema,
  })
  .strict();

type ScoringPresetWriteBody = z.infer<typeof scoringPresetWriteSchema>;

function zodDetails(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
}

/**
 * Startup-banner lines for the SwimCloud capture routes, filled in by
 * `startServer()` and printed by `logServerReady()`. They carry the pairing
 * token, or the reason the routes were not registered at all.
 */
let swimCloudCaptureBanner: readonly string[] = [];

async function runPythonScript(scriptPath: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const venvPython =
      process.platform === 'win32'
        ? path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe')
        : path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';

    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        OMNI_PROJECT_ROOT: PROJECT_ROOT,
        OMNI_DATA_DIR: DATA_DIR,
        PYTHONPATH: [
          path.join(PROJECT_ROOT, 'backend'),
          process.env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(path.delimiter),
      },
    });

    let output = '';
    let errorOutput = '';
    let resolved = false;

    proc.stdout.on('data', d => {
      output += d.toString();
    });
    proc.stderr.on('data', d => {
      errorOutput += d.toString();
    });
    proc.on('error', err => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    proc.on('close', code => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) reject(new Error(`Python exit ${code}: ${errorOutput || output.slice(0, 500)}`));
      else if (!output.trim() && errorOutput.trim()) {
        reject(new Error(errorOutput.trim().slice(0, 500)));
      } else if (!output.trim()) {
        reject(new Error('Python script returned empty output'));
      } else resolve(output);
    });

    if (stdin) {
      proc.stdin.write(stdin, 'utf-8', () => proc.stdin.end());
    }
  });
}

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

  const seedWorkspaces = (): Workspace[] => [
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

  const optionalAuth = createAuthMiddleware(auth, false);
  const requireAuth = createAuthMiddleware(auth, true);

  function applyRepoScope(req: AuthedRequest): void {
    if (req.user && repo.setScope) {
      repo.setScope({ ownerId: req.user.id, teamId: req.user.teamId });
    }
  }

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

  // --- Auth routes (PostgreSQL deployments) ---
  app.post('/api/auth/register', async (req, res) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    try {
      const { email, password, displayName } = req.body ?? {};
      if (typeof email !== 'string' || typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Valid email and password (6+ chars) required' });
      }
      const session = await auth.register(email, password, displayName);
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ user: session.user });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(msg === 'EMAIL_EXISTS' ? 409 : 500).json({ error: msg });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    if (!auth) return res.status(503).json({ error: 'Auth requires PostgreSQL backend' });
    try {
      const { email, password } = req.body ?? {};
      const session = await auth.login(String(email ?? ''), String(password ?? ''));
      setSessionCookie(res, session.token, session.expiresAt);
      res.json({ user: session.user });
    } catch (err) {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  app.post('/api/auth/logout', optionalAuth, async (req: AuthedRequest, res) => {
    if (auth && req.sessionToken) await auth.logout(req.sessionToken);
    clearSessionCookie(res);
    res.json({ success: true });
  });

  app.get('/api/auth/me', optionalAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user ?? null, authRequired: AUTH_REQUIRED });
  });

  app.post('/api/auth/invite', requireAuth, async (req: AuthedRequest, res) => {
    if (!auth || !req.user?.teamId) return res.status(503).json({ error: 'Invite unavailable' });
    try {
      await auth.inviteToTeam(req.user.teamId, req.user.id, String(req.body?.email ?? ''));
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: msg });
    }
  });

  function normalizeWorkspaceResults(ws: Workspace): Workspace {
    return {
      ...ws,
      menResults: (ws.menResults || []).map(normalizeSwimmerResultRelayFields),
      womenResults: (ws.womenResults || []).map(normalizeSwimmerResultRelayFields),
    };
  }

  app.get('/api/workspaces', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      const data = await repo.list();
      res.json(data.map(normalizeWorkspaceResults));
    } catch (err) {
      res.status(500).json({ error: 'Failed to read workspaces', details: String(err) });
    }
  });

  app.post('/api/workspaces', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    const parsed = createWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid workspace payload', details: parsed.error.issues });
    }
    const body = parsed.data as Record<string, unknown> & Partial<Workspace>;
    const newWorkspace: Workspace = {
      id: typeof body.id === 'string' ? body.id : uuidv4(),
      name: body.name || 'New Workspace',
      menResults: body.menResults ?? [],
      womenResults: body.womenResults ?? [],
      recruits: body.recruits ?? [],
      deletedSwimmers: body.deletedSwimmers ?? [],
      createdAt: body.createdAt ?? Date.now(),
      scoringSettings: body.scoringSettings ?? defaultScoringSettings,
      ...body,
    };
    try {
      applyRepoScope(req);
      const created = await repo.create(newWorkspace);
      res.json(created);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create workspace', details: String(err) });
    }
  });

  app.put('/api/workspaces/:id', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    const parsed = updateWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid workspace patch', details: parsed.error.issues });
    }
    const expectedVersion =
      typeof req.body?.version === 'number' ? (req.body.version as number) : undefined;
    try {
      applyRepoScope(req);
      const updated = await repo.update(req.params.id, parsed.data as Partial<Workspace>, expectedVersion);
      if (!updated) return res.status(404).json({ error: 'Workspace not found' });
      res.json(updated);
    } catch (err) {
      if (err instanceof Error && (err as Error & { code?: string }).code === 'VERSION_CONFLICT') {
        return res.status(409).json({ error: 'Version conflict — refresh and retry' });
      }
      res.status(500).json({ error: 'Failed to update workspace', details: String(err) });
    }
  });

  app.delete('/api/workspaces/:id', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      // Back up before the only irreversible workspace operation there is.
      // Deliberately best-effort: a backup that cannot be written must not
      // block a delete the user asked for, but it must say so loudly rather
      // than failing silently.
      try {
        await repo.backup('pre-delete');
      } catch (backupErr) {
        console.warn('Pre-delete backup failed; deleting anyway:', backupErr);
      }
      await repo.remove(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete workspace', details: String(err) });
    }
  });

  app.post('/api/workspaces/backup', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      const file = await repo.backup('manual');
      res.json({ success: true, file: path.basename(file) });
    } catch (err) {
      res.status(500).json({ error: 'Backup failed', details: String(err) });
    }
  });

  // Workspace snapshots (SQLite backend only; JSON backend returns empty/no-op).
  app.post('/api/workspaces/:id/snapshots', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      const label = typeof req.body?.label === 'string' ? req.body.label : 'snapshot';
      const snap = await repo.snapshot(req.params.id, label);
      if (!snap) return res.status(400).json({ error: 'Snapshots require SQLite or PostgreSQL backend' });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: 'Snapshot failed', details: String(err) });
    }
  });

  app.get('/api/workspaces/:id/snapshots', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      res.json(await repo.listSnapshots(req.params.id));
    } catch (err) {
      res.status(500).json({ error: 'Failed to list snapshots', details: String(err) });
    }
  });

  // Read-only snapshot content (diff drill-down) — never restores.
  app.get('/api/snapshots/:snapshotId', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      if (repo.kind === 'json') {
        return res.status(400).json({ error: 'Snapshots require SQLite or PostgreSQL backend' });
      }
      const content = await repo.getSnapshotContent(req.params.snapshotId);
      if (!content) return res.status(404).json({ error: 'Snapshot not found' });
      res.json(content);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read snapshot', details: String(err) });
    }
  });

  app.post('/api/snapshots/:snapshotId/restore', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      const restored = await repo.restoreSnapshot(req.params.snapshotId);
      if (!restored) return res.status(404).json({ error: 'Snapshot not found' });
      res.json(restored);
    } catch (err) {
      res.status(500).json({ error: 'Restore failed', details: String(err) });
    }
  });

  // Shareable read-only links + printable reports
  app.post('/api/workspaces/:id/share', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    if (!shareLinks || !req.user) {
      return res.status(503).json({ error: 'Share links require PostgreSQL auth backend' });
    }
    try {
      applyRepoScope(req);
      const ws = (await repo.list()).find(w => w.id === req.params.id);
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const link = await shareLinks.createLink(
        req.params.id,
        req.user.id,
        req.user.teamId,
        typeof req.body?.label === 'string' ? req.body.label : ws.name
      );
      res.json(link);
    } catch (err) {
      res.status(500).json({ error: 'Failed to create share link', details: String(err) });
    }
  });

  app.get('/api/share/:token', async (req, res) => {
    if (!shareLinks) return res.status(503).json({ error: 'Share links unavailable' });
    try {
      const resolved = await shareLinks.resolveToken(req.params.token);
      if (!resolved) return res.status(404).json({ error: 'Link not found or expired' });
      const all = await repo.list();
      const ws = all.find(w => w.id === resolved.workspaceId);
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ label: resolved.label, workspace: normalizeWorkspaceResults(ws) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load share', details: String(err) });
    }
  });

  app.get('/api/workspaces/:id/report', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      applyRepoScope(req);
      const ws = (await repo.list()).find(w => w.id === req.params.id);
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      const html = buildMeetReportHtml(ws);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="${ws.name.replace(/[^a-z0-9]/gi, '_')}-report.html"`);
      res.send(html);
    } catch (err) {
      res.status(500).json({ error: 'Report failed', details: String(err) });
    }
  });

  // --- Scoring presets -----------------------------------------------------
  //
  // Built-in rule sets come from core, where they are generated from
  // NCAA_FORMAT_RULESETS at module load. User rule sets are JSON files under
  // data/scoring_presets/. A built-in ALWAYS wins its id: the write routes reject
  // a built-in id outright, so a user file with one can only be a stale seed copy
  // that predates this rule, and serving it would let the picker and the engine
  // disagree about what, say, "nsisc" means.

  type UserPresetFile = { id: string; file: string; raw: Record<string, unknown> };

  /** Every user preset on disk. Throws on an unreadable file rather than hiding it. */
  function readUserPresetFiles(): UserPresetFile[] {
    if (!fs.existsSync(SCORING_PRESETS_DIR)) return [];
    const out: UserPresetFile[] = [];
    for (const file of fs.readdirSync(SCORING_PRESETS_DIR)) {
      if (!file.endsWith('.json')) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(SCORING_PRESETS_DIR, file), 'utf-8'));
      } catch (err) {
        throw new Error(
          `data/scoring_presets/${file} is not readable JSON: ${String(err)}. A scoring rule ` +
            `set that cannot be parsed is not a rule set — fix or remove the file.`
        );
      }
      const id = typeof raw.id === 'string' && raw.id ? raw.id : file.replace(/\.json$/, '');
      out.push({ id, file, raw });
    }
    return out;
  }

  function userPresetMeta(entry: UserPresetFile) {
    return {
      id: entry.id,
      label: typeof entry.raw.label === 'string' && entry.raw.label ? entry.raw.label : entry.id,
      description: typeof entry.raw.description === 'string' ? entry.raw.description : undefined,
      builtIn: false,
      group: 'Saved rule sets',
      conferenceMatches: Array.isArray(entry.raw.conferenceMatches)
        ? (entry.raw.conferenceMatches as string[])
        : undefined,
    };
  }

  /** Teach core's `presetIdForConference` about the saved rule sets. Built-ins still match first. */
  function refreshUserConferenceBindings(): void {
    try {
      setUserConferencePresetBindings(
        readUserPresetFiles()
          .filter(e => !isBuiltInScoringPresetId(e.id))
          .map(e => userPresetMeta(e))
      );
    } catch (err) {
      console.warn('[scoring-presets] conference bindings not refreshed:', String(err));
    }
  }
  refreshUserConferenceBindings();

  app.get('/api/scoring-presets', (_req, res) => {
    try {
      const onDisk = readUserPresetFiles();
      const shadowed = onDisk.filter(e => isBuiltInScoringPresetId(e.id));
      if (shadowed.length) {
        console.warn(
          `[scoring-presets] ignoring ${shadowed.map(e => e.file).join(', ')} — ` +
            `built-in rule sets are served from core and cannot be overridden on disk.`
        );
      }
      res.json([
        ...builtInScoringPresetMeta(),
        ...onDisk.filter(e => !isBuiltInScoringPresetId(e.id)).map(userPresetMeta),
      ]);
    } catch (err) {
      res.status(500).json({ error: 'Failed to list scoring presets', details: String(err) });
    }
  });

  app.get('/api/scoring-presets/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltInScoringPresetId(id)) {
      try {
        return res.json(settingsForBuiltInScoringPreset(id));
      } catch (err) {
        if (err instanceof HostPublishedTableRequiredError) {
          // Absent, not empty. Rule 7-4 leaves the table to the host, so there is
          // nothing to return and nothing may be invented in its place.
          return res.status(409).json({
            error: err.message,
            citation: err.citation,
            requiresHostPublishedTable: true,
          });
        }
        return res.status(500).json({ error: 'Failed to read preset', details: String(err) });
      }
    }
    const raw = loadScoringPresetFile(id);
    if (!raw) return res.status(404).json({ error: 'Preset not found' });
    res.json(stripPresetMeta(raw));
  });

  /** The flat on-disk shape: meta keys beside the settings, exactly as GET /:id serves it. */
  function presetFileContents(body: ScoringPresetWriteBody): Record<string, unknown> {
    return {
      id: body.id,
      label: body.label,
      ...(body.description ? { description: body.description } : {}),
      ...(body.conferenceMatches?.length ? { conferenceMatches: body.conferenceMatches } : {}),
      ...body.settings,
    };
  }

  function parsePresetWrite(req: express.Request, res: express.Response, urlId?: string) {
    const body = { ...(req.body ?? {}) } as Record<string, unknown>;
    if (urlId != null) {
      if (body.id != null && body.id !== urlId) {
        res.status(400).json({
          error: `Body id "${String(body.id)}" does not match the URL id "${urlId}".`,
        });
        return null;
      }
      body.id = urlId;
    }
    const parsed = scoringPresetWriteSchema.safeParse(body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: 'Invalid scoring preset', details: zodDetails(parsed.error) });
      return null;
    }
    if (isBuiltInScoringPresetId(parsed.data.id)) {
      res.status(409).json({
        error:
          `"${parsed.data.id}" is a built-in rule set. Built-ins are generated from the ` +
          `published rulebook and are immutable; save this under a different id.`,
      });
      return null;
    }
    return parsed.data;
  }

  app.post('/api/scoring-presets', (req, res) => {
    const body = parsePresetWrite(req, res);
    if (!body) return;
    const filePath = userPresetFilePath(body.id);
    if (fs.existsSync(filePath)) {
      return res
        .status(409)
        .json({ error: `A scoring preset with id "${body.id}" already exists.` });
    }
    try {
      fs.mkdirSync(SCORING_PRESETS_DIR, { recursive: true });
      fs.writeFileSync(filePath, `${JSON.stringify(presetFileContents(body), null, 2)}\n`, 'utf-8');
      refreshUserConferenceBindings();
      res.status(201).json({
        id: body.id,
        label: body.label,
        description: body.description,
        builtIn: false,
        group: 'Saved rule sets',
        conferenceMatches: body.conferenceMatches,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save the scoring preset', details: String(err) });
    }
  });

  app.put('/api/scoring-presets/:id', (req, res) => {
    const body = parsePresetWrite(req, res, req.params.id);
    if (!body) return;
    const filePath = userPresetFilePath(body.id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `No scoring preset with id "${body.id}".` });
    }
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(presetFileContents(body), null, 2)}\n`, 'utf-8');
      refreshUserConferenceBindings();
      res.json({
        id: body.id,
        label: body.label,
        description: body.description,
        builtIn: false,
        group: 'Saved rule sets',
        conferenceMatches: body.conferenceMatches,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save the scoring preset', details: String(err) });
    }
  });

  app.delete('/api/scoring-presets/:id', (req, res) => {
    const id = req.params.id;
    if (isBuiltInScoringPresetId(id)) {
      return res.status(409).json({
        error: `"${id}" is a built-in rule set and cannot be deleted.`,
      });
    }
    if (!USER_PRESET_ID_RE.test(id)) {
      return res.status(400).json({ error: `"${id}" is not a valid preset id.` });
    }
    const filePath = userPresetFilePath(id);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `No scoring preset with id "${id}".` });
    }
    try {
      fs.unlinkSync(filePath);
      refreshUserConferenceBindings();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete the scoring preset', details: String(err) });
    }
  });

  // Versioned cutline tables. The built-in dataset (compiled from core) is the
  // default version; additional/override versions hot-reload from data/cutlines/*.json.
  function listCutlineVersions(): string[] {
    const versions = new Set<string>([defaultCutlineVersion()]);
    if (fs.existsSync(CUTLINES_DIR)) {
      for (const f of fs.readdirSync(CUTLINES_DIR)) {
        if (f.endsWith('.json') && f !== 'index.json') versions.add(f.replace(/\.json$/, ''));
      }
    }
    return [...versions].sort().reverse();
  }

  /** Read the generated index each call so a re-extract is picked up without a restart. */
  function defaultCutlineVersion(): string {
    const indexFile = path.join(CUTLINES_DIR, 'index.json');
    if (fs.existsSync(indexFile)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
        if (typeof idx?.default === 'string' && idx.default) return idx.default;
      } catch {
        // Fall through to the constant — a malformed index must not take the API down.
      }
    }
    return FALLBACK_CUTLINE_VERSION;
  }

  app.get('/api/cutlines/versions', (_req, res) => {
    res.json({ versions: listCutlineVersions(), default: defaultCutlineVersion() });
  });

  app.get('/api/cutlines/:version?', (req, res) => {
    const version = req.params.version || defaultCutlineVersion();
    const safe = version.replace(/[^0-9a-zA-Z._-]/g, '');
    const filePath = path.join(CUTLINES_DIR, `${safe}.json`);
    if (fs.existsSync(filePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return res.json({ version: safe, cutlines: Array.isArray(data) ? data : data.cutlines ?? [] });
      } catch (err) {
        return res.status(500).json({ error: 'Failed to read cutlines version', details: String(err) });
      }
    }
    // Last resort: serve the compiled-in table. Core now loads from these same
    // JSON files, so this only helps if the data dir is missing entirely.
    if (safe === defaultCutlineVersion()) {
      return res.json({ version: safe, cutlines: builtinCutlines });
    }
    return res.status(404).json({ error: `Cutline version not found: ${safe}` });
  });

  app.get('/api/dev/build-info', (_req, res) => {
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
    res.json({
      commit,
      chartBuildEpoch: CHART_BUILD_EPOCH,
      chartArchitecture: 'ChartShell-ChartFrame-static',
    });
  });

  function mapAthleteRows(athletes: Record<string, unknown>[]): SwimmerResult[] {
    return athletes.map((a: Record<string, unknown>) => {
        const rankMatch = a.rank != null ? String(a.rank).match(/(\d+)/) : null;
        const parsedRank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
        const teamClock = (a.relay_team_time || a.finals_time || a.prelims_time) as string;
        const isRelay = Boolean(a.is_relay) || /\brelay\b/i.test(String(a.event || ''));
        return normalizeSwimmerResultRelayFields({
          id: uuidv4(),
          rank: parsedRank > 0 ? parsedRank : 0,
          name: String(a.name),
          classYear: (a.year as string) || 'UNKNOWN',
          team: String(a.team),
          time: teamClock || 'NT',
          prelimsTime: a.prelims_time as string,
          finalsTime: a.finals_time as string,
          roundSwam: a.round_swam as string,
          points: a.calculated_points === 'N/A' ? 'N/A' : Number(a.calculated_points) || 0,
          event: String(a.event),
          gender: a.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
          isRelay,
          isExhibition: a.is_exhibition as boolean,
          isTimeTrial: a.is_time_trial as boolean,
          relayNames: (a.relay_names as { name: string; year: string }[]) || [],
          relayLegIndex: a.relay_leg_index as number,
          relayLegStroke: a.relay_leg_stroke as SwimmerResult['relayLegStroke'],
          relayLegSplit: a.relay_leg_split as string,
          relayLegSplitDetail: a.relay_leg_split_detail as SwimmerResult['relayLegSplitDetail'],
          relayTeamSplits: a.relay_team_splits as SwimmerResult['relayTeamSplits'],
          relayTeamTime: isRelay ? teamClock : (a.relay_team_time as string),
          pdfPoints: a.pdf_points != null ? Number(a.pdf_points) : undefined,
        });
      });
  }

  function mapPsychRows(rows: Record<string, unknown>[]): SwimmerResult[] {
    return rows.map((a: Record<string, unknown>) => {
      const rankMatch = a.rank != null ? String(a.rank).match(/(\d+)/) : null;
      const parsedRank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
      const seedTime = String(a.time ?? a.finals_time ?? a.prelims_time ?? 'NT');
      const rawTeam = String(a.team);
      const expandedTeam = expandTeamAbbrev(rawTeam) ?? rawTeam;
      return {
        id: uuidv4(),
        rank: parsedRank > 0 ? parsedRank : 0,
        name: String(a.name),
        classYear: (a.year as string) || 'UNKNOWN',
        team: expandedTeam,
        time: seedTime,
        points: 0,
        event: String(a.event),
        gender: a.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
        isRelay: false,
        isExhibition: Boolean(a.is_exhibition),
        isTimeTrial: Boolean(a.is_time_trial),
        roundSwam: 'Psych Sheet',
        isPsychSheet: true,
      };
    });
  }

  async function runPdfParserRaw(tempFile: string, format: string): Promise<Record<string, unknown>[]> {
    const output = await runPythonScript(PDF_PARSER_SCRIPT, [tempFile, format]);
    const trimmed = output.trim();
    if (!trimmed) {
      throw new Error(
        'PDF parser returned no output. Check that Python/pdfplumber is installed (see server console).'
      );
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      throw new Error(`PDF parser returned invalid JSON: ${trimmed.slice(0, 200)}`);
    }
    if (!Array.isArray(parsedJson)) {
      const errObj = parsedJson as { error?: unknown };
      if (errObj?.error) throw new Error(String(errObj.error));
      throw new Error('PDF parser returned unexpected JSON shape');
    }
    return parsedJson as Record<string, unknown>[];
  }

  /**
   * Parse psych sheet via pdf_parser (same engine as meet PDF).
   * Auto mode tries divided → regular → auto and picks the highest-quality parse.
   */
  async function parsePsychPdfFile(tempFile: string, format: string): Promise<SwimmerResult[]> {
    const tried = new Set<string>();
    const candidates: { format: string; normalized: PsychAthleteRow[] }[] = [];
    let maxRawCount = 0;

    for (const attempt of psychParseFormatsToTry(format || 'auto')) {
      if (tried.has(attempt)) continue;
      tried.add(attempt);
      const raw = await runPdfParserRaw(tempFile, attempt);
      maxRawCount = Math.max(maxRawCount, raw.length);
      candidates.push({ format: attempt, normalized: normalizePsychAthleteRows(raw) });
    }

    const best = pickBestPsychParseCandidate(candidates);
    if (!best || best.normalized.length === 0) {
      if (maxRawCount > 0) {
        throw new Error(
          `Parsed ${maxRawCount} PDF rows but found no individual psych seed times. Relays are skipped; try Regular or Divided format.`
        );
      }
      throw new Error('No swimmer rows found in psych PDF — try Regular vs Divided format.');
    }

    if ((format || 'auto') === 'auto' && candidates.length > 1) {
      const ranked = candidates
        .map(c => ({ format: c.format, rows: c.normalized.length, score: scorePsychParseQuality(c.normalized) }))
        .sort((a, b) => b.score - a.score);
      console.log('Psych PDF format auto-detect:', ranked, '→', best.format);
    }

    return mapPsychRows(best.normalized);
  }

  /** Unified pipeline: one Python process returns athletes + conference + team scores. */
  async function parseMeetUnified(tempFile: string, format: string) {
    const output = await runPythonScript(PARSE_MEET_SCRIPT, [tempFile, format]);
    const parsed = JSON.parse(output.trim());
    if (parsed.error) throw new Error(parsed.error);
    const athletes = Array.isArray(parsed.athletes) ? parsed.athletes : [];
    return {
      results: mapAthleteRows(athletes),
      conference: typeof parsed.conference === 'string' ? parsed.conference : undefined,
      officialTeamScores: parsed.officialTeamScores ?? undefined,
    };
  }

  /** Legacy fallback: three separate subprocesses (kept until unified path is fully verified). */
  async function parseMeetLegacy(tempFile: string, format: string) {
    const parserOutput = await runPythonScript(PDF_PARSER_SCRIPT, [tempFile, format]);
    try {
      const parsedJson = JSON.parse(parserOutput.trim());
      if (!Array.isArray(parsedJson) && parsedJson.error) {
        throw new Error(parsedJson.error);
      }
    } catch (err) {
      if (err instanceof Error && err.message && !err.message.startsWith('Unexpected')) throw err;
    }
    const calcOutput = await runPythonScript(POINT_CALCULATOR_SCRIPT, [], parserOutput);
    const athletes = JSON.parse(calcOutput);
    if (!Array.isArray(athletes)) throw new Error('Points calculation failed');
    const conference =
      athletes.length > 0 && typeof athletes[0].conference === 'string'
        ? athletes[0].conference
        : undefined;
    let officialTeamScores;
    try {
      const rankingsOutput = await runPythonScript(TEAM_RANKINGS_SCRIPT, [tempFile]);
      const rankingsJson = JSON.parse(rankingsOutput.trim());
      if (!rankingsJson.error) {
        officialTeamScores = {
          eventThrough: rankingsJson.eventThrough,
          men: rankingsJson.men ?? {},
          women: rankingsJson.women ?? {},
        };
      }
    } catch {
      /* optional */
    }
    return { results: mapAthleteRows(athletes), conference, officialTeamScores };
  }

  app.post('/api/parse-pdf', async (req, res) => {
    const parsed = parsePdfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid PDF payload', details: parsed.error.issues });
    }
    const { base64, format } = parsed.data;
    const tempFile = path.join(PROJECT_ROOT, `temp_${Date.now()}.pdf`);
    try {
      fs.writeFileSync(tempFile, Buffer.from(base64, 'base64'));
      const fmt = format || 'auto';
      let payload;
      try {
        payload = await parseMeetUnified(tempFile, fmt);
      } catch (unifiedErr) {
        console.warn('Unified parse_meet failed, falling back to legacy pipeline:', unifiedErr);
        payload = await parseMeetLegacy(tempFile, fmt);
      }
      res.json(payload);
    } catch (error) {
      res.status(500).json({ error: 'Failed to parse PDF', details: String(error) });
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  app.post('/api/parse-psych-pdf', async (req, res) => {
    const parsed = parsePsychPdfSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid psych PDF payload', details: parsed.error.issues });
    }
    const { base64, format } = parsed.data;
    if (!base64?.trim()) {
      return res.status(400).json({ error: 'No PDF data in request' });
    }
    const tempFile = path.join(PROJECT_ROOT, `temp_psych_${Date.now()}.pdf`);
    try {
      fs.writeFileSync(tempFile, Buffer.from(base64, 'base64'));
      const fmt = format || 'auto';
      let results: SwimmerResult[];
      try {
        results = await parsePsychPdfFile(tempFile, fmt);
      } catch (primaryErr) {
        console.warn('Psych parse via pdf_parser failed, trying psych_parser.py:', primaryErr);
        const output = await runPythonScript(PARSE_PSYCH_SCRIPT, [tempFile, fmt]);
        const trimmed = output.trim();
        if (!trimmed) {
          throw new Error('Psych parser returned empty output');
        }
        const parsedJson = JSON.parse(trimmed) as { error?: string; results?: Record<string, unknown>[] };
        if (parsedJson.error) {
          return res.status(500).json({ error: parsedJson.error });
        }
        const rawRows = Array.isArray(parsedJson.results) ? parsedJson.results : [];
        results = mapPsychRows(rawRows);
      }
      if (results.length === 0) {
        return res.status(422).json({
          error: 'No individual psych entries found',
          details: 'Try Regular List or Divided (2-Col) format from the dropdown.',
        });
      }
      return res.json({ results });
    } catch (error) {
      return res.status(500).json({ error: 'Failed to parse psych PDF', details: String(error) });
    } finally {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    }
  });

  app.post('/api/parse-athlete-history', async (req, res) => {
    const validated = parseAthleteHistorySchema.safeParse(req.body ?? {});
    if (!validated.success) {
      return res.status(400).json({ error: 'Invalid request', details: validated.error.issues });
    }
    try {
      const { text, imageBase64, team, gender, swimmerName, division } = validated.data;
      const g = gender === Gender.WOMEN || gender === 'Women' ? Gender.WOMEN : Gender.MEN;
      const teamName = typeof team === 'string' && team.trim() ? team.trim() : 'Unknown';
      const div = division === 'D2' || division === 'D3' || division === 'NAIA' ? division : 'D1';
      if (typeof text === 'string' && text.trim()) {
        const result = parseSwimCloudPasteDetailed(text, {
          team: teamName,
          gender: g,
          swimmerName: typeof swimmerName === 'string' ? swimmerName : undefined,
          division: div,
        });
        return res.json(result);
      }
      if (typeof imageBase64 === 'string' && imageBase64.trim() && AI_ENABLED && process.env.GEMINI_API_KEY) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let GoogleGenAI: any;
        try {
          // @ts-expect-error — @google/genai is an optional runtime dep; omitted from package.json intentionally
          ({ GoogleGenAI } = await import('@google/genai'));
        } catch {
          return res.status(501).json({ error: 'AI image parsing is not installed in this build' });
        }
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        const response = await ai.models.generateContent({
          model: 'gemini-2.0-flash',
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'Extract swimmer rows as JSON array: [{name, event, time}]. No markdown.' },
                { inlineData: { mimeType: 'image/png', data: imageBase64 } },
              ],
            },
          ],
        });
        const raw = response.text ?? '[]';
        const jsonMatch = raw.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : '[]');
        const swims = (Array.isArray(parsed) ? parsed : []).map((row: Record<string, string>) => ({
          name: String(row.name ?? ''),
          team: teamName,
          gender: g,
          event: String(row.event ?? ''),
          time: String(row.time ?? ''),
          source: 'ocr' as const,
        }));
        return res.json({ swims: swims.filter((s: { name: string; event: string }) => s.name && s.event) });
      }
      return res.status(400).json({
        error: AI_ENABLED
          ? 'Provide pasted text, or imageBase64 with GEMINI_API_KEY'
          : 'Image parsing is disabled. Provide pasted text or set OMNI_AI_ENABLED=true with GEMINI_API_KEY.',
      });
    } catch (err) {
      return res.status(500).json({ error: 'Parse failed', details: String(err) });
    }
  });

  // No upload middleware is mounted: the handler returns 501 and does nothing
  // with a file, but multer writes to disk BEFORE the handler runs, so mounting
  // it accepted an unauthenticated write from anyone who could reach the port.
  // Re-enable via createVideoUpload() when the feature is actually implemented.
  app.post('/api/analyze-video', async (_req, res) => {
    res.status(501).json({
      error: 'Gemini video analysis reserved for a future release. Use local metrics in the Metrics applet.',
    });
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
