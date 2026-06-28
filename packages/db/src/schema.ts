/**
 * SQLite schema for the Omni Swim Suite (built on Node's built-in `node:sqlite`).
 *
 * Design: `workspaces` holds scalar + small-JSON metadata; each large collection
 * is normalized into its own child table where every element is one row storing
 * the element as a JSON blob. This keeps the schema queryable and migratable to
 * PostgreSQL later without the fragility of mapping every nested relay-split
 * field into columns.
 */

export const SCHEMA_VERSION = 2;

export const CREATE_TABLES_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  conference           TEXT,
  entry_plan_mode      TEXT,
  scoring_settings     TEXT,
  loaded_meet          TEXT,
  official_team_scores TEXT,
  active_entry_ids     TEXT,
  history_sources      TEXT,
  sort_index           INTEGER NOT NULL DEFAULT 0,
  owner_id             TEXT,
  team_id              TEXT,
  updated_at           INTEGER NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS meet_results (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  gender       TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_results_ws ON meet_results(workspace_id);

CREATE TABLE IF NOT EXISTS recruits (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_recruits_ws ON recruits(workspace_id);

CREATE TABLE IF NOT EXISTS roster_overrides (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roster_overrides_ws ON roster_overrides(workspace_id);

CREATE TABLE IF NOT EXISTS meet_entry_plans (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_entry_plans_ws ON meet_entry_plans(workspace_id);

CREATE TABLE IF NOT EXISTS relay_leg_overrides (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_leg_overrides_ws ON relay_leg_overrides(workspace_id);

CREATE TABLE IF NOT EXISTS deleted_swimmers (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deleted_swimmers_ws ON deleted_swimmers(workspace_id);

CREATE TABLE IF NOT EXISTS athlete_history (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_athlete_history_ws ON athlete_history(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  label        TEXT,
  blob         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_ws ON workspace_snapshots(workspace_id);
`;

export { CHILD_TABLES, type ChildTable } from './workspacePersistence';

/** SQLite v1 → v2 column migrations (idempotent). */
export const SQLITE_MIGRATIONS_V2 = [
  'ALTER TABLE workspaces ADD COLUMN owner_id TEXT',
  'ALTER TABLE workspaces ADD COLUMN team_id TEXT',
  'ALTER TABLE workspaces ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE workspaces ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
];
