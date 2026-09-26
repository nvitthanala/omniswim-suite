/**
 * Workspace CRUD, backups, snapshots, share links and the printable report —
 * every route in `server.ts`'s `startServer` that reads or writes through
 * `WorkspaceRepo`.
 *
 * Extracted for H2 (code-health refactor, 2026-09-25) with no behavior
 * change: same paths, methods, middleware order, and error handling as
 * before. Registration order relative to the other route modules is
 * unchanged in `server.ts`.
 */
import type { Express, RequestHandler } from 'express';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Workspace, ScoringSettings } from '../../../../packages/core/src/types.ts';
import { normalizeSwimmerResultRelayFields } from '../../../../packages/core/src/lib/relaySplits.ts';
import {
  createWorkspaceSchema,
  updateWorkspaceSchema,
} from '../../../../packages/core/src/schemas/workspace.ts';
import { buildMeetReportHtml } from '../../../../packages/core/src/lib/reportBuilder.ts';
import type { WorkspaceRepo } from '../workspaceRepo.ts';
import { applyWorkspaceUpdateWithGuard } from '../dataLossGuard.ts';
import type { AuthedRequest } from '../authMiddleware.ts';
import type { AuthService, ShareLinkService } from '../../../../packages/db/src/AuthService.ts';

export interface WorkspaceRoutesDeps {
  repo: WorkspaceRepo;
  auth: AuthService | null;
  shareLinks: ShareLinkService | null;
  AUTH_REQUIRED: boolean;
  requireAuth: RequestHandler;
  optionalAuth: RequestHandler;
  defaultScoringSettings: ScoringSettings;
}

/**
 * Registers every workspace-data route in three cohesive groups (CRUD, backups
 * and snapshots, share links and the printable report). Split only to keep
 * each function under the repo's line-count ceiling — registration order is
 * unchanged, and every group shares `applyRepoScope`/`normalizeWorkspaceResults`.
 */
export function registerWorkspaceRoutes(app: Express, deps: WorkspaceRoutesDeps): void {
  const { repo } = deps;

  function applyRepoScope(req: AuthedRequest): void {
    if (req.user && repo.setScope) {
      repo.setScope({ ownerId: req.user.id, teamId: req.user.teamId });
    }
  }

  function normalizeWorkspaceResults(ws: Workspace): Workspace {
    return {
      ...ws,
      menResults: (ws.menResults || []).map(normalizeSwimmerResultRelayFields),
      womenResults: (ws.womenResults || []).map(normalizeSwimmerResultRelayFields),
    };
  }

  registerWorkspaceCrudRoutes(app, deps, applyRepoScope, normalizeWorkspaceResults);
  registerWorkspaceBackupAndSnapshotRoutes(app, deps, applyRepoScope);
  registerWorkspaceShareAndReportRoutes(app, deps, applyRepoScope, normalizeWorkspaceResults);
}

function registerWorkspaceCrudRoutes(
  app: Express,
  deps: WorkspaceRoutesDeps,
  applyRepoScope: (req: AuthedRequest) => void,
  normalizeWorkspaceResults: (ws: Workspace) => Workspace
): void {
  const { repo, AUTH_REQUIRED, requireAuth, optionalAuth, defaultScoringSettings } = deps;

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
      const patch = parsed.data as Partial<Workspace>;

      // Data-loss guard (2026-09-22 incident): a save that sharply shrinks
      // menResults/womenResults/athleteHistory gets a `pre-shrink` backup
      // BEFORE the write, and the response says so. This never blocks the
      // save — a coach's deliberate trim must still go through — it only
      // makes sure a silent wipe is never silent again. See
      // `apps/shell/lib/dataLossGuard.ts` for the detection rule and the
      // best-effort backup handling.
      const { updated, dataLossWarning } = await applyWorkspaceUpdateWithGuard(
        repo,
        req.params.id,
        patch,
        expectedVersion
      );
      if (dataLossWarning?.backupError) {
        console.warn('Pre-shrink backup failed; saving anyway:', dataLossWarning.backupError);
      }
      if (!updated) return res.status(404).json({ error: 'Workspace not found' });
      res.json(dataLossWarning ? { ...updated, dataLossWarning } : updated);
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
}

function registerWorkspaceBackupAndSnapshotRoutes(
  app: Express,
  deps: WorkspaceRoutesDeps,
  applyRepoScope: (req: AuthedRequest) => void
): void {
  const { repo, AUTH_REQUIRED, requireAuth, optionalAuth } = deps;

  app.get('/api/workspaces/backups', AUTH_REQUIRED ? requireAuth : optionalAuth, async (_req: AuthedRequest, res) => {
    try {
      res.json(await repo.listBackups());
    } catch (err) {
      res.status(500).json({ error: 'Could not list backups', details: String(err) });
    }
  });

  /**
   * Replace every workspace with the contents of one backup.
   *
   * The body names a file, so this is where a hostile name has to be refused.
   * `restoreBackup` resolves it through `resolveBackupPath`, which requires the
   * name to match the pattern this app's own writer produces, to survive
   * `path.basename` unchanged, and to resolve inside the backup directory.
   * A refusal is a 400 naming the file, never a 500 with a stack.
   */
  app.post('/api/workspaces/restore', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    const file = (req.body ?? {}).file;
    if (typeof file !== 'string' || file.length === 0) {
      return res.status(400).json({ error: 'A backup file name is required.' });
    }
    try {
      applyRepoScope(req);
      const restored = await repo.restoreBackup(file);
      res.json({ success: true, file, workspaces: restored });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A rejected name and a corrupt file are both the caller's problem, not a
      // server fault; anything else is ours.
      const isCallerError = /Not a backup this app wrote|Backup file/.test(message);
      res.status(isCallerError ? 400 : 500).json({ error: 'Restore failed', details: message });
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
}

function registerWorkspaceShareAndReportRoutes(
  app: Express,
  deps: WorkspaceRoutesDeps,
  applyRepoScope: (req: AuthedRequest) => void,
  normalizeWorkspaceResults: (ws: Workspace) => Workspace
): void {
  const { repo, shareLinks, AUTH_REQUIRED, requireAuth, optionalAuth } = deps;

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
}
