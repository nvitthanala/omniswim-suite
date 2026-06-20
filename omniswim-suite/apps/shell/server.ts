/**
 * Unified Omni Swim Suite server (Matrix API + Metrics video route).
 */
import express from 'express';
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
  parseAthleteHistorySchema,
} from '../../packages/core/src/schemas/workspace.ts';
import { JsonRepo, SqliteRepo, PgRepo, type WorkspaceRepo } from './lib/workspaceRepo.ts';
import {
  createAuthMiddleware,
  getSessionToken,
  setSessionCookie,
  clearSessionCookie,
  type AuthedRequest,
} from './lib/authMiddleware.ts';
import { AuthService, ShareLinkService } from '../../packages/db/src/AuthService.ts';
import { buildMeetReportHtml } from '../../packages/core/src/lib/reportBuilder.ts';
import { cutlines as builtinCutlines } from '../../packages/core/src/cutlines.ts';

const PORT = 3000;
const __filename = fileURLToPath(import.meta.url);
const SHELL_ROOT = path.dirname(__filename);
const PROJECT_ROOT = path.join(SHELL_ROOT, '../..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const MEETS_FILE = path.join(DATA_DIR, 'meets.json');
const DB_FILE = path.join(DATA_DIR, 'omniswim.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const STORAGE_BACKEND = (process.env.OMNI_DB ?? 'sqlite').toLowerCase();
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const AUTH_REQUIRED = process.env.OMNI_AUTH_REQUIRED === 'true' || STORAGE_BACKEND === 'postgres';
const SCORING_PRESETS_DIR = path.join(DATA_DIR, 'scoring_presets');
const CUTLINES_DIR = path.join(DATA_DIR, 'cutlines');
const BUILTIN_CUTLINE_VERSION = '2025-2026';
const SCORING_SETTINGS_FILE = path.join(DATA_DIR, 'scoring_settings.json');
const AI_ENABLED = process.env.OMNI_AI_ENABLED === 'true';
const PARSE_MEET_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'parse_meet.py');
const PDF_PARSER_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'pdf_parser.py');
const POINT_CALCULATOR_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'point_calculator.py');
const TEAM_RANKINGS_SCRIPT = path.join(PROJECT_ROOT, 'backend', 'team_rankings_parser.py');

const PRESET_META_KEYS = new Set(['id', 'label', 'description']);

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

function loadDefaultScoringSettings(): ScoringSettings {
  const generic = loadScoringPresetFile('generic-top16');
  if (generic) return stripPresetMeta(generic) as unknown as ScoringSettings;
  if (fs.existsSync(SCORING_SETTINGS_FILE)) {
    return JSON.parse(fs.readFileSync(SCORING_SETTINGS_FILE, 'utf-8')) as ScoringSettings;
  }
  return {
    scoringPoints: [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1],
    relayMultiplier: 2,
    halfRateRelaySwimmer: true,
    maxIndividualScorersPerTeam: 999,
    maxRelaysScoringPerTeam: 999,
    aFinalBracketSize: 8,
    scorerCapScope: 'event',
    diverScorerWeight: 1,
    relayEligibleFromScorerPool: false,
    maxIndividualEntriesPerSwimmer: 999,
    maxRelayEntriesPerSwimmer: 999,
  };
}

const defaultScoringSettings = loadDefaultScoringSettings();

async function runPythonScript(scriptPath: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const venvPython =
      process.platform === 'win32'
        ? path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe')
        : path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';

    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, OMNI_PROJECT_ROOT: PROJECT_ROOT, OMNI_DATA_DIR: DATA_DIR },
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
      else resolve(output);
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

async function startServer() {
  try {
    ensurePythonVenv();
  } catch (err) {
    console.warn('Python venv setup warning:', err);
  }

  const app = express();
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

  const optionalAuth = createAuthMiddleware(auth, false);
  const requireAuth = createAuthMiddleware(auth, true);

  function applyRepoScope(req: AuthedRequest): void {
    if (req.user && repo.setScope) {
      repo.setScope({ ownerId: req.user.id, teamId: req.user.teamId });
    }
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

  app.get('/api/scoring-presets', (_req, res) => {
    if (!fs.existsSync(SCORING_PRESETS_DIR)) return res.json([]);
    const files = fs.readdirSync(SCORING_PRESETS_DIR).filter(f => f.endsWith('.json'));
    res.json(
      files.map(f => {
        const raw = JSON.parse(fs.readFileSync(path.join(SCORING_PRESETS_DIR, f), 'utf-8'));
        const id = raw.id || f.replace(/\.json$/, '');
        return { id, label: raw.label || id, description: raw.description };
      })
    );
  });

  app.get('/api/scoring-presets/:id', (req, res) => {
    const raw = loadScoringPresetFile(req.params.id);
    if (!raw) return res.status(404).json({ error: 'Preset not found' });
    res.json(stripPresetMeta(raw));
  });

  // Versioned cutline tables. The built-in dataset (compiled from core) is the
  // default version; additional/override versions hot-reload from data/cutlines/*.json.
  function listCutlineVersions(): string[] {
    const versions = new Set<string>([BUILTIN_CUTLINE_VERSION]);
    if (fs.existsSync(CUTLINES_DIR)) {
      for (const f of fs.readdirSync(CUTLINES_DIR)) {
        if (f.endsWith('.json') && f !== 'index.json') versions.add(f.replace(/\.json$/, ''));
      }
    }
    return [...versions].sort().reverse();
  }

  app.get('/api/cutlines/versions', (_req, res) => {
    res.json({ versions: listCutlineVersions(), default: BUILTIN_CUTLINE_VERSION });
  });

  app.get('/api/cutlines/:version?', (req, res) => {
    const version = req.params.version || BUILTIN_CUTLINE_VERSION;
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
    if (safe === BUILTIN_CUTLINE_VERSION) {
      return res.json({ version: BUILTIN_CUTLINE_VERSION, cutlines: builtinCutlines });
    }
    return res.status(404).json({ error: `Cutline version not found: ${safe}` });
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

  const uploadDir = path.join(PROJECT_ROOT, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
    }),
  });

  app.post('/api/analyze-video', upload.single('video'), async (_req, res) => {
    res.status(501).json({
      error: 'Gemini video analysis reserved for a future release. Use local metrics in the Metrics applet.',
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      configFile: path.join(SHELL_ROOT, 'vite.config.ts'),
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(PROJECT_ROOT, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(PROJECT_ROOT, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Omni Swim Suite running at http://localhost:${PORT}`);
  });
}

startServer();
