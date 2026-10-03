/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Pure view-model helpers for the Lineup compliance checklist. No React.
 *
 * The audit emits one item per problem. A swimmer with three problems in the
 * same group used to get three cards and three "Jump" links that all went to
 * the same place. A checklist row is now one athlete (or one stand-alone item),
 * so each row has at most one Jump link.
 */

import type { LineupChecklistItem } from '@omniswim/core/lib/rosterLineupAudit';

/** Rows a group shows before the rest sit behind "Show more". Keeps the list, and its tab stops, bounded. */
export const CHECKLIST_GROUP_ROW_LIMIT = 5;

export type ChecklistRow = {
  /** Stable React key: the first item's id. */
  id: string;
  /** One or more items. More than one only when they name the same athlete. */
  items: LineupChecklistItem[];
};

/**
 * Items that carry their own per-item action (a suspected duplicate pair, a
 * specific relay leg) stay on their own row: merging them would hide which leg
 * or which pair "Quick fill" and "Link" act on.
 */
function isStandalone(item: LineupChecklistItem): boolean {
  return item.duplicate != null || item.relayEntryKey != null || item.legIndex != null;
}

function athleteIdentity(item: LineupChecklistItem): string | null {
  if (item.athleteKey) return `key:${item.athleteKey}`;
  if (item.athleteName) return `name:${item.athleteName}`;
  return null;
}

/** Group one checklist group's items into rows, one row per athlete. Order follows first appearance. */
export function buildChecklistRows(items: readonly LineupChecklistItem[]): ChecklistRow[] {
  const rows: ChecklistRow[] = [];
  const byAthlete = new Map<string, ChecklistRow>();
  for (const item of items) {
    const identity = isStandalone(item) ? null : athleteIdentity(item);
    const existing = identity ? byAthlete.get(identity) : undefined;
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const row: ChecklistRow = { id: item.id, items: [item] };
    rows.push(row);
    if (identity) byAthlete.set(identity, row);
  }
  return rows;
}

/** The rows to render now, and how many are held back behind "Show more". */
export function visibleChecklistRows(
  rows: readonly ChecklistRow[],
  expanded: boolean,
  limit: number = CHECKLIST_GROUP_ROW_LIMIT
): { shown: readonly ChecklistRow[]; hidden: number } {
  if (expanded || rows.length <= limit) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, limit), hidden: rows.length - limit };
}
