/**
 * AthleteRosterRow ΓÇö Renders one catalog athlete and every stored event row
 * with an "eligibility" toggle. Eligibility is what feeds the scoring pool;
 * ineligible rows are kept for reference but excluded from auto scoring.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronUp, UserMinus, ToggleLeft, ToggleRight } from 'lucide-react';
import type { CatalogAthlete, CatalogEventTime } from '@omniswim/core/lib/rosterCatalog';
import { sortedTimesByScy } from '@omniswim/core/lib/rosterCatalog';

type Props = {
  athlete: CatalogAthlete & { times: CatalogEventTime[] };
  onToggleEligibility: (timeId: string, isEligible: boolean) => void;
  onDeleteTime: (timeId: string) => void;
};

const TIME_TYPE_LABEL: Record<CatalogEventTime['timeType'], string> = {
  SCY: 'SCY',
  LCM: 'LCM',
  SCM: 'SCM',
};

const CUT_BADGE: { A: string; B: string; null: string } = {
  A: 'A',
  B: 'B',
  null: '',
};

function badgeClass(cut: 'A' | 'B' | null): string {
  if (cut === 'A') return 'bg-green-700/30 text-green-300 border border-green-700/50';
  if (cut === 'B') return 'bg-yellow-700/30 text-yellow-200 border border-yellow-700/50';
  return 'text-theme-muted';
}

export default function AthleteRosterRow({ athlete, onToggleEligibility, onDeleteTime }: Props) {
  const [expanded, setExpanded] = useState(true);

  const sortedTimes = sortedTimesByScy(athlete.times);
  const eligibleCount = sortedTimes.filter(t => t.isEligible).length;
  const relayCount = sortedTimes.filter(
    t => t.event.toLowerCase().includes('relay') && t.isEligible
  ).length;

  return (
    <div className="border border-theme-soft rounded-lg surface-overlay">
      <button
        type="button"
        className="w-full px-3 py-2 flex items-center justify-between gap-2"
        onClick={() => setExpanded(s => !s)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-ui-body font-bold text-[var(--text-primary)] truncate">
            {athlete.fullName}
          </span>
          {athlete.classYear ? (
            <span className="badge-info px-2 py-0.5 rounded text-[10px]">{athlete.classYear}</span>
          ) : null}
          <span className="text-ui-caption text-theme-muted">
            {eligibleCount}/{sortedTimes.length} events eligible
            {relayCount > 0 ? ` ┬╖ ${relayCount} relays` : ''}
          </span>
        </div>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded ? (
        <div className="px-3 pb-3 pt-1 space-y-1.5">
          <SwimPills
            times={sortedTimes}
            onToggleEligibility={onToggleEligibility}
            onDeleteTime={onDeleteTime}
          />
        </div>
      ) : null}
    </div>
  );
}

function SwimPills({
  times,
  onToggleEligibility,
  onDeleteTime,
}: {
  times: CatalogEventTime[];
  onToggleEligibility: (timeId: string, isEligible: boolean) => void;
  onDeleteTime: (timeId: string) => void;
}) {
  if (times.length === 0) {
    return <p className="text-ui-caption text-theme-muted italic px-3">No events recorded.</p>;
  }

  return (
    <ul className="flex flex-wrap gap-2">
      {times.map(t => (
        <li
          key={t.id}
          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border text-ui-caption ${
            t.isEligible
              ? 'border-[var(--text-accent)]/40 bg-[var(--text-accent)]/10'
              : 'border-theme-soft bg-[var(--surface-muted)] opacity-50 hover:opacity-90'
          }`}
        >
          <button
            type="button"
            onClick={() => onToggleEligibility(t.id, !t.isEligible)}
            title={t.isEligible ? 'Drop from scoring pool' : 'Add back to scoring pool'}
            className="p-0.5 hover:text-[var(--text-accent)]"
            aria-label={t.isEligible ? 'Disable event' : 'Enable event'}
          >
            {t.isEligible ? <ToggleRight size={14} className="text-[var(--text-accent)]" /> : <ToggleLeft size={14} />}
          </button>
          <span className="font-bold">{t.event}</span>
          <span className="font-mono">{t.timeText}</span>
          <span className="text-[10px] text-theme-muted">{TIME_TYPE_LABEL[t.timeType] ?? t.timeType}</span>
          {t.computedCut ? (
            <span className={`px-1 rounded text-[10px] font-bold ${badgeClass(t.computedCut)}`}>
              {CUT_BADGE[t.computedCut]}
            </span>
          ) : null}
          {t.swimcloudBadge ? (
            <span
              className="px-1 rounded text-[10px] border border-theme-soft text-theme-secondary"
              title="SwimCloud stamp"
            >
              {t.swimcloudBadge}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => onDeleteTime(t.id)}
            className="p-0.5 text-theme-secondary hover:text-red-400"
            aria-label={`Delete ${t.event} ${t.timeText}`}
            title="Delete this record"
          >
            <UserMinus size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** export for tests */
export { badgeClass };
