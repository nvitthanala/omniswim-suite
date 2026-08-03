/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Client-side wrappers for the `/api/roster/*` endpoints. These mirror the
 * server-side `RosterCatalogService` API and return the same TypeScript
 * types so the Manager UI can share shapes without remapping.
 */
import type {
  CatalogAthlete,
  CatalogEventTime,
  CatalogGender,
  CatalogSource,
  CatalogTeam,
  CatalogTeamRoster,
  CatalogTimeType,
} from '../lib/rosterCatalog';

export type {
  CatalogAthlete,
  CatalogEventTime,
  CatalogGender,
  CatalogSource,
  CatalogTeam,
  CatalogTeamRoster,
  CatalogTimeType,
} from '../lib/rosterCatalog';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error ? `: ${j.error}` : '';
      if (Array.isArray(j?.issues) && j.issues.length) detail += ` ΓÇö ${j.issues.join('; ')}`;
    } catch {
      /* swallow */
    }
    throw new Error(`HTTP ${res.status}${detail}`);
  }
  return (await res.json()) as T;
}

export const rosterCatalogApi = {
  listTeams: async (): Promise<CatalogTeam[]> => {
    const j = await jsonFetch<{ teams: CatalogTeam[] }>('/api/roster/teams');
    return j.teams;
  },

  createTeam: async (input: {
    name: string;
    gender: CatalogGender;
    shortName?: string;
    division?: string;
    color?: string;
    notes?: string;
  }): Promise<CatalogTeam> => jsonFetch('/api/roster/teams', { method: 'POST', body: JSON.stringify(input) }),

  updateTeam: async (
    id: string,
    patch: { name?: string; shortName?: string; division?: string; notes?: string; color?: string }
  ): Promise<CatalogTeam> =>
    jsonFetch(`/api/roster/teams/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),

  deleteTeam: async (id: string): Promise<void> => {
    await jsonFetch(`/api/roster/teams/${id}`, { method: 'DELETE' });
  },

  getRoster: async (teamId: string): Promise<CatalogTeamRoster | null> => {
    try {
      return await jsonFetch<CatalogTeamRoster>(`/api/roster/teams/${teamId}/full`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('HTTP 404')) return null;
      throw err;
    }
  },

  upsertAthlete: async (input: {
    teamId: string;
    fullName: string;
    nameKey?: string;
    classYear?: string | null;
    gender: CatalogGender;
  }): Promise<CatalogAthlete> =>
    jsonFetch(`/api/roster/teams/${input.teamId}/athletes`, {
      method: 'POST',
      body: JSON.stringify({
        fullName: input.fullName,
        nameKey: input.nameKey,
        classYear: input.classYear ?? undefined,
        gender: input.gender,
      }),
    }),

  upsertTime: async (input: {
    athleteId: string;
    event: string;
    timeText: string;
    timeType: CatalogTimeType;
    source?: CatalogSource;
    swimcloudBadge?: string | null;
    meetLabel?: string | null;
    swimDate?: string | null;
    isEligible?: boolean;
  }): Promise<CatalogEventTime> =>
    jsonFetch('/api/roster/times', {
      method: 'POST',
      body: JSON.stringify({
        athleteId: input.athleteId,
        event: input.event,
        timeText: input.timeText,
        timeType: input.timeType,
        source: input.source ?? 'manual',
        swimcloudBadge: input.swimcloudBadge ?? null,
        meetLabel: input.meetLabel ?? null,
        swimDate: input.swimDate ?? null,
        isEligible: input.isEligible ?? true,
      }),
    }),

  toggleEligibility: async (
    timeId: string,
    isEligible: boolean
  ): Promise<CatalogEventTime> =>
    jsonFetch('/api/roster/toggle-eligibility', {
      method: 'POST',
      body: JSON.stringify({ timeId, isEligible }),
    }),

  deleteTime: async (timeId: string): Promise<void> => {
    await jsonFetch(`/api/roster/times/${timeId}`, { method: 'DELETE' });
  },

  importJson: async (json: unknown): Promise<{ team: CatalogTeam; athletesAdded: number; timesAdded: number }> =>
    jsonFetch('/api/roster/import-json', {
      method: 'POST',
      body: JSON.stringify({ json }),
    }),

  importPaste: async (input: {
    teamId: string;
    text: string;
    format?: 'auto' | 'personal_bests' | 'roster';
    gender: CatalogGender;
    division?: string;
    swimmerOverrides?: Array<{ detectedName: string; fullName: string; classYear?: string }>;
  }): Promise<{
    added: number;
    skipped: { name: string; reason: string }[];
    warnings: string[];
    format: string;
    detectedName?: string;
  }> =>
    jsonFetch('/api/roster/import-paste', { method: 'POST', body: JSON.stringify(input) }),

  exportAll: async (): Promise<{
    teams: CatalogTeam[];
    athletes: CatalogAthlete[];
    times: CatalogEventTime[];
  }> => jsonFetch('/api/roster/export'),
};
