/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Sticky compliance checklist for roster Lineup step.
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import type { LineupChecklistItem, TeamLineupAudit } from '@omniswim/core/lib/rosterLineupAudit';

type Props = {
  audit: TeamLineupAudit;
  onJumpAthlete?: (athleteName: string) => void;
  onFixItem?: (item: LineupChecklistItem) => void;
  onOpenRelays?: () => void;
};

const GROUP_LABEL: Record<LineupChecklistItem['group'], string> = {
  entries: 'Entry limits',
  lineups: 'Empty lineups',
  relays: 'Relay gaps',
};

export default function LineupComplianceChecklist({
  audit,
  onJumpAthlete,
  onFixItem,
  onOpenRelays,
}: Props) {
  const [mobileOpen, setMobileOpen] = useState(true);
  const items = audit.checklistItems;
  const count = items.length;

  const grouped = useMemo(() => {
    const map: Record<LineupChecklistItem['group'], LineupChecklistItem[]> = {
      entries: [],
      lineups: [],
      relays: [],
    };
    for (const item of items) {
      map[item.group].push(item);
    }
    return map;
  }, [items]);

  const body = (
    <div className="space-y-4">
      {count === 0 ? (
        <div className="flex items-start gap-2 text-ui-body text-theme-secondary leading-relaxed">
          <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-[var(--text-accent)]" />
          <p>No compliance issues for this team. Entry limits, scorers, and relay legs look clear.</p>
        </div>
      ) : (
        (['entries', 'lineups', 'relays'] as const).map(group => {
          const list = grouped[group];
          if (list.length === 0) return null;
          return (
            <div key={group}>
              <h5 className="text-ui-caption font-semibold text-theme-muted mb-2">
                {GROUP_LABEL[group]} ({list.length})
              </h5>
              <ul className="space-y-2">
                {list.map(item => (
                  <li
                    key={item.id}
                    className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5"
                  >
                    <p className="text-ui-caption text-[var(--text-primary)] leading-relaxed break-words">
                      {item.message}
                    </p>
                    <div className="flex flex-wrap gap-2 mt-2">
                      {item.athleteName && onJumpAthlete ? (
                        <button
                          type="button"
                          className="text-ui-caption text-[var(--text-accent)] hover:underline"
                          onClick={() => onJumpAthlete(item.athleteName!)}
                        >
                          Jump
                        </button>
                      ) : null}
                      {onFixItem &&
                      (item.type === 'relay_needs_fill' ||
                        item.type === 'relay_scorer_off' ||
                        item.type === 'relay_leg_vacant') ? (
                        <button
                          type="button"
                          className="text-ui-caption text-[var(--text-accent)] hover:underline flex items-center gap-1"
                          onClick={() => onFixItem(item)}
                        >
                          Quick fill
                        </button>
                      ) : null}
                      {(item.group === 'relays' || item.type.startsWith('relay')) && onOpenRelays ? (
                        <button
                          type="button"
                          className="text-ui-caption text-theme-secondary hover:text-[var(--text-accent)] flex items-center gap-1"
                          onClick={onOpenRelays}
                        >
                          Relays <ExternalLink size={11} />
                        </button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })
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
              <span className="ml-auto text-ui-caption font-mono text-amber-400">{count}</span>
            ) : null}
          </div>
          {body}
        </div>
      </aside>
    </>
  );
}
