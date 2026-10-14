import { TrendingUp } from 'lucide-react';
import type { ProjectedTeamScore, TeamScore } from '@omniswim/core/types';
import {
  NoExpectationMarker,
  NoExpectationText,
  PointsValue,
  SeedsPastTableNote,
  TeamName,
} from './matrixPresentation';

type Props = {
  projectedTeams: TeamScore[];
  baselineTeams: TeamScore[];
  prelimsTeams: ProjectedTeamScore[];
  searchQuery: string;
};

type DiffRow = {
  teamName: string;
  /** `null` when every seed of the team is past the place-point table: no expectation, not 0. */
  prelimsPoints: number | null;
  /** Seeds past the place-point table. With `prelimsPoints` set the sum leaves them out. */
  prelimsWithoutExpectationCount: number;
  baselinePoints: number;
  /** `null` exactly when `prelimsPoints` is: there is nothing to be over or under. */
  baselineOverUnder: number | null;
  projectedPoints: number;
  projectedOverUnder: number | null;
};

/** Size of the larger over/under; a row with none sorts after every row with one. */
function overUnderMagnitude(row: DiffRow): number {
  return Math.max(
    row.baselineOverUnder === null ? -1 : Math.abs(row.baselineOverUnder),
    row.projectedOverUnder === null ? -1 : Math.abs(row.projectedOverUnder)
  );
}

function overUnderClass(value: number): string {
  return value > 0
    ? 'text-points-positive font-bold'
    : value < 0
      ? 'text-points-negative font-bold'
      : 'text-theme-secondary';
}

export default function PrelimsDiffTable({
  projectedTeams,
  baselineTeams,
  prelimsTeams,
  searchQuery,
}: Props) {
  const prelimsByTeam = new Map(prelimsTeams.map(t => [t.teamName, t]));
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
      const prelimsTeam = prelimsByTeam.get(teamName);
      // A team in the prelims bundle with `expected: null` has no expectation:
      // keep it null so no figure is worked out against 0. A team the bundle
      // does not list at all keeps the 0 it always had here.
      const prelimsPoints = prelimsTeam ? prelimsTeam.expected : 0;
      const baselinePoints = baselineByTeam.get(teamName) ?? 0;
      const projectedPoints = projectedByTeam.get(teamName) ?? 0;
      return {
        teamName,
        prelimsPoints,
        prelimsWithoutExpectationCount: prelimsTeam?.withoutExpectationCount ?? 0,
        baselinePoints,
        baselineOverUnder: prelimsPoints === null ? null : baselinePoints - prelimsPoints,
        projectedPoints,
        projectedOverUnder: prelimsPoints === null ? null : projectedPoints - prelimsPoints,
      };
    })
    .filter(row => !q || row.teamName.toLowerCase().includes(q))
    .sort(
      (a, b) => overUnderMagnitude(b) - overUnderMagnitude(a) || b.projectedPoints - a.projectedPoints
    );

  if (rows.length === 0) {
    return (
      <div className="p-12 text-center border border-dashed border-theme-soft rounded-xl text-theme-secondary">
        <TrendingUp className="w-12 h-12 mx-auto mb-4 opacity-20" />
        <p className="text-xs font-medium">No prelims projection data available</p>
        <p className="text-ui-micro text-theme-muted mt-2 normal-case tracking-normal">
          Load a meet PDF with prelims times to see over/underperformance.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border border-theme-soft rounded-xl">
      <table className="w-full min-w-0 text-left border-collapse">
        <thead className="surface-overlay text-ui-caption text-theme-secondary font-medium">
          <tr>
            <th className="px-2 py-3 xl:p-3">Team</th>
            <th className="px-2 py-3 xl:p-3 text-right">Prelims proj</th>
            <th className="px-2 py-3 xl:p-3 text-right">Baseline</th>
            <th className="px-2 py-3 xl:p-3 text-right">Baseline O/U</th>
            <th className="px-2 py-3 xl:p-3 text-right">Projected</th>
            <th className="px-2 py-3 xl:p-3 text-right">Projected O/U</th>
          </tr>
        </thead>
        <tbody className="text-xs font-mono">
          {rows.map(row => (
            <tr key={row.teamName} className="border-b border-theme-soft theme-hover-row transition-colors">
              <td className="px-2 py-3 xl:p-3">
                <TeamName name={row.teamName} />
              </td>
              <td className="px-2 py-3 xl:p-3">
                {row.prelimsPoints === null ? (
                  <NoExpectationText count={row.prelimsWithoutExpectationCount} />
                ) : (
                  <>
                    <PointsValue value={row.prelimsPoints} className="text-theme-secondary" />
                    {row.prelimsWithoutExpectationCount > 0 ? (
                      <div>
                        <SeedsPastTableNote count={row.prelimsWithoutExpectationCount} />
                      </div>
                    ) : null}
                  </>
                )}
              </td>
              <td className="px-2 py-3 xl:p-3">
                <PointsValue value={row.baselinePoints} />
              </td>
              <td className="px-2 py-3 xl:p-3">
                {row.baselineOverUnder === null ? (
                  <NoExpectationMarker />
                ) : (
                  <PointsValue value={row.baselineOverUnder} className={overUnderClass(row.baselineOverUnder)} />
                )}
              </td>
              <td className="px-2 py-3 xl:p-3">
                <PointsValue value={row.projectedPoints} className="text-[var(--text-primary)]" />
              </td>
              <td className="px-2 py-3 xl:p-3">
                {row.projectedOverUnder === null ? (
                  <NoExpectationMarker />
                ) : (
                  <PointsValue value={row.projectedOverUnder} className={overUnderClass(row.projectedOverUnder)} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
