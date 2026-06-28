import { GitCompareArrows } from 'lucide-react';
import type { TeamScore } from '@omniswim/core/types';
import { PointsValue, TeamName } from './matrixPresentation';

type Props = {
  projectedTeams: TeamScore[];
  baselineTeams: TeamScore[];
  searchQuery: string;
};

type DiffRow = {
  teamName: string;
  projectedPoints: number;
  baselinePoints: number;
  delta: number;
  projectedRank: number | null;
  baselineRank: number | null;
};

export default function MeetDiffTable({ projectedTeams, baselineTeams, searchQuery }: Props) {
  const baselineByTeam = new Map(baselineTeams.map((team, index) => [team.teamName, { team, rank: index + 1 }]));
  const projectedByTeam = new Map(projectedTeams.map((team, index) => [team.teamName, { team, rank: index + 1 }]));
  const teamNames = new Set([...baselineByTeam.keys(), ...projectedByTeam.keys()]);
  const q = searchQuery.trim().toLowerCase();

  const rows: DiffRow[] = [...teamNames]
    .map(teamName => {
      const baseline = baselineByTeam.get(teamName);
      const projected = projectedByTeam.get(teamName);
      const baselinePoints = baseline?.team.totalPoints ?? 0;
      const projectedPoints = projected?.team.totalPoints ?? 0;
      return {
        teamName,
        projectedPoints,
        baselinePoints,
        delta: projectedPoints - baselinePoints,
        projectedRank: projected?.rank ?? null,
        baselineRank: baseline?.rank ?? null,
      };
    })
    .filter(row => !q || row.teamName.toLowerCase().includes(q))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.projectedPoints - a.projectedPoints);

  if (rows.length === 0) {
    return (
      <div className="p-12 text-center border border-dashed border-theme-soft rounded-lg text-theme-secondary">
        <GitCompareArrows className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <p className="text-xs uppercase font-medium tracking-widest">No team diff data available</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-theme-soft rounded-lg">
      <table className="w-full min-w-[620px] text-left border-collapse">
        <thead className="surface-overlay text-[10px] uppercase tracking-widest text-theme-secondary font-medium">
          <tr>
            <th className="p-3">Team</th>
            <th className="p-3 text-right">Baseline</th>
            <th className="p-3 text-right">Projected</th>
            <th className="p-3 text-right">Delta</th>
            <th className="p-3 text-right">Rank</th>
          </tr>
        </thead>
        <tbody className="text-xs font-mono">
          {rows.map(row => {
            const rankDelta =
              row.baselineRank != null && row.projectedRank != null
                ? row.baselineRank - row.projectedRank
                : null;
            return (
              <tr key={row.teamName} className="border-b border-theme-soft theme-hover-row transition-colors">
                <td className="p-3"><TeamName name={row.teamName} /></td>
                <td className="p-3"><PointsValue value={row.baselinePoints} /></td>
                <td className="p-3"><PointsValue value={row.projectedPoints} className="text-[var(--text-primary)]" /></td>
                <td className="p-3">
                  <PointsValue
                    value={row.delta}
                    className={
                      row.delta > 0
                        ? 'text-points-positive font-bold'
                        : row.delta < 0
                          ? 'text-points-negative font-bold'
                          : 'text-theme-secondary'
                    }
                  />
                </td>
                <td className="p-3 text-right text-theme-secondary tabular-nums">
                  {row.projectedRank != null ? `#${row.projectedRank}` : '-'}
                  {rankDelta ? (
                    <span className={rankDelta > 0 ? 'text-points-positive ml-2' : 'text-points-negative ml-2'}>
                      {rankDelta > 0 ? '+' : ''}
                      {rankDelta}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
