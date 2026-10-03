/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Row/section sub-components for LineupComplianceChecklist. Split out so the
 * checklist item's action-button logic (several independent affordances, each
 * gated on its own condition) reads as named pieces instead of one long JSX
 * conditional chain.
 */

import React, { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@omniswim/ui';
import type {
  DuplicateAthletePair,
  LineupChecklistItem,
} from '@omniswim/core/lib/rosterLineupAudit';
import { buildChecklistRows, visibleChecklistRows, type ChecklistRow } from './lineupChecklistView';

const FIX_ITEM_TYPES: ReadonlySet<LineupChecklistItem['type']> = new Set([
  'relay_needs_fill',
  'relay_scorer_off',
  'relay_leg_vacant',
]);

function isRelayRelated(item: LineupChecklistItem): boolean {
  return item.group === 'relays' || item.type.startsWith('relay');
}

export type ChecklistItemHandlers = {
  onJumpAthlete?: (athleteName: string, athleteKey?: string) => void;
  onFixItem?: (item: LineupChecklistItem) => void;
  onOpenRelays?: () => void;
  onLinkDuplicate?: (pair: DuplicateAthletePair, item: LineupChecklistItem) => void;
  onDismissDuplicate?: (pair: DuplicateAthletePair, item: LineupChecklistItem) => void;
};

/** One checklist item's duplicate-athlete explanation, if it has one. */
export function ChecklistDuplicateNote({ item }: { item: LineupChecklistItem }) {
  if (!item.duplicate) return null;
  const timeMatchSuffix =
    item.duplicate.timeMatches.length > 0
      ? ` — same ${item.duplicate.timeMatches.map(t => `${t.event} ${t.time}`).join(', ')}`
      : '';
  return (
    <p className="text-ui-caption text-theme-muted leading-relaxed break-words mt-1">
      {item.duplicate.reason}
      {timeMatchSuffix}
    </p>
  );
}

type ActionSpec = {
  key: string;
  show: boolean;
  className: string;
  onClick: () => void;
  label: React.ReactNode;
};

function buildActionSpecs(
  item: LineupChecklistItem,
  handlers: ChecklistItemHandlers
): ActionSpec[] {
  const { onJumpAthlete, onFixItem, onOpenRelays, onLinkDuplicate, onDismissDuplicate } = handlers;
  return [
    {
      key: 'link',
      show: !!(item.duplicate && onLinkDuplicate),
      className: 'text-ui-caption text-[var(--text-accent)] hover:underline',
      onClick: () => onLinkDuplicate!(item.duplicate!, item),
      label: 'Link',
    },
    {
      key: 'dismiss',
      show: !!(item.duplicate && onDismissDuplicate),
      className: 'text-ui-caption text-theme-secondary hover:text-[var(--text-accent)]',
      onClick: () => onDismissDuplicate!(item.duplicate!, item),
      label: 'Not the same person',
    },
    {
      key: 'jump',
      show: !!(item.athleteName && onJumpAthlete),
      className: 'text-ui-caption text-[var(--text-accent)] hover:underline',
      onClick: () => onJumpAthlete!(item.athleteName!, item.athleteKey),
      label: 'Jump',
    },
    {
      key: 'fix',
      show: !!(onFixItem && FIX_ITEM_TYPES.has(item.type)),
      className: 'text-ui-caption text-[var(--text-accent)] hover:underline flex items-center gap-1',
      onClick: () => onFixItem!(item),
      label: 'Quick fill',
    },
    {
      key: 'relays',
      show: !!(isRelayRelated(item) && onOpenRelays),
      className: 'text-ui-caption text-theme-secondary hover:text-[var(--text-accent)] flex items-center gap-1',
      onClick: () => onOpenRelays!(),
      label: (
        <>
          Relays <ExternalLink size={11} />
        </>
      ),
    },
  ];
}

/** The row of contextual action buttons under a checklist row. Each button is
 * gated on its own independent condition (has a duplicate match, has a jump
 * target, item type accepts a quick fill, …), so the specs are built as data
 * and filtered rather than written as a chain of JSX ternaries. A row that
 * merges several items for one athlete shows each kind of action once, so it
 * has one Jump link however many problems the athlete has. */
export function ChecklistItemActions({
  items,
  handlers,
}: {
  items: readonly LineupChecklistItem[];
  handlers: ChecklistItemHandlers;
}) {
  const seen = new Set<string>();
  const actions = items
    .flatMap(item => buildActionSpecs(item, handlers))
    .filter(action => {
      if (!action.show || seen.has(action.key)) return false;
      seen.add(action.key);
      return true;
    });
  if (actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {actions.map(action => (
        <Button key={action.key} variant="ghost" size="sm" className={`p-0 ${action.className}`} onClick={action.onClick}>
          {action.label}
        </Button>
      ))}
    </div>
  );
}

/** One checklist row: the message(s), the duplicate note (if any), the action buttons. */
export function ChecklistItemRow({
  row,
  handlers,
}: {
  row: ChecklistRow;
  handlers: ChecklistItemHandlers;
}) {
  const [first] = row.items;
  return (
    <li className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme">
      {row.items.length === 1 ? (
        <p className="text-ui-caption text-[var(--text-primary)] leading-relaxed break-words">
          {first.message}
        </p>
      ) : (
        <ul className="list-disc pl-4 space-y-1 text-ui-caption text-[var(--text-primary)] leading-relaxed break-words">
          {row.items.map(item => (
            <li key={item.id}>{item.message}</li>
          ))}
        </ul>
      )}
      {row.items.length === 1 ? <ChecklistDuplicateNote item={first} /> : null}
      <ChecklistItemActions items={row.items} handlers={handlers} />
    </li>
  );
}

/** One labeled group of checklist rows (e.g. "Entry limits (3)"). Renders
 * nothing when the group is empty. The count is of problems, not rows. Only the
 * first few rows show; "Show more" reveals the rest, so a long list does not
 * add dozens of tab stops. */
export function ChecklistGroupSection({
  label,
  items,
  handlers,
}: {
  label: string;
  items: LineupChecklistItem[];
  handlers: ChecklistItemHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const rows = buildChecklistRows(items);
  const { shown, hidden } = visibleChecklistRows(rows, expanded);
  const listId = `checklist-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div>
      <h5 className="text-ui-caption font-semibold text-theme-muted mb-2">
        {label} ({items.length})
      </h5>
      <ul id={listId} className="space-y-2">
        {shown.map(row => (
          <ChecklistItemRow key={row.id} row={row} handlers={handlers} />
        ))}
      </ul>
      {hidden > 0 || expanded ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 p-0 text-ui-caption text-theme-secondary hover:text-[var(--text-accent)]"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? 'Show fewer' : `Show ${hidden} more`}
        </Button>
      ) : null}
    </div>
  );
}
