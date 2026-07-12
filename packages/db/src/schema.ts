/**
 * SQLite schema for the Omni Swim Suite (built on Node's built-in `node:sqlite`).
 *
 * Design: `workspaces` holds scalar + small-JSON metadata; each large collection
 * is normalized into its own child table where every element is one row storing
 * the element as a JSON blob. This keeps the schema queryable and migratable to
 * PostgreSQL later without the fragility of mapping every nested relay-split
 * field into columns.
 */

export const SCHEMA_VERSION = 3;

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
  loaded_psych         TEXT,
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

CREATE TABLE IF NOT EXISTS psych_results (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  gender       TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_psych_results_ws ON psych_results(workspace_id);

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

-- ===== Team Roster Catalog (cross-workspace, long-lived) =====
-- The catalog holds teams → athletes → athlete_event_times so a coach can keep
-- swimmer data independent of any single meet's parse cycle. Each swim carries
-- its native course (time_seconds / time_type) AND the auto-converted SCY
-- representation (time_seconds_scy) so scoring can compare apples-to-apples.

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  short_name  TEXT,
  division    TEXT,
  gender      TEXT NOT NULL CHECK(gender IN ('Men','Women')),
  color       TEXT,
  notes       TEXT,
  sort_index  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (name, gender)
);
CREATE INDEX IF NOT EXISTS idx_teams_name_gender ON teams(name, gender);

CREATE TABLE IF NOT EXISTS athletes (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  name_key    TEXT NOT NULL,
  class_year  TEXT,
  gender      TEXT NOT NULL CHECK(gender IN ('Men','Women')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (team_id, name_key, gender)
);
CREATE INDEX IF NOT EXISTS idx_athletes_team ON athletes(team_id);
CREATE INDEX IF NOT EXISTS idx_athletes_name_key ON athletes(name_key);

CREATE TABLE IF NOT EXISTS athlete_event_times (
  id                TEXT PRIMARY KEY,
  athlete_id        TEXT NOT NULL REFERENCES athletes(id) ON DELETE CASCADE,
  event             TEXT NOT NULL,
  time_text         TEXT NOT NULL,
  time_seconds      REAL NOT NULL,
  time_seconds_scy  REAL NOT NULL,
  time_type         TEXT NOT NULL CHECK(time_type IN ('SCY','LCM','SCM')),
  source            TEXT NOT NULL CHECK(source IN
                       ('paste','csv','ocr','manual','pdf','json')),
  swimcloud_badge   TEXT,
  computed_cut      TEXT,
  meet_label        TEXT,
  swim_date         TEXT,
  is_eligible       INTEGER NOT NULL DEFAULT 1,
  notes             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (athlete_id, event)
);
CREATE INDEX IF NOT EXISTS idx_aet_athlete ON athlete_event_times(athlete_id);
CREATE INDEX IF NOT EXISTS idx_aet_event ON athlete_event_times(event);
`;

export { CHILD_TABLES, type ChildTable } from './workspacePersistence';

/** Catalog tables; used by RosterCatalogService to scope operations. */
export const CATALOG_TABLES = [
  'teams',
  'athletes',
  'athlete_event_times',
] as const;

export type CatalogTable = (typeof CATALOG_TABLES)[number];

/** SQLite v1 → v2 column migrations (idempotent). */
export const SQLITE_MIGRATIONS_V2 = [
  'ALTER TABLE workspaces ADD COLUMN owner_id TEXT',
  'ALTER TABLE workspaces ADD COLUMN team_id TEXT',
  'ALTER TABLE workspaces ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE workspaces ADD COLUMN version INTEGER NOT NULL DEFAULT 1',
];

/** SQLite v2 → v3 psych sheet persistence (idempotent). */
export const SQLITE_MIGRATIONS_V3 = [
  'ALTER TABLE workspaces ADD COLUMN loaded_psych TEXT',
  `CREATE TABLE IF NOT EXISTS psych_results (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  gender       TEXT NOT NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  data         TEXT NOT NULL
)`,
  'CREATE INDEX IF NOT EXISTS idx_psych_results_ws ON psych_results(workspace_id)',
];
