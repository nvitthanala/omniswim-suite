/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Row/section sub-components for LineupComplianceChecklist. Split out so the
 * checklist item's action-button logic (several independent affordances, each
 * gated on its own condition) reads as named pieces instead of one long JSX
 * conditional chain.
 */

import React from 'react';
import { ExternalLink } from 'lucide-react';
import type {
  DuplicateAthletePair,
  LineupChecklistItem,
} from '@omniswim/core/lib/rosterLineupAudit';

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

/** The row of contextual action buttons under a checklist item. Each button is
 * gated on its own independent condition (has a duplicate match, has a jump
 * target, item type accepts a quick fill, …), so the specs are built as data
 * and filtered rather than written as a chain of JSX ternaries. */
export function ChecklistItemActions({
  item,
  handlers,
}: {
  item: LineupChecklistItem;
  handlers: ChecklistItemHandlers;
}) {
  const actions = buildActionSpecs(item, handlers).filter(action => action.show);
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {actions.map(action => (
        <button key={action.key} type="button" className={action.className} onClick={action.onClick}>
          {action.label}
        </button>
      ))}
    </div>
  );
}

/** One checklist item: message, duplicate note (if any), action buttons. */
export function ChecklistItemRow({
  item,
  handlers,
}: {
  item: LineupChecklistItem;
  handlers: ChecklistItemHandlers;
}) {
  return (
    <li className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 transition-colors hover:border-theme">
      <p className="text-ui-caption text-[var(--text-primary)] leading-relaxed break-words">
        {item.message}
      </p>
      <ChecklistDuplicateNote item={item} />
      <ChecklistItemActions item={item} handlers={handlers} />
    </li>
  );
}

/** One labeled group of checklist items (e.g. "Entry limits (3)"). Renders
 * nothing when the group is empty. */
export function ChecklistGroupSection({
  label,
  items,
  handlers,
}: {
  label: string;
  items: LineupChecklistItem[];
  handlers: ChecklistItemHandlers;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h5 className="text-ui-caption font-semibold text-theme-muted mb-2">
        {label} ({items.length})
      </h5>
      <ul className="space-y-2">
        {items.map(item => (
          <ChecklistItemRow key={item.id} item={item} handlers={handlers} />
        ))}
      </ul>
    </div>
  );
}
