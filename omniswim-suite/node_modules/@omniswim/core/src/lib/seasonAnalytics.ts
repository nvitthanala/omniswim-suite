import type { Workspace } from '../types';

export type SwimmerTrend = {
  name: string;
  event: string;
  bestTime: string;
  meetCount: number;
  progression: { label: string; time: string }[];
};

export type TeamScoreTrend = {
  meetLabel: string;
  menTotal: number;
  womenTotal: number;
};

export type SeasonTrends = {
  swimmerTrends: SwimmerTrend[];
  teamScoreTrends: TeamScoreTrend[];
};

function parseTimeSeconds(t: string): number {
  const parts = t.trim().split(':');
  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(t) || Infinity;
}

export function buildSeasonTrends(workspaces: Workspace[]): SeasonTrends {
  const swimmerMap = new Map<string, SwimmerTrend>();

  for (const ws of workspaces) {
    const meetLabel = ws.loadedMeet?.meetLabel ?? ws.name;
    for (const r of [...(ws.menResults ?? []), ...(ws.womenResults ?? [])]) {
      if (r.isRelay || !r.name || !r.event || typeof r.time !== 'string') continue;
      const key = `${r.name.toLowerCase()}::${r.event}`;
      const existing = swimmerMap.get(key);
      const entry = { label: meetLabel, time: r.time };
      if (!existing) {
        swimmerMap.set(key, {
          name: r.name,
          event: r.event,
          bestTime: r.time,
          meetCount: 1,
          progression: [entry],
        });
      } else {
        existing.meetCount += 1;
        existing.progression.push(entry);
        if (parseTimeSeconds(r.time) < parseTimeSeconds(existing.bestTime)) {
          existing.bestTime = r.time;
        }
      }
    }
    for (const h of ws.athleteHistory ?? []) {
      if (!h.name || !h.event || !h.time) continue;
      const key = `${h.name.toLowerCase()}::${h.event}`;
      const existing = swimmerMap.get(key);
      const entry = { label: 'history', time: h.time };
      if (!existing) {
        swimmerMap.set(key, {
          name: h.name,
          event: h.event,
          bestTime: h.time,
          meetCount: 1,
          progression: [entry],
        });
      } else {
        existing.meetCount += 1;
        existing.progression.push(entry);
        if (parseTimeSeconds(h.time) < parseTimeSeconds(existing.bestTime)) {
          existing.bestTime = h.time;
        }
      }
    }
  }

  const teamScoreTrends: TeamScoreTrend[] = workspaces
    .filter(ws => ws.officialTeamScores || (ws.menResults?.length ?? 0) > 0)
    .map(ws => {
      const menTotal = Object.values(ws.officialTeamScores?.men ?? {}).reduce((a, b) => a + b, 0);
      const womenTotal = Object.values(ws.officialTeamScores?.women ?? {}).reduce((a, b) => a + b, 0);
      return {
        meetLabel: ws.loadedMeet?.meetLabel ?? ws.name,
        menTotal: menTotal || (ws.menResults ?? []).reduce((s, r) => s + (Number(r.points) || 0), 0),
        womenTotal:
          womenTotal || (ws.womenResults ?? []).reduce((s, r) => s + (Number(r.points) || 0), 0),
      };
    });

  const swimmerTrends = [...swimmerMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return { swimmerTrends, teamScoreTrends };
}
