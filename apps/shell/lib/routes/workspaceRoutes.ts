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
import type { Express, RequestHandler, Response } from 'express';
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
import { applyWorkspaceUpdateWithGuard, type WorkspaceUpdateRepo } from '../dataLossGuard.ts';
import { SaveSequencer, parseSaveToken } from '../saveSequencer.ts';
import {
  DUPLICATE_WORKSPACE_ID_CODE,
  EXPECTED_VERSION_HEADER,
  SAVE_UNCHECKED_HEADER,
  STALE_SAVE_CODE,
  VERSION_CONFLICT_CODE,
} from '../../../../packages/core/src/api/saveSequence.ts';
import type { AuthedRequest } from '../authMiddleware.ts';
import type { AuthService, ShareLinkService } from '../../../../packages/db/src/AuthService.ts';
import type { WorkspaceScope } from '../../../../packages/db/src/workspacePersistence.ts';

export interface WorkspaceRoutesDeps {
  repo: WorkspaceRepo;
  auth: AuthService | null;
  shareLinks: ShareLinkService | null;
  AUTH_REQUIRED: boolean;
  requireAuth: RequestHandler;
  optionalAuth: RequestHandler;
  defaultScoringSettings: ScoringSettings;
  /** Optional: tests inject one to inspect it. Production gets a private instance. */
  saveSequencer?: SaveSequencer;
  /**
   * Who may list backups and restore one, when `AUTH_REQUIRED`. Defaults to nobody.
   *
   * A restore replaces EVERY workspace of EVERY user, and a backup file is not tagged
   * with the tenant that wrote it, so neither is a per-user operation. The app has no
   * administrator concept yet (`AuthUser` has no role, and every account owns its own
   * team), so until the server wires one in, these two routes answer 403 under
   * `AUTH_REQUIRED`. Without `AUTH_REQUIRED` the instance is single-tenant and they
   * behave as they always did.
   */
  isAdmin?: (req: AuthedRequest) => boolean;
}

/** The tenant a request acts as. Empty (everything) only when there is no signed-in user. */
export function workspaceScopeOf(req: AuthedRequest): WorkspaceScope {
  return req.user ? { ownerId: req.user.id, teamId: req.user.teamId } : {};
}

/**
 * The slice of the repo the data-loss guard calls, bound to one request's scope.
 * The guard predates per-call scope and takes `list()`/`backup()`/`update()` bare, so
 * it gets this adapter rather than the shared repo.
 */
function scopedUpdateRepo(repo: WorkspaceRepo, scope: WorkspaceScope): WorkspaceUpdateRepo {
  return {
    list: () => repo.list(scope),
    backup: label => repo.backup(label, scope),
    update: (id, patch, expectedVersion) => repo.update(id, patch, expectedVersion, scope),
  };
}

const EXPECTED_VERSION_PATTERN = /^[1-9]\d{0,14}$/;

type ExpectedVersion = { kind: 'none' } | { kind: 'ok'; version: number } | { kind: 'invalid'; reason: string };

/**
 * The version the caller says it last saw. The header is the contract; a numeric
 * `version` in the body is the older spelling and still counts. A malformed header
 * is refused rather than ignored: ignoring it would turn a checked save into an
 * unchecked one without anyone knowing.
 */
function readExpectedVersion(req: AuthedRequest): ExpectedVersion {
  const raw = req.headers[EXPECTED_VERSION_HEADER.toLowerCase()];
  if (raw !== undefined) {
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    if (!EXPECTED_VERSION_PATTERN.test(value)) {
      return { kind: 'invalid', reason: `${EXPECTED_VERSION_HEADER} must be a positive integer` };
    }
    return { kind: 'ok', version: Number(value) };
  }
  const body = req.body?.version;
  if (typeof body === 'number' && Number.isInteger(body) && body >= 1) return { kind: 'ok', version: body };
  return { kind: 'none' };
}

function errorCode(err: unknown): string | undefined {
  return err instanceof Error ? (err as Error & { code?: string }).code : undefined;
}

/**
 * Registers every workspace-data route in three cohesive groups (CRUD, backups
 * and snapshots, share links and the printable report). Split only to keep
 * each function under the repo's line-count ceiling — registration order is
 * unchanged, and every group scopes each call with `workspaceScopeOf(req)`.
 */
export function registerWorkspaceRoutes(app: Express, deps: WorkspaceRoutesDeps): void {
  function normalizeWorkspaceResults(ws: Workspace): Workspace {
    return {
      ...ws,
      menResults: (ws.menResults || []).map(normalizeSwimmerResultRelayFields),
      womenResults: (ws.womenResults || []).map(normalizeSwimmerResultRelayFields),
    };
  }

  registerWorkspaceCrudRoutes(app, deps, normalizeWorkspaceResults);
  registerWorkspaceBackupAndSnapshotRoutes(app, deps);
  registerWorkspaceShareAndReportRoutes(app, deps, normalizeWorkspaceResults);
}

function registerWorkspaceCrudRoutes(
  app: Express,
  deps: WorkspaceRoutesDeps,
  normalizeWorkspaceResults: (ws: Workspace) => Workspace
): void {
  const { repo, AUTH_REQUIRED, requireAuth, optionalAuth, defaultScoringSettings } = deps;
  const sequencer = deps.saveSequencer ?? new SaveSequencer();
  /** Per user and workspace: two tenants never share a recorded sequence. */
  const sequenceKey = (req: AuthedRequest) => `${req.user?.id ?? ''}|${req.params.id}`;
  const uncheckedWarned = new Set<string>();
  const droppedKeysWarned = new Set<string>();

  app.get('/api/workspaces', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      const data = await repo.list(workspaceScopeOf(req));
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
    // `version` is the store's, not the client's: a restored workspace arrives carrying
    // the revision it had, which must not become the new document's revision.
    const { version: _clientVersion, ...body } = parsed.data as Record<string, unknown> & Partial<Workspace>;
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
      const created = await repo.create(newWorkspace, workspaceScopeOf(req));
      res.json(created);
    } catch (err) {
      if (errorCode(err) === DUPLICATE_WORKSPACE_ID_CODE) {
        return res.status(409).json({
          error: 'A workspace with this id already exists.',
          code: DUPLICATE_WORKSPACE_ID_CODE,
        });
      }
      res.status(500).json({ error: 'Failed to create workspace', details: String(err) });
    }
  });

  app.put('/api/workspaces/:id', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    const parsed = updateWorkspaceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid workspace patch', details: parsed.error.issues });
    }
    const expected = readExpectedVersion(req);
    if (expected.kind === 'invalid') {
      return res
        .status(400)
        .json({ error: 'Invalid expected version', code: 'BAD_EXPECTED_VERSION', details: expected.reason });
    }
    const expectedVersion = expected.kind === 'ok' ? expected.version : undefined;
    // Out-of-order save protection. A malformed sequence is a client bug and is
    // refused loudly; an absent one is an old client or a script and still saves.
    const sequence = parseSaveToken(req.headers);
    if (sequence.kind === 'invalid') {
      return res
        .status(400)
        .json({ error: 'Invalid save sequence headers', code: 'BAD_SAVE_SEQUENCE', details: sequence.reason });
    }
    try {
      const patch = parsed.data as Partial<Workspace>;
      // The allowlist drops what it does not know. Say so, once per key, so a field
      // the schema missed shows up in the log instead of vanishing.
      for (const key of Object.keys(req.body ?? {})) {
        if (!(key in patch) && !['id', 'version', 'createdAt'].includes(key) && !droppedKeysWarned.has(key)) {
          droppedKeysWarned.add(key);
          console.warn(`PUT /api/workspaces/:id ignored unknown field "${key}".`);
        }
      }
      // Scope per call, never through shared repo state: this request may wait behind
      // another user's save on the same workspace, and must still act as ITS user.
      const scope = workspaceScopeOf(req);

      // Runs under a per-workspace lock, in arrival order.
      const outcome = await sequencer.run(
        sequenceKey(req),
        sequence.kind === 'ok' ? sequence.token : undefined,
        async () => {
          // Data-loss guard (2026-09-22 incident): a save that sharply shrinks
          // menResults/womenResults/athleteHistory gets a `pre-shrink` backup
          // BEFORE the write, and the response says so. This never blocks the
          // save — a coach's deliberate trim must still go through — it only
          // makes sure a silent wipe is never silent again. See
          // `apps/shell/lib/dataLossGuard.ts` for the detection rule and the
          // best-effort backup handling. A stale save is refused before it gets
          // here, so it can never cost a backup slot.
          return applyWorkspaceUpdateWithGuard(
            scopedUpdateRepo(repo, scope),
            req.params.id,
            patch,
            expectedVersion
          );
        },
        result => result.updated !== undefined
      );

      if (outcome.status === 'stale') {
        console.warn(
          `Refused a stale save for workspace ${req.params.id}: sequence ${outcome.receivedSeq} <= applied ${outcome.lastAppliedSeq}`
        );
        return res.status(409).json({
          error: 'This save was superseded by a newer one and was not applied.',
          code: STALE_SAVE_CODE,
          lastAppliedSeq: outcome.lastAppliedSeq,
          receivedSeq: outcome.receivedSeq,
        });
      }
      const { updated, dataLossWarning } = outcome.value;
      if (dataLossWarning?.backupError) {
        console.warn('Pre-shrink backup failed; saving anyway:', dataLossWarning.backupError);
      }
      if (!updated) return res.status(404).json({ error: 'Workspace not found' });
      if (outcome.unchecked) {
        // Flag it, once per workspace, so a client that forgot the headers shows up in the log.
        res.setHeader(SAVE_UNCHECKED_HEADER, 'no-sequence');
        if (!uncheckedWarned.has(req.params.id)) {
          uncheckedWarned.add(req.params.id);
          console.warn(
            `PUT /api/workspaces/${req.params.id} had no save sequence; out-of-order arrival cannot be detected for it.`
          );
        }
      }
      res.json(dataLossWarning ? { ...updated, dataLossWarning } : updated);
    } catch (err) {
      if (errorCode(err) === VERSION_CONFLICT_CODE) {
        return res
          .status(409)
          .json({ error: 'Version conflict — refresh and retry', code: VERSION_CONFLICT_CODE });
      }
      res.status(500).json({ error: 'Failed to update workspace', details: String(err) });
    }
  });

  app.delete('/api/workspaces/:id', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      const scope = workspaceScopeOf(req);
      // Back up before the only irreversible workspace operation there is.
      // Deliberately best-effort: a backup that cannot be written must not
      // block a delete the user asked for, but it must say so loudly rather
      // than failing silently.
      try {
        await repo.backup('pre-delete', scope);
      } catch (backupErr) {
        console.warn('Pre-delete backup failed; deleting anyway:', backupErr);
      }
      await repo.remove(req.params.id, scope);
      sequencer.forget(sequenceKey(req));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to delete workspace', details: String(err) });
    }
  });
}

function registerWorkspaceBackupAndSnapshotRoutes(app: Express, deps: WorkspaceRoutesDeps): void {
  const { repo, AUTH_REQUIRED, requireAuth, optionalAuth } = deps;
  const isAdmin = deps.isAdmin ?? (() => false);
  /** Under AUTH_REQUIRED the backup directory is shared by every tenant: administrators only. */
  const mayUseSharedBackups = (req: AuthedRequest) => !AUTH_REQUIRED || isAdmin(req);
  const refuseSharedBackups = (res: Response) =>
    res.status(403).json({
      error: 'Backups hold every user data and are limited to administrators.',
      code: 'ADMIN_REQUIRED',
    });

  app.get('/api/workspaces/backups', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    if (!mayUseSharedBackups(req)) return refuseSharedBackups(res);
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
    // Checked first: a refusal must not depend on what the body says.
    if (!mayUseSharedBackups(req)) return refuseSharedBackups(res);
    const file = (req.body ?? {}).file;
    if (typeof file !== 'string' || file.length === 0) {
      return res.status(400).json({ error: 'A backup file name is required.' });
    }
    try {
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
      const file = await repo.backup('manual', workspaceScopeOf(req));
      res.json({ success: true, file: path.basename(file) });
    } catch (err) {
      res.status(500).json({ error: 'Backup failed', details: String(err) });
    }
  });

  // Workspace snapshots (SQLite backend only; JSON backend returns empty/no-op).
  app.post('/api/workspaces/:id/snapshots', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      const label = typeof req.body?.label === 'string' ? req.body.label : 'snapshot';
      const snap = await repo.snapshot(req.params.id, label, workspaceScopeOf(req));
      if (!snap) return res.status(400).json({ error: 'Snapshots require SQLite or PostgreSQL backend' });
      res.json(snap);
    } catch (err) {
      res.status(500).json({ error: 'Snapshot failed', details: String(err) });
    }
  });

  app.get('/api/workspaces/:id/snapshots', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      res.json(await repo.listSnapshots(req.params.id, workspaceScopeOf(req)));
    } catch (err) {
      res.status(500).json({ error: 'Failed to list snapshots', details: String(err) });
    }
  });

  // Read-only snapshot content (diff drill-down) — never restores.
  app.get('/api/snapshots/:snapshotId', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      if (repo.kind === 'json') {
        return res.status(400).json({ error: 'Snapshots require SQLite or PostgreSQL backend' });
      }
      const content = await repo.getSnapshotContent(req.params.snapshotId, workspaceScopeOf(req));
      if (!content) return res.status(404).json({ error: 'Snapshot not found' });
      res.json(content);
    } catch (err) {
      res.status(500).json({ error: 'Failed to read snapshot', details: String(err) });
    }
  });

  app.post('/api/snapshots/:snapshotId/restore', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      const restored = await repo.restoreSnapshot(req.params.snapshotId, workspaceScopeOf(req));
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
  normalizeWorkspaceResults: (ws: Workspace) => Workspace
): void {
  const { repo, shareLinks, AUTH_REQUIRED, requireAuth, optionalAuth } = deps;

  // Shareable read-only links + printable reports
  app.post('/api/workspaces/:id/share', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    if (!shareLinks || !req.user) {
      return res.status(503).json({ error: 'Share links require PostgreSQL auth backend' });
    }
    try {
      const ws = (await repo.list(workspaceScopeOf(req))).find(w => w.id === req.params.id);
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
      // The link's own tenant, not "whatever the repo was last set to": a token is
      // anonymous, so nothing in the request says whose workspace it should reach.
      // A link with no recorded tenant (older rows) cannot be scoped; refuse it
      // rather than search every tenant's data for the id.
      const shareScope: WorkspaceScope | null = resolved.teamId
        ? { teamId: resolved.teamId }
        : resolved.createdBy
          ? { ownerId: resolved.createdBy }
          : null;
      if (!shareScope) {
        return res.status(404).json({ error: 'Workspace not found' });
      }
      const all = await repo.list(shareScope);
      const ws = all.find(w => w.id === resolved.workspaceId);
      if (!ws) return res.status(404).json({ error: 'Workspace not found' });
      res.json({ label: resolved.label, workspace: normalizeWorkspaceResults(ws) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load share', details: String(err) });
    }
  });

  app.get('/api/workspaces/:id/report', AUTH_REQUIRED ? requireAuth : optionalAuth, async (req: AuthedRequest, res) => {
    try {
      const ws = (await repo.list(workspaceScopeOf(req))).find(w => w.id === req.params.id);
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
