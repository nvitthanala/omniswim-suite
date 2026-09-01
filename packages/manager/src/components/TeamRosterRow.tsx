/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * One row of TeamRosterPanel's roster table. Split out so the per-row JSX
 * (warning chip, profile tooltip, scorer checkbox, remove button) lives in
 * its own small component instead of one long closure inside the panel's
 * `.map()`.
 */

import React from 'react';
import { Trash2 } from 'lucide-react';
import type { ScorerRosterRow } from '@omniswim/core/lib/scorerRoster';
import type { AthleteEventProfile } from '@omniswim/core/types';
import AthleteRoleTag from './AthleteRoleTag';

type Props = {
  row: ScorerRosterRow;
  meetPts: number;
  isSelected: boolean;
  profile: AthleteEventProfile | null;
  describeProfile: (profile: AthleteEventProfile) => string;
  warningMessages: string[];
  warningLabel: string | null;
  editable: boolean;
  onRequestDeleteSwimmer?: (name: string) => void;
  onSelect: () => void;
  onSetScorer: (isScorer: boolean) => void;
};

function RowWarningChip({ messages, label }: { messages: string[]; label: string }) {
  return (
    <span
      className="text-ui-caption px-1.5 py-0.5 rounded-full border border-amber-400/40 text-amber-400 shrink-0"
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
  onRequestDeleteSwimmer,
  onSelect,
  onSetScorer,
}: Props) {
  const showProfileHint = Boolean(profile && profile.primaryEvents.length > 0 && !isSelected);

  return (
    <tr
      id={`roster-row-${row.key}`}
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
          <AthleteRoleTag role={row.athleteRole} isRecruit={row.isRecruit} />
          {warningLabel ? <RowWarningChip messages={warningMessages} label={warningLabel} /> : null}
        </div>
        {showProfileHint && profile ? (
          <p className="text-ui-caption text-theme-muted truncate mt-1" title={describeProfile(profile)}>
            {profile.primaryEvents.slice(0, 3).join(' · ')}
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
      {editable && onRequestDeleteSwimmer ? (
        <td className="py-2.5 px-2 text-center" onClick={e => e.stopPropagation()}>
          <button
            type="button"
            className="p-1.5 rounded-lg text-theme-muted hover:text-rose-400 hover:bg-rose-400/10"
            title={`Remove ${row.name} from roster (keeps meet record)`}
            aria-label={`Remove ${row.name}`}
            onClick={() => onRequestDeleteSwimmer(row.name)}
          >
            <Trash2 size={14} />
          </button>
        </td>
      ) : null}
    </tr>
  );
}
