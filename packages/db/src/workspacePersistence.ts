/**
 * Shared workspace assembly / child-table persistence helpers used by SQLite and PostgreSQL services.
 */
import type { Workspace, SwimmerResult } from '@omniswim/core/types';

export type Json = unknown;

export const CHILD_TABLES = [
  'meet_results',
  'source_meet_results',
  'psych_results',
  'recruits',
  'roster_overrides',
  'meet_entry_plans',
  'relay_leg_overrides',
  'deleted_swimmers',
  'athlete_history',
  'race_analyses',
  'athlete_aliases',
  'relay_leg_credits',
] as const;

export type ChildTable = (typeof CHILD_TABLES)[number];

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function assembleWorkspace(
  row: Record<string, unknown>,
  childData: (table: string) => Json[]
): Workspace {
  const allResults = childData('meet_results') as SwimmerResult[];
  const menResults = allResults.filter(r => (r as { gender?: string }).gender !== 'Women');
  const womenResults = allResults.filter(r => (r as { gender?: string }).gender === 'Women');
  const allSource = childData('source_meet_results') as SwimmerResult[];
  const sourceMenResults = allSource.filter(r => (r as { gender?: string }).gender !== 'Women');
  const sourceWomenResults = allSource.filter(r => (r as { gender?: string }).gender === 'Women');
  const allPsych = childData('psych_results') as SwimmerResult[];
  const psychMenResults = allPsych.filter(r => (r as { gender?: string }).gender !== 'Women');
  const psychWomenResults = allPsych.filter(r => (r as { gender?: string }).gender === 'Women');

  const workspace: Workspace = {
    id: String(row.id),
    name: String(row.name ?? ''),
    createdAt: Number(row.created_at ?? Date.now()),
    menResults,
    womenResults,
    // Backfill: legacy rows without source copy use working results as baseline.
    sourceMenResults: sourceMenResults.length > 0 ? sourceMenResults : undefined,
    sourceWomenResults: sourceWomenResults.length > 0 ? sourceWomenResults : undefined,
    psychMenResults,
    psychWomenResults,
    recruits: childData('recruits') as Workspace['recruits'],
    deletedSwimmers: childData('deleted_swimmers') as Workspace['deletedSwimmers'],
    scorerRosterOverrides: childData('roster_overrides') as Workspace['scorerRosterOverrides'],
    meetEntryPlans: childData('meet_entry_plans') as Workspace['meetEntryPlans'],
    relayLegOverrides: childData('relay_leg_overrides') as Workspace['relayLegOverrides'],
    athleteHistory: childData('athlete_history') as Workspace['athleteHistory'],
    raceAnalyses: childData('race_analyses') as Workspace['raceAnalyses'],
    athleteAliases: childData('athlete_aliases') as Workspace['athleteAliases'],
    relayLegCredits: childData('relay_leg_credits') as Workspace['relayLegCredits'],
    conference: row.conference != null ? String(row.conference) : undefined,
    entryPlanMode: (row.entry_plan_mode as Workspace['entryPlanMode']) ?? undefined,
    scoringView: (row.scoring_view as Workspace['scoringView']) ?? undefined,
    scoringSettings: parseJson<Workspace['scoringSettings']>(row.scoring_settings, undefined),
    loadedMeet: parseJson<Workspace['loadedMeet']>(row.loaded_meet, undefined),
    loadedPsych: parseJson<Workspace['loadedPsych']>(row.loaded_psych, undefined),
    officialTeamScores: parseJson<Workspace['officialTeamScores']>(
      row.official_team_scores,
      undefined
    ),
    activeEntryIds: parseJson<string[] | undefined>(row.active_entry_ids, undefined),
    historySources: parseJson<Workspace['historySources']>(row.history_sources, undefined),
  };
  // The stored revision travels with the workspace so a client can echo it back as
  // the version it last saw (P3). `Workspace` has no `version` field; the three
  // stores add it the same way (see `workspaceVersionOf`).
  const version = Number(row.version ?? 1);
  return Object.assign(workspace, { version: Number.isFinite(version) && version >= 1 ? version : 1 });
}

export type WorkspaceScope = {
  ownerId?: string;
  teamId?: string;
};

/** The stored revision of a workspace read from any store. A document with no version is revision 1. */
export function workspaceVersionOf(ws: unknown): number {
  const v = (ws as { version?: unknown } | null | undefined)?.version;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 1;
}

/** `code` on the error a store throws when the caller's expected version is not the stored one. */
export const VERSION_CONFLICT_CODE = 'VERSION_CONFLICT';
/** `code` on the error a store throws when a create names an id that already exists. */
export const DUPLICATE_WORKSPACE_ID_CODE = 'DUPLICATE_WORKSPACE_ID';

export type CodedError = Error & { code: string };

export function versionConflictError(): CodedError {
  const err = new Error(VERSION_CONFLICT_CODE) as CodedError;
  err.code = VERSION_CONFLICT_CODE;
  return err;
}

/** `code` on the error a store throws when one payload names the same row id twice in one child table. */
export const DUPLICATE_ROW_ID_CODE = 'DUPLICATE_ROW_ID';

export function duplicateRowIdError(table: string, workspaceId: string, id: string): CodedError {
  const err = new Error(
    `Row id "${id}" appears more than once in ${table} of workspace "${workspaceId}". A row id must be unique within its workspace.`
  ) as CodedError;
  err.code = DUPLICATE_ROW_ID_CODE;
  return err;
}

/**
 * One call per id-keyed child table per write. Throws on the second sighting of an id,
 * so a payload that cannot be stored fails with a named 409 and not a bare constraint error.
 * An id only has to be unique inside its workspace: the same id in another workspace is fine.
 */
export function createRowIdGuard(table: string, workspaceId: string): (id: string) => void {
  const seen = new Set<string>();
  return id => {
    if (seen.has(id)) throw duplicateRowIdError(table, workspaceId, id);
    seen.add(id);
  };
}

export function duplicateWorkspaceError(id: string): CodedError {
  const err = new Error(`A workspace with id "${id}" already exists.`) as CodedError;
  err.code = DUPLICATE_WORKSPACE_ID_CODE;
  return err;
}

/**
 * Fields a patch may never set. The store owns identity, creation time and the
 * revision counter; a client that sends one is ignored, not refused.
 */
export const PROTECTED_PATCH_FIELDS = ['id', 'version', 'createdAt'] as const;

export function stripProtectedPatchFields<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  for (const key of PROTECTED_PATCH_FIELDS) delete out[key];
  return out as Partial<T>;
}

export type WorkspaceRowMeta = WorkspaceScope & {
  updatedAt?: number;
  version?: number;
};

export function workspaceRowValues(ws: Workspace, sortIndex: number, meta: WorkspaceRowMeta = {}) {
  return {
    id: ws.id,
    name: ws.name,
    created_at: ws.createdAt ?? Date.now(),
    conference: ws.conference ?? null,
    entry_plan_mode: ws.entryPlanMode ?? null,
    scoring_view: ws.scoringView ?? null,
    scoring_settings: ws.scoringSettings ? JSON.stringify(ws.scoringSettings) : null,
    loaded_meet: ws.loadedMeet ? JSON.stringify(ws.loadedMeet) : null,
    loaded_psych: ws.loadedPsych ? JSON.stringify(ws.loadedPsych) : null,
    official_team_scores: ws.officialTeamScores ? JSON.stringify(ws.officialTeamScores) : null,
    active_entry_ids: ws.activeEntryIds ? JSON.stringify(ws.activeEntryIds) : null,
    history_sources: ws.historySources ? JSON.stringify(ws.historySources) : null,
    sort_index: sortIndex,
    owner_id: meta.ownerId ?? null,
    team_id: meta.teamId ?? null,
    updated_at: meta.updatedAt ?? Date.now(),
    version: meta.version ?? 1,
  };
}

export function insertResultsRows(
  workspaceId: string,
  results: SwimmerResult[],
  gender: string
): { id: string; workspace_id: string; gender: string; position: number; data: string }[] {
  return results.map((r, i) => {
    const rid = (r as { id?: string }).id || `${workspaceId}_${gender}_${i}`;
    return { id: rid, workspace_id: workspaceId, gender, position: i, data: JSON.stringify(r) };
  });
}

export function insertWithIdRows(
  table: string,
  workspaceId: string,
  rows: ReadonlyArray<{ id?: string }>
): { id: string; workspace_id: string; position: number; data: string }[] {
  return rows.map((row, i) => {
    const rid = row.id || `${workspaceId}_${table}_${i}`;
    return { id: rid, workspace_id: workspaceId, position: i, data: JSON.stringify(row) };
  });
}

export function insertPositionalRows(
  workspaceId: string,
  rows: unknown[]
): { workspace_id: string; position: number; data: string }[] {
  return rows.map((row, i) => ({
    workspace_id: workspaceId,
    position: i,
    data: JSON.stringify(row),
  }));
}
