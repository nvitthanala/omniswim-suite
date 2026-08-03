/**
 * RosterCatalogService ΓÇö SQLite-backed persistence for the cross-workspace
 * Team Roster Catalog (teams ΓåÆ athletes ΓåÆ athlete_event_times).
 *
 * The catalog is additive to the existing WorkspaceService: it lives alongside
 * it in the same `data/omniswim.db` file when SQLite is the active backend,
 * and a sibling JSON file (`data/roster_catalog.json`) when JSON is the
 * default backend. This means no schema migration is required to try the
 * feature, and the existing workspace flow is untouched.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  CREATE_TABLES_SQL,
} from './schema';

export type CatalogGender = 'Men' | 'Women';
export type CatalogTimeType = 'SCY' | 'LCM' | 'SCM';
export type CatalogSource = 'paste' | 'csv' | 'ocr' | 'manual' | 'pdf' | 'json';
export type CatalogComputedCut = 'A' | 'B' | null;

export interface CatalogTeam {
  id: string;
  name: string;
  shortName?: string | null;
  division?: string | null;
  gender: CatalogGender;
  color?: string | null;
  notes?: string | null;
  sortIndex: number;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogAthlete {
  id: string;
  teamId: string;
  fullName: string;
  nameKey: string;
  classYear?: string | null;
  gender: CatalogGender;
  createdAt: number;
  updatedAt: number;
}

export interface CatalogEventTime {
  id: string;
  athleteId: string;
  event: string;
  timeText: string;
  timeSeconds: number;
  timeSecondsScy: number;
  timeType: CatalogTimeType;
  source: CatalogSource;
  swimcloudBadge?: string | null;
  computedCut?: CatalogComputedCut;
  meetLabel?: string | null;
  swimDate?: string | null;
  isEligible: boolean;
  notes?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A roster is a team and all its athletes + their swipe events. */
export interface CatalogTeamRoster {
  team: CatalogTeam;
  athletes: (CatalogAthlete & { times: CatalogEventTime[] })[];
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Coerce a SQLite column read (unknown) to a strict string|null for `.run()` args. */
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v);
}

function rowToTeam(r: Record<string, unknown>): CatalogTeam {
  return {
    id: String(r.id),
    name: String(r.name ?? ''),
    shortName: r.short_name != null ? String(r.short_name) : null,
    division: r.division != null ? String(r.division) : null,
    gender: r.gender === 'Women' ? 'Women' : 'Men',
    color: r.color != null ? String(r.color) : null,
    notes: r.notes != null ? String(r.notes) : null,
    sortIndex: Number(r.sort_index ?? 0),
    createdAt: Number(r.created_at ?? Date.now()),
    updatedAt: Number(r.updated_at ?? Date.now()),
  };
}

function rowToAthlete(r: Record<string, unknown>): CatalogAthlete {
  return {
    id: String(r.id),
    teamId: String(r.team_id),
    fullName: String(r.full_name ?? ''),
    nameKey: String(r.name_key ?? ''),
    classYear: r.class_year != null ? String(r.class_year) : null,
    gender: r.gender === 'Women' ? 'Women' : 'Men',
    createdAt: Number(r.created_at ?? Date.now()),
    updatedAt: Number(r.updated_at ?? Date.now()),
  };
}

function rowToEventTime(r: Record<string, unknown>): CatalogEventTime {
  const cut = r.computed_cut;
  return {
    id: String(r.id),
    athleteId: String(r.athlete_id),
    event: String(r.event ?? ''),
    timeText: String(r.time_text ?? ''),
    timeSeconds: Number(r.time_seconds ?? 0),
    timeSecondsScy: Number(r.time_seconds_scy ?? 0),
    timeType: (r.time_type === 'LCM' || r.time_type === 'SCM' ? r.time_type : 'SCY') as CatalogTimeType,
    source: (
      r.source === 'paste' ||
      r.source === 'csv' ||
      r.source === 'ocr' ||
      r.source === 'manual' ||
      r.source === 'pdf' ||
      r.source === 'json'
        ? r.source
        : 'manual'
    ) as CatalogSource,
    swimcloudBadge: r.swimcloud_badge != null ? String(r.swimcloud_badge) : null,
    computedCut: cut === 'A' || cut === 'B' ? cut : null,
    meetLabel: r.meet_label != null ? String(r.meet_label) : null,
    swimDate: r.swim_date != null ? String(r.swim_date) : null,
    isEligible: Number(r.is_eligible ?? 1) !== 0,
    notes: r.notes != null ? String(r.notes) : null,
    createdAt: Number(r.created_at ?? Date.now()),
    updatedAt: Number(r.updated_at ?? Date.now()),
  };
}

export class RosterCatalogService {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(CREATE_TABLES_SQL);
    this.db
      .prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)')
      .run('catalog_schema_version', String(SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }

  // ===================== TEAMS =====================

  listTeams(): CatalogTeam[] {
    const rows = this.db
      .prepare('SELECT * FROM teams ORDER BY sort_index ASC, name ASC')
      .all() as Record<string, unknown>[];
    return rows.map(rowToTeam);
  }

  getTeam(id: string): CatalogTeam | undefined {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToTeam(row) : undefined;
  }

  /** Idempotent ΓÇö returns the existing team if (name, gender) already exists. */
  upsertTeam(input: {
    id?: string;
    name: string;
    gender: CatalogGender;
    shortName?: string | null;
    division?: string | null;
    color?: string | null;
    notes?: string | null;
  }): CatalogTeam {
    const now = Date.now();
    const safeName = input.name.trim();
    if (!safeName) throw new Error('Team name is required');
    const existing = this.db
      .prepare('SELECT * FROM teams WHERE name = ? AND gender = ?')
      .get(safeName, input.gender) as Record<string, unknown> | undefined;
      if (existing) {
        const id = String(existing.id);
        this.db
          .prepare(
            `UPDATE teams SET
              short_name = ?, division = ?, color = ?, notes = ?, updated_at = ?
             WHERE id = ?`
          )
          .run(
            strOrNull(input.shortName ?? existing.short_name),
            strOrNull(input.division ?? existing.division),
            strOrNull(input.color ?? existing.color),
            strOrNull(input.notes ?? existing.notes),
            now,
            id,
          );
        return this.getTeam(id)!;
      }
    const id = input.id || `team_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const sortIndex = Number(
      (this.db.prepare('SELECT COUNT(*) AS n FROM teams').get() as { n: number }).n ?? 0
    );
    this.db
      .prepare(
        `INSERT INTO teams(id, name, short_name, division, gender, color, notes, sort_index, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        safeName,
        input.shortName ?? null,
        input.division ?? null,
        input.gender,
        input.color ?? null,
        input.notes ?? null,
        sortIndex,
        now,
        now,
      );
    return this.getTeam(id)!;
  }

  updateTeam(
    id: string,
    patch: { name?: string; shortName?: string; division?: string; notes?: string; color?: string }
  ): CatalogTeam | undefined {
    const existing = this.getTeam(id);
    if (!existing) return undefined;
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE teams SET
          name = COALESCE(?, name),
          short_name = COALESCE(?, short_name),
          division = COALESCE(?, division),
          color = COALESCE(?, color),
          notes = COALESCE(?, notes),
          updated_at = ?
         WHERE id = ?`
      )
      .run(
        patch.name ?? null,
        patch.shortName ?? null,
        patch.division ?? null,
        patch.color ?? null,
        patch.notes ?? null,
        now,
        id,
      );
    return this.getTeam(id);
  }

  deleteTeam(id: string): void {
    this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  // ===================== ATHLETES =====================

  listAthletesForTeam(teamId: string): CatalogAthlete[] {
    const rows = this.db
      .prepare('SELECT * FROM athletes WHERE team_id = ? ORDER BY full_name ASC')
      .all(teamId) as Record<string, unknown>[];
    return rows.map(rowToAthlete);
  }

  getAthlete(id: string): CatalogAthlete | undefined {
    const row = this.db.prepare('SELECT * FROM athletes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToAthlete(row) : undefined;
  }

  /** Upsert an athlete by (team_id, name_key, gender). Returns the row. */
  upsertAthlete(input: {
    id?: string;
    teamId: string;
    fullName: string;
    nameKey: string;
    classYear?: string | null;
    gender: CatalogGender;
  }): CatalogAthlete {
    const now = Date.now();
    const safeName = input.fullName.trim();
    if (!safeName) throw new Error('Athlete full name is required');
    const key = input.nameKey.trim().toLowerCase();
    if (!key) throw new Error('Athlete nameKey is required');

    const existing = this.db
      .prepare('SELECT * FROM athletes WHERE team_id = ? AND name_key = ? AND gender = ?')
      .get(input.teamId, key, input.gender) as Record<string, unknown> | undefined;
    if (existing) {
      const id = String(existing.id);
      this.db
        .prepare('UPDATE athletes SET full_name = ?, class_year = ?, updated_at = ? WHERE id = ?')
        .run(safeName, strOrNull(input.classYear ?? existing.class_year), now, id);
      return this.getAthlete(id)!;
    }
    const id = input.id || `ath_${now}_${Math.random().toString(36).slice(2, 8)}`;
      this.db
        .prepare(
          `INSERT INTO athletes(id, team_id, full_name, name_key, class_year, gender, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.teamId, safeName, key, strOrNull(input.classYear), input.gender, now, now);
      return this.getAthlete(id)!;
  }

  // ===================== TIMES =====================

  listTimesForAthlete(athleteId: string): CatalogEventTime[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM athlete_event_times WHERE athlete_id = ? ORDER BY time_seconds_scy ASC'
      )
      .all(athleteId) as Record<string, unknown>[];
    return rows.map(rowToEventTime);
  }

  listTimesForTeam(teamId: string): CatalogEventTime[] {
    const rows = this.db
      .prepare(
        `SELECT aet.* FROM athlete_event_times aet
         INNER JOIN athletes a ON a.id = aet.athlete_id
         WHERE a.team_id = ?
         ORDER BY aet.time_seconds_scy ASC`
      )
      .all(teamId) as Record<string, unknown>[];
    return rows.map(rowToEventTime);
  }

  getTime(id: string): CatalogEventTime | undefined {
    const row = this.db.prepare('SELECT * FROM athlete_event_times WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToEventTime(row) : undefined;
  }

  /** Upsert by (athlete_id, event). Returns the row. */
  upsertTime(input: {
    id?: string;
    athleteId: string;
    event: string;
    timeText: string;
    timeSeconds: number;
    timeSecondsScy: number;
    timeType: CatalogTimeType;
    source: CatalogSource;
    swimcloudBadge?: string | null;
    computedCut?: CatalogComputedCut;
    meetLabel?: string | null;
    swimDate?: string | null;
    isEligible?: boolean;
    notes?: string | null;
  }): CatalogEventTime {
    const now = Date.now();
    const event = input.event.trim();
    if (!event) throw new Error('Event is required');

    const existing = this.db
      .prepare('SELECT * FROM athlete_event_times WHERE athlete_id = ? AND event = ?')
      .get(input.athleteId, event) as Record<string, unknown> | undefined;
    if (existing) {
      const id = String(existing.id);
      this.db
        .prepare(
          `UPDATE athlete_event_times SET
            time_text = ?, time_seconds = ?, time_seconds_scy = ?, time_type = ?,
            source = ?, swimcloud_badge = ?, computed_cut = ?, meet_label = ?,
            swim_date = ?, notes = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          input.timeText,
          input.timeSeconds,
          input.timeSecondsScy,
          input.timeType,
          input.source,
          strOrNull(input.swimcloudBadge ?? existing.swimcloud_badge),
          input.computedCut != null ? String(input.computedCut) : strOrNull(existing.computed_cut),
          strOrNull(input.meetLabel ?? existing.meet_label),
          strOrNull(input.swimDate ?? existing.swim_date),
          strOrNull(input.notes ?? existing.notes),
          now,
          id,
        );
      return this.getTime(id)!;
    }
    const id = input.id || `t_${now}_${Math.random().toString(36).slice(2, 8)}`;
    this.db
      .prepare(
        `INSERT INTO athlete_event_times(
          id, athlete_id, event, time_text, time_seconds, time_seconds_scy, time_type,
          source, swimcloud_badge, computed_cut, meet_label, swim_date, is_eligible,
          notes, created_at, updated_at
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.athleteId,
        event,
        input.timeText,
        input.timeSeconds,
        input.timeSecondsScy,
        input.timeType,
        input.source,
        input.swimcloudBadge ?? null,
        input.computedCut ?? null,
        input.meetLabel ?? null,
        input.swimDate ?? null,
        input.isEligible === false ? 0 : 1,
        input.notes ?? null,
        now,
        now,
      );
    return this.getTime(id)!;
  }

  toggleEligibility(timeId: string, isEligible: boolean): CatalogEventTime | undefined {
    const existing = this.getTime(timeId);
    if (!existing) return undefined;
    const now = Date.now();
    this.db
      .prepare(
        'UPDATE athlete_event_times SET is_eligible = ?, updated_at = ? WHERE id = ?'
      )
      .run(isEligible ? 1 : 0, now, timeId);
    return this.getTime(timeId);
  }

  deleteTime(timeId: string): void {
    this.db.prepare('DELETE FROM athlete_event_times WHERE id = ?').run(timeId);
  }

  // ===================== BULK OPS =====================

  /** Build a full roster view (team + athletes + their times). */
  getRoster(teamId: string): CatalogTeamRoster | undefined {
    const team = this.getTeam(teamId);
    if (!team) return undefined;
    const athletes = this.listAthletesForTeam(teamId);
    return {
      team,
      athletes: athletes.map(a => ({ ...a, times: this.listTimesForAthlete(a.id) })),
    };
  }

  exportAll(): {
    teams: CatalogTeam[];
    athletes: CatalogAthlete[];
    times: CatalogEventTime[];
  } {
    const teams = this.listTeams();
    const athletes: CatalogAthlete[] = [];
    const times: CatalogEventTime[] = [];
    for (const t of teams) {
      for (const a of this.listAthletesForTeam(t.id)) {
        athletes.push(a);
        for (const time of this.listTimesForAthlete(a.id)) times.push(time);
      }
    }
    return { teams, athletes, times };
  }
}
