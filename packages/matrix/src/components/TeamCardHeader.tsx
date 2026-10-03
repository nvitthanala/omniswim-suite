/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TeamCard's collapsed header row: team name, athlete count, the optional
 * projected/actual score line, the point total, and the expand/collapse
 * chevron. Pure extraction from `TeamCard.tsx` — no behavior change.
 */

import { ChevronDown, ChevronUp } from 'lucide-react';
import type { TeamScore } from '@omniswim/core/types';
import ProjectedActualScore from './ProjectedActualScore';

interface TeamCardHeaderProps {
  team: TeamScore;
  isExpanded: boolean;
  conference?: string;
  athleteCount: number;
  actualScore?: number;
  baselineScore?: number;
  prelimsProjectedScore?: number;
  baselineOverUnder?: number;
  projectedOverUnder?: number;
  showPrelimsPerformance?: boolean;
  eventThrough?: number;
  onToggle: () => void;
}

export function TeamCardHeader({
  team,
  isExpanded,
  conference,
  athleteCount,
  actualScore,
  baselineScore,
  prelimsProjectedScore,
  baselineOverUnder,
  projectedOverUnder,
  showPrelimsPerformance,
  eventThrough,
  onToggle,
}: TeamCardHeaderProps) {
  return (
    <button
      type="button"
      aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${team.teamName} team details`}
      aria-expanded={isExpanded}
      onClick={onToggle}
      className="w-full flex items-center justify-between p-5 theme-hover-row transition-colors"
    >
      <div className="flex flex-col items-start gap-1">
        <h3 className="text-sm font-bold text-[var(--text-primary)]">{team.teamName}</h3>
        <div className="flex flex-col gap-1">
          <span className="text-ui-caption text-theme-secondary font-medium">
            {conference ? `${conference} • ` : ''}{athleteCount} Athletes
          </span>
          {(actualScore != null || baselineScore != null || showPrelimsPerformance) ? (
            <ProjectedActualScore
              actual={actualScore}
              baseline={baselineScore}
              projected={team.totalPoints}
              compact
              eventThrough={eventThrough}
              prelimsProjected={prelimsProjectedScore}
              baselineOverUnder={baselineOverUnder}
              projectedOverUnder={projectedOverUnder}
            />
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-6">
        <div className="text-right">
          <span className="block text-2xl font-black text-[var(--text-accent)] font-mono tracking-tighter leading-none">
            {team.totalPoints.toFixed(1)}
          </span>
          <span className="text-ui-micro text-theme-secondary font-medium font-mono">Projected points</span>
        </div>
        {isExpanded ? <ChevronUp size={16} className="text-theme-secondary" /> : <ChevronDown size={16} className="text-theme-secondary" />}
      </div>
    </button>
  );
}
