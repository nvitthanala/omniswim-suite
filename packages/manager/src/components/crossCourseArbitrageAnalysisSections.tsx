/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Converted-time upgrades" and "Coverage gaps" — the two read-only,
 * informational sections of CrossCourseArbitragePanel (no Apply action, no
 * undo). Split out of the former crossCourseArbitrageSections.tsx (see git
 * history). Pure extraction, no behavior change.
 */

import React from 'react';
import { Gauge, Users } from 'lucide-react';
import { AthleteButton, Section, ShowAllToggle, StalePill } from './crossCourseArbitrageParts';
import { formatMargin } from './crossCourseArbitrageView';
import type { CoverageGap, CrossCourseRow } from '@omniswim/core/lib/crossCourseArbitrage';

export function ConvertedTimeUpgradesSection({
  edges,
  shownEdges,
  edgesExpanded,
  edgesLimit,
  onToggleExpanded,
  onJumpAthlete,
}: {
  edges: CrossCourseRow[];
  shownEdges: CrossCourseRow[];
  edgesExpanded: boolean;
  edgesLimit: number;
  onToggleExpanded: () => void;
  onJumpAthlete?: (name: string) => void;
}) {
  return (
    <Section
      title="Converted-time upgrades"
      icon={<Gauge size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={`(${edges.length})`}
    >
      {edges.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No LCM/SCM swim converts faster than an actual SCY best — conversion adds no new
          candidates for this team.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shownEdges.map(row => (
              <li
                key={`${row.athlete}|${row.event}`}
                className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex items-baseline gap-1.5">
                    <AthleteButton
                      name={row.athlete}
                      onJumpAthlete={onJumpAthlete}
                      className="text-ui-caption max-w-[8rem]"
                    />
                    <span className="text-ui-caption text-theme-muted truncate">{row.event}</span>
                    {row.scyBest?.stale || row.convertedBest?.stale ? <StalePill /> : null}
                  </div>
                  <span className="text-ui-caption font-mono tabular-nums text-[var(--text-accent)] shrink-0">
                    {formatMargin(row.convertedWinsBy ?? 0)}
                  </span>
                </div>
                {row.scyBest && row.convertedBest ? (
                  <p className="text-ui-micro font-mono tabular-nums text-theme-secondary mt-1 truncate">
                    {row.scyBest.time} vs {row.convertedBest.time}c · {row.convertedBest.sourceCourse}{' '}
                    {row.convertedBest.sourceTime}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <ShowAllToggle
            shown={edgesLimit}
            total={edges.length}
            expanded={edgesExpanded}
            onToggle={onToggleExpanded}
          />
          <p className="text-ui-micro text-theme-muted mt-2.5 leading-relaxed">
            Converted times are estimates from standard factors and already feed the swap
            candidates above.
          </p>
        </>
      )}
    </Section>
  );
}

export function CoverageGapsSection({ gaps }: { gaps: CoverageGap[] }) {
  return (
    <Section
      title="Coverage gaps"
      icon={<Users size={14} className="text-[var(--text-accent)] shrink-0" />}
      countLabel={`(${gaps.length})`}
    >
      {gaps.length === 0 ? (
        <p className="text-ui-caption text-theme-secondary leading-relaxed">
          No coverage gaps for this team.
        </p>
      ) : (
        <ul className="space-y-2">
          {gaps.map((gap: CoverageGap) => (
            <li
              key={gap.event}
              className={`rounded-lg border px-3 py-2 flex items-center justify-between gap-2 transition-colors ${
                gap.countTeamEntries === 0
                  ? 'border-[var(--text-accent)]/30 bg-[var(--text-accent)]/5'
                  : 'border-theme-soft surface-muted-bg'
              }`}
            >
              <span
                className={`text-ui-caption truncate ${
                  gap.countTeamEntries === 0
                    ? 'text-[var(--text-primary)] font-medium'
                    : 'text-theme-secondary'
                }`}
              >
                {gap.event}
              </span>
              <span
                className={`text-ui-caption font-mono tabular-nums shrink-0 ${
                  gap.countTeamEntries === 0 ? 'text-[var(--text-accent)]' : 'text-theme-muted'
                }`}
              >
                {gap.countTeamEntries} entered · {gap.openSlots} open
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
