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
  program: 'Program provenance',
  provenance: 'Converted-time cuts',
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
      program: [],
      provenance: [],
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
        (['entries', 'lineups', 'relays', 'roster', 'program', 'provenance'] as const).map(group => (
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

  // One body, rendered once. Below lg the header is a toggle and the body can
  // collapse; from lg up the header is a plain title and the body is always shown.
  // (Two copies of the body, one per breakpoint, doubled every button in the DOM.)
  return (
    <aside
      aria-label="Compliance checklist"
      className="surface-card rounded-xl border border-theme-soft overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto custom-scrollbar"
    >
      <button
        type="button"
        className="lg:hidden w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen(v => !v)}
      >
        <span className="flex items-center gap-2 text-ui-label font-semibold text-[var(--text-primary)]">
          <AlertTriangle
            size={16}
            className={count > 0 ? 'text-warning' : 'text-[var(--text-accent)]'}
          />
          Checklist {count > 0 ? `(${count})` : ''}
        </span>
        {mobileOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      <div className="hidden lg:flex items-center gap-2 px-4 pt-4 mb-3">
        <AlertTriangle
          size={16}
          className={count > 0 ? 'text-warning' : 'text-[var(--text-accent)]'}
        />
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">Compliance checklist</h4>
        {count > 0 ? (
          <span className="ml-auto text-ui-caption font-mono tabular-nums text-warning">{count}</span>
        ) : null}
      </div>
      <div
        className={`px-4 pb-4 pt-3 border-t border-theme-soft lg:border-t-0 lg:pt-0 ${
          mobileOpen ? 'block' : 'hidden lg:block'
        }`}
      >
        {body}
      </div>
    </aside>
  );
}
