/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `MeetOperationsView`'s "standings" step: the reconciliation banner, the
 * Performance Matrix of `TeamCard`s (filterable by swimmer/team), and the
 * Top Individual Contributors table. Pure extraction from
 * `MeetOperationsView.tsx` — no behavior change.
 */

import { Users, Search } from 'lucide-react';
import type { Gender, ScoringSettings, TeamScore } from '@omniswim/core/types';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import type { MeetReconciliationSummary } from '@omniswim/core/lib/meetReconciliation';
import TeamCard from './TeamCard';
import MeetReconciliationBanner from './MeetReconciliationBanner';
import { AthleteName, PointsValue, TeamName } from './matrixPresentation';

interface TopContributorRow {
  key: string;
  meetPts: number;
  name: string;
  team: string;
  classYear: string;
}

interface MeetOpsStandingsStepProps {
  reconciliationSummary: MeetReconciliationSummary;
  scoringSettings: ScoringSettings;
  pdfFormat: string;
  onPdfFormatChange: (format: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  teamsWithLineStyles: TeamScore[];
  gender: Gender;
  visibleEvents: string[];
  meetConference?: string;
  officialLookup: Map<string, number | undefined>;
  baselineByTeam: Map<string, number>;
  prelimsByTeam: Map<string, number>;
  psychByTeam: Map<string, number>;
  showPrelimsPerformance: boolean;
  prelimsOuByEntry: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance: boolean;
  psychOuByEntry: Map<string, PsychOverUnderEntry>;
  eventThrough?: number;
  onRequestDeleteSwimmer?: (name: string) => void;
  scoringRefreshKey: number;
  onUpdateTime?: (id: string, newTime: string) => void;
  topContributors: TopContributorRow[];
}

export function MeetOpsStandingsStep({
  reconciliationSummary,
  scoringSettings,
  pdfFormat,
  onPdfFormatChange,
  searchQuery,
  onSearchChange,
  teamsWithLineStyles,
  gender,
  visibleEvents,
  meetConference,
  officialLookup,
  baselineByTeam,
  prelimsByTeam,
  psychByTeam,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
  eventThrough,
  onRequestDeleteSwimmer,
  scoringRefreshKey,
  onUpdateTime,
  topContributors,
}: MeetOpsStandingsStepProps) {
  const filteredTeams = teamsWithLineStyles.filter(
    t =>
      !searchQuery ||
      t.teamName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      Object.values(t.swimmers).some(s => String(s.name ?? '').toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <>
      <MeetReconciliationBanner summary={reconciliationSummary} />
      <div className="surface-card rounded-xl p-5">
        <div className="flex justify-between items-end mb-6">
          <div>
            <h3 className="text-lg font-medium text-[var(--text-primary)] uppercase tracking-tight">
              Performance Matrix: Overall Standing
            </h3>
            <p className="text-xs text-theme-secondary">
              Projected totals from custom scoring model ({scoringSettings.scoringPoints.slice(0, 3).join('-')}...)
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={pdfFormat}
              onChange={e => onPdfFormatChange(e.target.value)}
              aria-label="PDF column format"
              className="surface-overlay border border-theme-soft rounded-lg text-[10px] uppercase tracking-widest text-theme-secondary outline-none py-1.5 px-2 cursor-pointer"
            >
              <option value="auto">Auto Format</option>
              <option value="regular">Regular List</option>
              <option value="divided">Divided (2-Col)</option>
            </select>
            <div className="flex items-center surface-overlay border border-theme-soft rounded-lg px-3 py-1.5 focus-within:border-[var(--text-accent)]/50 transition-colors">
              <Search size={12} className="text-theme-secondary mr-2" />
              <input
                value={searchQuery}
                onChange={e => onSearchChange(e.target.value)}
                placeholder="Filter swimmer or team..."
                aria-label="Filter swimmers or teams"
                className="bg-transparent border-none outline-none text-[10px] uppercase placeholder:text-theme-secondary text-[var(--text-primary)] w-40"
              />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          {teamsWithLineStyles.length > 0 ? (
            filteredTeams.map((team, index) => (
              <TeamCard
                key={team.teamName}
                team={team}
                index={index}
                gender={gender}
                eventsList={visibleEvents}
                conference={meetConference}
                searchQuery={searchQuery}
                actualScore={officialLookup.get(team.teamName)}
                baselineScore={baselineByTeam.get(team.teamName)}
                prelimsProjectedScore={prelimsByTeam.get(team.teamName)}
                baselineOverUnder={
                  prelimsByTeam.has(team.teamName)
                    ? (baselineByTeam.get(team.teamName) ?? 0) - (prelimsByTeam.get(team.teamName) ?? 0)
                    : undefined
                }
                projectedOverUnder={
                  prelimsByTeam.has(team.teamName) ? team.totalPoints - (prelimsByTeam.get(team.teamName) ?? 0) : undefined
                }
                showPrelimsPerformance={showPrelimsPerformance}
                prelimsOuByEntry={prelimsOuByEntry}
                showPsychPerformance={showPsychPerformance}
                psychOuByEntry={psychOuByEntry}
                psychProjectedScore={psychByTeam.get(team.teamName)}
                eventThrough={eventThrough}
                onRequestDeleteSwimmer={onRequestDeleteSwimmer}
                scoringRefreshKey={scoringRefreshKey}
                onUpdateTime={onUpdateTime}
              />
            ))
          ) : (
            <div className="p-12 text-center border border-dashed border-theme-soft rounded-xl text-theme-secondary">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="text-xs uppercase font-medium tracking-widest">No matrix data persistent</p>
            </div>
          )}
        </div>
      </div>

      <div className="surface-card rounded-xl overflow-hidden">
        <div className="p-4 border-b border-theme-soft surface-overlay">
          <h4 className="text-[10px] font-medium text-theme-secondary uppercase tracking-widest">Top Individual Contributors</h4>
        </div>
        <table className="w-full text-left border-collapse">
          <thead className="surface-overlay text-ui-micro uppercase tracking-widest text-theme-secondary font-medium">
            <tr>
              <th className="p-3">Rank</th>
              <th className="p-3">Athlete Name</th>
              <th className="p-3">Team</th>
              <th className="p-3">Class</th>
              <th className="p-3 text-right">Meet pts</th>
            </tr>
          </thead>
          <tbody>
            {topContributors.length > 0 ? (
              topContributors.map((row, i) => (
                <tr key={row.key} className="border-b border-theme-soft theme-hover-row transition-colors">
                  <td className="p-3 text-ui-micro font-mono tabular-nums text-theme-muted">{i + 1}</td>
                  <td className="p-3">
                    <AthleteName name={row.name} />
                  </td>
                  <td className="p-3">
                    <TeamName name={row.team} />
                  </td>
                  <td className="p-3">
                    {row.classYear ? (
                      <span className="px-1.5 py-0.5 rounded surface-overlay border border-theme-soft text-ui-micro font-mono">{row.classYear}</span>
                    ) : (
                      <span className="text-theme-muted">—</span>
                    )}
                  </td>
                  <td className="p-3">
                    <PointsValue value={row.meetPts} />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="p-8 text-center text-theme-muted italic">
                  No athlete data available in current matrix
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
