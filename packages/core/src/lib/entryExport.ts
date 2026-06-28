/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Generate meet-entry exports from a workspace's planned entries.
 *
 * Two formats:
 *   - CSV  : universal, opens in Excel / imports to most meet software
 *   - HY-ENTRIES (HyTek-style entry list): a readable line-per-entry text
 *     format approximating a Team Manager entry export. (Not a binary .hy3 —
 *     a plain-text, human- and import-friendly approximation.)
 */
import { Gender, type PlannedSwimEntry, type Workspace } from '../types';

export type EntryExport = {
  filename: string;
  mimeType: string;
  content: string;
  count: number;
};

/** Entries that should appear in the export (active overlay or full plan). */
export function selectActiveEntries(workspace: Workspace): PlannedSwimEntry[] {
  const plans = workspace.meetEntryPlans ?? [];
  const activeIds = workspace.activeEntryIds;
  if (activeIds && activeIds.length > 0) {
    const set = new Set(activeIds);
    return plans.filter(p => set.has(p.id) || p.active);
  }
  return plans.filter(p => p.active !== false);
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function exportEntriesCsv(workspace: Workspace): EntryExport {
  const entries = selectActiveEntries(workspace);
  const header = ['Last Name', 'First Name', 'Full Name', 'Team', 'Gender', 'Class', 'Event', 'Seed Time', 'Course'];
  const rows = entries.map(e => {
    const { first, last } = splitName(e.name);
    return [
      last,
      first,
      e.name,
      e.team,
      e.gender === Gender.WOMEN ? 'F' : 'M',
      String(e.classYear ?? ''),
      e.event,
      e.time || 'NT',
      e.timeType ?? 'SCY',
    ].map(c => csvEscape(String(c)));
  });
  const content = [header.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const label = (workspace.loadedMeet?.meetLabel || workspace.name || 'entries').replace(/[^\w.-]+/g, '_');
  return {
    filename: `${label}-entries.csv`,
    mimeType: 'text/csv',
    content,
    count: entries.length,
  };
}

/**
 * HyTek-style readable entry list. Groups by team then event. This is a
 * text approximation suitable for review/manual import, NOT a binary HY3.
 */
export function exportEntriesHytek(workspace: Workspace): EntryExport {
  const entries = selectActiveEntries(workspace);
  const meetLabel = workspace.loadedMeet?.meetLabel || workspace.name || 'Meet';
  const lines: string[] = [];
  lines.push(`; HyTek-style entry list (text approximation)`);
  lines.push(`; Meet: ${meetLabel}`);
  lines.push(`; Generated: ${new Date().toISOString()}`);
  lines.push(`; Entries: ${entries.length}`);
  lines.push('');

  const byTeam = new Map<string, PlannedSwimEntry[]>();
  for (const e of entries) {
    const key = e.team || 'Unattached';
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key)!.push(e);
  }

  for (const [team, teamEntries] of [...byTeam.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`#TEAM ${team}`);
    const sorted = [...teamEntries].sort(
      (a, b) => a.name.localeCompare(b.name) || a.event.localeCompare(b.event)
    );
    for (const e of sorted) {
      const { first, last } = splitName(e.name);
      const sex = e.gender === Gender.WOMEN ? 'F' : 'M';
      lines.push(
        `D1 ${last}\t${first}\t${sex}\t${e.classYear ?? ''}\t${e.event}\t${e.time || 'NT'}\t${e.timeType ?? 'SCY'}`
      );
    }
    lines.push('');
  }

  const label = meetLabel.replace(/[^\w.-]+/g, '_');
  return {
    filename: `${label}-entries.hytek.txt`,
    mimeType: 'text/plain',
    content: lines.join('\r\n'),
    count: entries.length,
  };
}

function splitName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  // "Last, First" form
  if (trimmed.includes(',')) {
    const [last, first] = trimmed.split(',', 2);
    return { first: (first ?? '').trim(), last: (last ?? '').trim() };
  }
  // "First Last" form
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}
