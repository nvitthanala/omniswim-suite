/**
 * PostgreSQL schema for Omni Swim Suite (shared multi-user deployment).
 */
export const PG_SCHEMA_VERSION = 2;

export const CREATE_PG_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  team_id    TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  BIGINT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  created_at           BIGINT NOT NULL,
  conference           TEXT,
  entry_plan_mode      TEXT,
  scoring_settings     TEXT,
  loaded_meet          TEXT,
  official_team_scores TEXT,
  active_entry_ids     TEXT,
  history_sources      TEXT,
  sort_index           INTEGER NOT NULL DEFAULT 0,
  owner_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
  team_id              TEXT REFERENCES teams(id) ON DELETE SET NULL,
  updated_at           BIGINT NOT NULL DEFAULT 0,
  version              INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_workspaces_team ON workspaces(team_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_id);

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
  created_at   BIGINT NOT NULL,
  label        TEXT,
  blob         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_ws ON workspace_snapshots(workspace_id);

CREATE TABLE IF NOT EXISTS share_links (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id      TEXT REFERENCES teams(id) ON DELETE CASCADE,
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  label        TEXT,
  token        TEXT NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token);
`;
