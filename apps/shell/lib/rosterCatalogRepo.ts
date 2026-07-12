/**
 * Roster Catalog storage adapter (additive to WorkspaceRepo).
 *
 * Two interchangeable backends present the same async surface to the server:
 *   - JsonRosterCatalog:    v1 single-writer JSON queue (default, zero setup)
 *   - SqlRosterCatalog:     RosterCatalogService via @omniswim/db
 *
 * Mirrors the structure of `workspaceRepo.ts` so adopted users get feature
 * parity across both backends without any code change at the call site.
 */
import { promises as fsp, existsSync } from 'node:fs';
import path from 'node:path';
import { JsonStore } from './jsonStore.ts';
import { RosterCatalogService } from '../../../packages/db/src/RosterCatalogService.ts';
import type {
  CatalogAthlete,
  CatalogComputedCut,
  CatalogEventTime,
  CatalogGender,
  CatalogSource,
  CatalogTeam,
  CatalogTeamRoster,
  CatalogTimeType,
} from '../../../packages/db/src/RosterCatalogService.ts';

export interface RosterCatalogRepo {
  readonly kind: 'json' | 'sqlite';
  init(): Promise<void>;
  listTeams(): Promise<CatalogTeam[]>;
  upsertTeam(input: {
    name: string;
    gender: CatalogGender;
    shortName?: string | null;
    division?: string | null;
    color?: string | null;
    notes?: string | null;
  }): Promise<CatalogTeam>;
  updateTeam(
    id: string,
    patch: { name?: string; shortName?: string; division?: string; notes?: string; color?: string }
  ): Promise<CatalogTeam | undefined>;
  deleteTeam(id: string): Promise<void>;
  getRoster(teamId: string): Promise<CatalogTeamRoster | undefined>;
  upsertAthlete(input: {
    teamId: string;
    fullName: string;
    nameKey: string;
    classYear?: string | null;
    gender: CatalogGender;
  }): Promise<CatalogAthlete>;
  upsertTime(input: {
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
  }): Promise<CatalogEventTime>;
  toggleEligibility(timeId: string, isEligible: boolean): Promise<CatalogEventTime | undefined>;
  deleteTime(timeId: string): Promise<void>;
  exportAll(): Promise<{ teams: CatalogTeam[]; athletes: CatalogAthlete[]; times: CatalogEventTime[] }>;
}

// -------------------- Storage Shapes --------------------

type RosterCatalogJson = {
  teams: CatalogTeam[];
  athletes: CatalogAthlete[];
  times: CatalogEventTime[];
};

const EMPTY_CATALOG: RosterCatalogJson = { teams: [], athletes: [], times: [] };

// -------------------- JSON Backend --------------------

export class JsonRosterCatalog implements RosterCatalogRepo {
  readonly kind = 'json' as const;
  private store: JsonStore<RosterCatalogJson>;
  private filePath: string;

  constructor(filePath: string, backupDir?: string) {
    this.filePath = filePath;
    this.store = new JsonStore<RosterCatalogJson>(filePath, () => EMPTY_CATALOG, backupDir);
  }

  async init(): Promise<void> {
    await this.store.init();
    // Refresh `touched` flag in case multiple write paths race in tests.
    if (!existsSync(this.filePath)) {
      // store.init handles seeding; this is just a no-op fallback.
    }
  }

  private async read(): Promise<RosterCatalogJson> {
    return this.store.read();
  }

  async listTeams(): Promise<CatalogTeam[]> {
    const c = await this.read();
    return [...c.teams].sort(
      (a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name)
    );
  }

  async upsertTeam(input: {
    name: string;
    gender: CatalogGender;
    shortName?: string | null;
    division?: string | null;
    color?: string | null;
    notes?: string | null;
  }): Promise<CatalogTeam> {
    const now = Date.now();
    let result: CatalogTeam | undefined;
    await this.store.mutate(catalog => {
      const safeName = input.name.trim();
      if (!safeName) throw new Error('Team name is required');
      const existing = catalog.teams.find(
        t => t.name === safeName && t.gender === input.gender
      );
      if (existing) {
        existing.shortName = input.shortName ?? existing.shortName ?? null;
        existing.division = input.division ?? existing.division ?? null;
        existing.color = input.color ?? existing.color ?? null;
        existing.notes = input.notes ?? existing.notes ?? null;
        existing.updatedAt = now;
        result = existing;
        return {
          ...catalog,
          teams: catalog.teams.map(t => (t.id === existing.id ? existing : t)),
        };
      }
      const team: CatalogTeam = {
        id: `team_${now}_${Math.random().toString(36).slice(2, 8)}`,
        name: safeName,
        shortName: input.shortName ?? null,
        division: input.division ?? null,
        gender: input.gender,
        color: input.color ?? null,
        notes: input.notes ?? null,
        sortIndex: catalog.teams.length,
        createdAt: now,
        updatedAt: now,
      };
      result = team;
      return { ...catalog, teams: [...catalog.teams, team] };
    });
    return result!;
  }

  async updateTeam(
    id: string,
    patch: { name?: string; shortName?: string; division?: string; notes?: string; color?: string }
  ): Promise<CatalogTeam | undefined> {
    const now = Date.now();
    let updated: CatalogTeam | undefined;
    await this.store.mutate(catalog => {
      const idx = catalog.teams.findIndex(t => t.id === id);
      if (idx === -1) return catalog;
      const cur = catalog.teams[idx];
      const next: CatalogTeam = {
        ...cur,
        name: patch.name ?? cur.name,
        shortName: patch.shortName !== undefined ? patch.shortName : cur.shortName ?? null,
        division: patch.division !== undefined ? patch.division : cur.division ?? null,
        notes: patch.notes !== undefined ? patch.notes : cur.notes ?? null,
        color: patch.color !== undefined ? patch.color : cur.color ?? null,
        updatedAt: now,
      };
      updated = next;
      const teams = [...catalog.teams];
      teams[idx] = next;
      return { ...catalog, teams };
    });
    return updated;
  }

  async deleteTeam(id: string): Promise<void> {
    await this.store.mutate(catalog => {
      const teams = catalog.teams.filter(t => t.id !== id);
      const athletes = catalog.athletes.filter(a => a.teamId !== id);
      const orphanAthleteIds = new Set(
        catalog.athletes.filter(a => a.teamId === id).map(a => a.id)
      );
      const times = catalog.times.filter(t => !orphanAthleteIds.has(t.athleteId));
      return { ...catalog, teams, athletes, times };
    });
  }

  async getRoster(teamId: string): Promise<CatalogTeamRoster | undefined> {
    const catalog = await this.read();
    const team = catalog.teams.find(t => t.id === teamId);
    if (!team) return undefined;
    const athletes = catalog.athletes
      .filter(a => a.teamId === teamId)
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(a => ({
        ...a,
        times: catalog.times
          .filter(t => t.athleteId === a.id)
          .sort((x, y) => x.timeSecondsScy - y.timeSecondsScy),
      }));
    return { team, athletes };
  }

  async upsertAthlete(input: {
    teamId: string;
    fullName: string;
    nameKey: string;
    classYear?: string | null;
    gender: CatalogGender;
  }): Promise<CatalogAthlete> {
    const now = Date.now();
    let result: CatalogAthlete | undefined;
    await this.store.mutate(catalog => {
      const safeName = input.fullName.trim();
      if (!safeName) throw new Error('Athlete full name is required');
      const key = input.nameKey.trim().toLowerCase();
      if (!key) throw new Error('Athlete nameKey is required');
      const existing = catalog.athletes.find(
        a => a.teamId === input.teamId && a.nameKey === key && a.gender === input.gender
      );
      if (existing) {
        existing.fullName = safeName;
        existing.classYear = input.classYear ?? existing.classYear ?? null;
        existing.updatedAt = now;
        result = existing;
        return {
          ...catalog,
          athletes: catalog.athletes.map(a => (a.id === existing.id ? existing : a)),
        };
      }
      const athlete: CatalogAthlete = {
        id: `ath_${now}_${Math.random().toString(36).slice(2, 8)}`,
        teamId: input.teamId,
        fullName: safeName,
        nameKey: key,
        classYear: input.classYear ?? null,
        gender: input.gender,
        createdAt: now,
        updatedAt: now,
      };
      result = athlete;
      return { ...catalog, athletes: [...catalog.athletes, athlete] };
    });
    return result!;
  }

  async upsertTime(input: {
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
  }): Promise<CatalogEventTime> {
    const now = Date.now();
    let result: CatalogEventTime | undefined;
    await this.store.mutate(catalog => {
      const event = input.event.trim();
      if (!event) throw new Error('Event is required');
      const existing = catalog.times.find(
        t => t.athleteId === input.athleteId && t.event === event
      );
      if (existing) {
        existing.timeText = input.timeText;
        existing.timeSeconds = input.timeSeconds;
        existing.timeSecondsScy = input.timeSecondsScy;
        existing.timeType = input.timeType;
        existing.source = input.source;
        existing.swimcloudBadge = input.swimcloudBadge ?? existing.swimcloudBadge ?? null;
        existing.computedCut =
          input.computedCut !== undefined ? input.computedCut : existing.computedCut ?? null;
        existing.meetLabel = input.meetLabel ?? existing.meetLabel ?? null;
        existing.swimDate = input.swimDate ?? existing.swimDate ?? null;
        existing.notes = input.notes ?? existing.notes ?? null;
        existing.updatedAt = now;
        result = existing;
        return {
          ...catalog,
          times: catalog.times.map(t => (t.id === existing.id ? existing : t)),
        };
      }
      const time: CatalogEventTime = {
        id: `t_${now}_${Math.random().toString(36).slice(2, 8)}`,
        athleteId: input.athleteId,
        event,
        timeText: input.timeText,
        timeSeconds: input.timeSeconds,
        timeSecondsScy: input.timeSecondsScy,
        timeType: input.timeType,
        source: input.source,
        swimcloudBadge: input.swimcloudBadge ?? null,
        computedCut: input.computedCut ?? null,
        meetLabel: input.meetLabel ?? null,
        swimDate: input.swimDate ?? null,
        isEligible: input.isEligible === false ? false : true,
        notes: input.notes ?? null,
        createdAt: now,
        updatedAt: now,
      };
      result = time;
      return { ...catalog, times: [...catalog.times, time] };
    });
    return result!;
  }

  async toggleEligibility(
    timeId: string,
    isEligible: boolean
  ): Promise<CatalogEventTime | undefined> {
    const now = Date.now();
    let updated: CatalogEventTime | undefined;
    await this.store.mutate(catalog => {
      const idx = catalog.times.findIndex(t => t.id === timeId);
      if (idx === -1) return catalog;
      const cur = catalog.times[idx];
      const next: CatalogEventTime = { ...cur, isEligible, updatedAt: now };
      updated = next;
      const times = [...catalog.times];
      times[idx] = next;
      return { ...catalog, times };
    });
    return updated;
  }

  async deleteTime(timeId: string): Promise<void> {
    await this.store.mutate(catalog => ({
      ...catalog,
      times: catalog.times.filter(t => t.id !== timeId),
    }));
  }

  async exportAll(): Promise<RosterCatalogJson> {
    const catalog = await this.read();
    return {
      teams: [...catalog.teams],
      athletes: [...catalog.athletes],
      times: [...catalog.times],
    };
  }
}

// -------------------- SQLite Backend --------------------

export class SqlRosterCatalog implements RosterCatalogRepo {
  readonly kind = 'sqlite' as const;
  private service: RosterCatalogService;

  constructor(dbPath: string) {
    this.service = new RosterCatalogService(dbPath);
  }

  async init(): Promise<void> {
    // Schema applied on construction; nothing else to do.
    return;
  }

  async listTeams(): Promise<CatalogTeam[]> {
    return this.service.listTeams();
  }

  async upsertTeam(input: {
    name: string;
    gender: CatalogGender;
    shortName?: string | null;
    division?: string | null;
    color?: string | null;
    notes?: string | null;
  }): Promise<CatalogTeam> {
    return this.service.upsertTeam(input);
  }

  async updateTeam(
    id: string,
    patch: { name?: string; shortName?: string; division?: string; notes?: string; color?: string }
  ): Promise<CatalogTeam | undefined> {
    return this.service.updateTeam(id, patch);
  }

  async deleteTeam(id: string): Promise<void> {
    this.service.deleteTeam(id);
  }

  async getRoster(teamId: string): Promise<CatalogTeamRoster | undefined> {
    return this.service.getRoster(teamId);
  }

  async upsertAthlete(input: {
    teamId: string;
    fullName: string;
    nameKey: string;
    classYear?: string | null;
    gender: CatalogGender;
  }): Promise<CatalogAthlete> {
    return this.service.upsertAthlete(input);
  }

  async upsertTime(input: {
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
  }): Promise<CatalogEventTime> {
    return this.service.upsertTime(input);
  }

  async toggleEligibility(
    timeId: string,
    isEligible: boolean
  ): Promise<CatalogEventTime | undefined> {
    return this.service.toggleEligibility(timeId, isEligible);
  }

  async deleteTime(timeId: string): Promise<void> {
    this.service.deleteTime(timeId);
  }

  async exportAll(): Promise<RosterCatalogJson> {
    return this.service.exportAll();
  }
}

let catalogInstance: RosterCatalogRepo | null = null;

/** Build/reuse a singleton catalog repo. Backend chosen from `OMNI_DB` env. */
export function buildRosterCatalog(args: {
  dbBackend: 'json' | 'sqlite';
  dataDir: string;
  dbFile: string;
  backupDir?: string;
}): RosterCatalogRepo {
  if (catalogInstance) return catalogInstance;
  if (args.dbBackend === 'sqlite') {
    catalogInstance = new SqlRosterCatalog(args.dbFile);
  } else {
    const filePath = path.join(args.dataDir, 'roster_catalog.json');
    catalogInstance = new JsonRosterCatalog(filePath, args.backupDir);
  }
  return catalogInstance;
}

/** Replace the singleton (test-only). */
export function __resetRosterCatalogForTests(): void {
  catalogInstance = null;
}
