/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One row of TeamRosterPanel's roster table. Split out so the per-row JSX
 * (warning chip, profile tooltip, scorer checkbox, remove button) lives in
 * its own small component instead of one long closure inside the panel's
 * `.map()`. Removing an athlete: this row's icon-only Remove button (decision
 * U6), the drawer's Remove, or the Delete key on the roster list. All three
 * open the same Hide or Remove confirmation.
 */

import React from 'react';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import type { AthleteEventProfile } from '@omniswim/core/types';
import AthleteRemoveButton from './AthleteRemoveButton';
import AthleteRoleTag from './AthleteRoleTag';
import { formatEventLabelForDisplay, rosterRowDomId } from './teamRosterView';

type Props = {
  row: ScorerRosterRow;
  meetPts: number;
  isSelected: boolean;
  profile: AthleteEventProfile | null;
  describeProfile: (profile: AthleteEventProfile) => string;
  warningMessages: string[];
  warningLabel: string | null;
  editable: boolean;
  /** Skip the "Swimmer" tag because every row in the table would show it. */
  hideSwimmerTag?: boolean;
  /** Reserve the trailing Remove cell. True for every row once the table has a Remove column. */
  showRemoveColumn?: boolean;
  /** Asks to remove this athlete. It opens the Hide or Remove confirmation; it never removes by itself. */
  onRequestRemove?: () => void;
  onSelect: () => void;
  onSetScorer: (isScorer: boolean) => void;
};

function RowWarningChip({ messages, label }: { messages: string[]; label: string }) {
  return (
    <span
      className="text-ui-caption px-1.5 py-0.5 rounded-full border border-warning text-warning shrink-0"
      title={messages.join(' · ')}
    >
      {label}
      {messages.length > 1 ? ` +${messages.length - 1}` : ''}
    </span>
  );
}

export default function TeamRosterRow({
  row,
  meetPts,
  isSelected,
  profile,
  describeProfile,
  warningMessages,
  warningLabel,
  editable,
  hideSwimmerTag = false,
  showRemoveColumn = false,
  onRequestRemove,
  onSelect,
  onSetScorer,
}: Props) {
  const showProfileHint = Boolean(profile && profile.primaryEvents.length > 0 && !isSelected);

  return (
    <tr
      id={rosterRowDomId(row.key)}
      role="option"
      aria-selected={isSelected}
      onClick={onSelect}
      className={`border-b border-theme-soft/50 text-ui-body cursor-pointer transition-colors ${
        isSelected ? 'bg-[var(--text-accent)]/10' : 'theme-hover-row'
      }`}
    >
      <td className="py-2.5 px-3" title={row.name}>
        <div className="flex items-center gap-2 min-w-0 flex-wrap">
          <span className={`truncate min-w-0 ${isSelected ? 'text-[var(--text-accent)] font-medium' : ''}`}>
            {row.name}
          </span>
          <AthleteRoleTag role={row.athleteRole} isRecruit={row.isRecruit} hideSwimmer={hideSwimmerTag} />
          {warningLabel ? <RowWarningChip messages={warningMessages} label={warningLabel} /> : null}
        </div>
        {showProfileHint && profile ? (
          <p className="text-ui-caption text-theme-muted truncate mt-1" title={describeProfile(profile)}>
            {profile.primaryEvents
              .slice(0, 3)
              .map(formatEventLabelForDisplay)
              .join(' · ')}
          </p>
        ) : null}
      </td>
      <td className="py-2.5 px-3 text-right text-theme-secondary whitespace-nowrap">{row.classYear || '—'}</td>
      <td
        className={`py-2.5 px-3 text-right font-mono tabular-nums whitespace-nowrap ${
          meetPts > 0 ? 'text-[var(--text-accent)]' : 'text-theme-secondary'
        }`}
      >
        {meetPts.toFixed(1)}
      </td>
      {editable ? (
        <td className="py-2.5 px-3 text-center" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={row.isScorer}
            onChange={e => onSetScorer(e.target.checked)}
            className="accent-[var(--text-accent)]"
            aria-label={`${row.name} scorer`}
          />
        </td>
      ) : null}
      {showRemoveColumn ? (
        // Its own cell, set apart from the scorer box by a rule, so it is not hit by a miss-click on
        // the scorer box. The click must not toggle the row's selection.
        <td className="py-2.5 px-2 text-center border-l border-theme-soft/50" onClick={e => e.stopPropagation()}>
          {onRequestRemove ? (
            <AthleteRemoveButton athleteName={row.name} onRequestRemove={onRequestRemove} iconOnly />
          ) : null}
        </td>
      ) : null}
    </tr>
  );
}
