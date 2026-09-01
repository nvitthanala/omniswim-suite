/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Sticky compliance checklist for roster Lineup step.
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react';
import type {
  DuplicateAthletePair,
  LineupChecklistItem,
  TeamLineupAudit,
} from '@omniswim/core/lib/rosterLineupAudit';
import { ChecklistGroupSection, type ChecklistItemHandlers } from './LineupComplianceChecklistParts';

type Props = {
  audit: TeamLineupAudit;
  onJumpAthlete?: (athleteName: string, athleteKey?: string) => void;
  onFixItem?: (item: LineupChecklistItem) => void;
  onOpenRelays?: () => void;
  /** Confirm a suspected split athlete — record the alias link. */
  onLinkDuplicate?: (pair: DuplicateAthletePair, item: LineupChecklistItem) => void;
  /** Reject a suspected split athlete — record the suppression tombstone. */
  onDismissDuplicate?: (pair: DuplicateAthletePair, item: LineupChecklistItem) => void;
};

const GROUP_LABEL: Record<LineupChecklistItem['group'], string> = {
  entries: 'Entry limits',
  lineups: 'Empty lineups',
  relays: 'Relay gaps',
  roster: 'Duplicate athletes',
};

export default function LineupComplianceChecklist({
  audit,
  onJumpAthlete,
  onFixItem,
  onOpenRelays,
  onLinkDuplicate,
  onDismissDuplicate,
}: Props) {
  const [mobileOpen, setMobileOpen] = useState(true);
  const items = audit.checklistItems;
  const count = items.length;

  const grouped = useMemo(() => {
    const map: Record<LineupChecklistItem['group'], LineupChecklistItem[]> = {
      entries: [],
      lineups: [],
      relays: [],
      roster: [],
    };
    for (const item of items) {
      map[item.group].push(item);
    }
    return map;
  }, [items]);

  const handlers: ChecklistItemHandlers = {
    onJumpAthlete,
    onFixItem,
    onOpenRelays,
    onLinkDuplicate,
    onDismissDuplicate,
  };

  const body = (
    <div className="space-y-4">
      {count === 0 ? (
        <div className="flex items-start gap-2 text-ui-body text-theme-secondary leading-relaxed">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
          <p>
            No compliance issues for this team. Entry limits, scorers, relay legs, and athlete
            names look clear.
          </p>
        </div>
      ) : (
        (['entries', 'lineups', 'relays', 'roster'] as const).map(group => (
          <ChecklistGroupSection
            key={group}
            label={GROUP_LABEL[group]}
            items={grouped[group]}
            handlers={handlers}
          />
        ))
      )}
    </div>
  );

  return (
    <>
      {/* Mobile summary */}
      <div className="lg:hidden surface-card rounded-xl border border-theme-soft overflow-hidden">
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
          onClick={() => setMobileOpen(v => !v)}
        >
          <span className="flex items-center gap-2 text-ui-label font-semibold text-[var(--text-primary)]">
            <AlertTriangle
              size={16}
              className={count > 0 ? 'text-amber-400' : 'text-[var(--text-accent)]'}
            />
            Checklist {count > 0 ? `(${count})` : ''}
          </span>
          {mobileOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {mobileOpen ? <div className="px-4 pb-4 border-t border-theme-soft pt-3">{body}</div> : null}
      </div>

      {/* Desktop sticky */}
      <aside className="hidden lg:block">
        <div className="sticky top-4 surface-card rounded-xl border border-theme-soft p-4 max-h-[calc(100vh-6rem)] overflow-y-auto custom-scrollbar">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle
              size={16}
              className={count > 0 ? 'text-amber-400' : 'text-[var(--text-accent)]'}
            />
            <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
              Compliance checklist
            </h4>
            {count > 0 ? (
              <span className="ml-auto text-ui-caption font-mono tabular-nums text-amber-400">{count}</span>
            ) : null}
          </div>
          {body}
        </div>
      </aside>
    </>
  );
}
