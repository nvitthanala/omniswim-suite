import { TrendingUp } from 'lucide-react';
import type { TeamScore } from '@omniswim/core/types';
import { PointsValue, TeamName } from './matrixPresentation';

type Props = {
  projectedTeams: TeamScore[];
  baselineTeams: TeamScore[];
  prelimsTeams: TeamScore[];
  searchQuery: string;
};

type DiffRow = {
  teamName: string;
  prelimsPoints: number;
  baselinePoints: number;
  baselineOverUnder: number;
  projectedPoints: number;
  projectedOverUnder: number;
};

export default function PrelimsDiffTable({
  projectedTeams,
  baselineTeams,
  prelimsTeams,
  searchQuery,
}: Props) {
  const prelimsByTeam = new Map(prelimsTeams.map(t => [t.teamName, t.totalPoints]));
  const baselineByTeam = new Map(baselineTeams.map(t => [t.teamName, t.totalPoints]));
  const projectedByTeam = new Map(projectedTeams.map(t => [t.teamName, t.totalPoints]));
  const teamNames = new Set([
    ...prelimsByTeam.keys(),
    ...baselineByTeam.keys(),
    ...projectedByTeam.keys(),
  ]);
  const q = searchQuery.trim().toLowerCase();

  const rows: DiffRow[] = [...teamNames]
    .map(teamName => {
      const prelimsPoints = prelimsByTeam.get(teamName) ?? 0;
      const baselinePoints = baselineByTeam.get(teamName) ?? 0;
      const projectedPoints = projectedByTeam.get(teamName) ?? 0;
      return {
        teamName,
        prelimsPoints,
        baselinePoints,
        baselineOverUnder: baselinePoints - prelimsPoints,
        projectedPoints,
        projectedOverUnder: projectedPoints - prelimsPoints,
      };
    })
    .filter(row => !q || row.teamName.toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Math.max(Math.abs(b.baselineOverUnder), Math.abs(b.projectedOverUnder)) -
          Math.max(Math.abs(a.baselineOverUnder), Math.abs(a.projectedOverUnder)) ||
        b.projectedPoints - a.projectedPoints
    );

  if (rows.length === 0) {
    return (
      <div className="p-12 text-center border border-dashed border-theme-soft rounded-lg text-theme-secondary">
        <TrendingUp className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <p className="text-xs uppercase font-medium tracking-widest">No prelims projection data available</p>
        <p className="text-[10px] text-theme-muted mt-2 normal-case tracking-normal">
          Load a meet PDF with prelims times to see over/underperformance.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-theme-soft rounded-lg">
      <table className="w-full min-w-[720px] text-left border-collapse">
        <thead className="surface-overlay text-[10px] uppercase tracking-widest text-theme-secondary font-medium">
          <tr>
            <th className="p-3">Team</th>
            <th className="p-3 text-right">Prelims Proj</th>
            <th className="p-3 text-right">Baseline</th>
            <th className="p-3 text-right">Baseline O/U</th>
            <th className="p-3 text-right">Projected</th>
            <th className="p-3 text-right">Projected O/U</th>
          </tr>
        </thead>
        <tbody className="text-xs font-mono">
          {rows.map(row => (
            <tr key={row.teamName} className="border-b border-theme-soft theme-hover-row transition-colors">
              <td className="p-3">
                <TeamName name={row.teamName} />
              </td>
              <td className="p-3">
                <PointsValue value={row.prelimsPoints} className="text-theme-secondary" />
              </td>
              <td className="p-3">
                <PointsValue value={row.baselinePoints} />
              </td>
              <td className="p-3">
                <PointsValue
                  value={row.baselineOverUnder}
                  className={
                    row.baselineOverUnder > 0
                      ? 'text-points-positive font-bold'
                      : row.baselineOverUnder < 0
                        ? 'text-points-negative font-bold'
                        : 'text-theme-secondary'
                  }
                />
              </td>
              <td className="p-3">
                <PointsValue value={row.projectedPoints} className="text-[var(--text-primary)]" />
              </td>
              <td className="p-3">
                <PointsValue
                  value={row.projectedOverUnder}
                  className={
                    row.projectedOverUnder > 0
                      ? 'text-points-positive font-bold'
                      : row.projectedOverUnder < 0
                        ? 'text-points-negative font-bold'
                        : 'text-theme-secondary'
                  }
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
