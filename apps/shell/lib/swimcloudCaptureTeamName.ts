/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The school name of a team capture, read from its own stored roster pages.
 *
 * `GET /api/swimcloud/captures` uses this so the "Build theoretical meet"
 * dialog can name a team whose capture was filed before the extension began to
 * send a label. It reads bytes already on disk. It makes no request to SwimCloud.
 *
 * Provenance rules (CLAUDE.md "Data provenance"):
 * - The name is the one the roster page prints, read by `parseTeamRosterHtml`.
 *   There is no second extraction.
 * - Every readable roster page must print the same name. If two differ, there
 *   is no name, only a warning. The caller keeps the numeric team id.
 * - No readable roster page, or none that prints a name: no name, no warning.
 *   Absent is not "Team N".
 */

import type { FileSystemSwimCloudCaptureStore, SwimCloudCaptureRecord } from '../../../packages/swimcloud/src/captureStore.ts';
import { parseTeamRosterHtml } from '../../../packages/swimcloud/src/parser.ts';

export interface CaptureTeamName {
  readonly teamName?: string;
  readonly teamNameWarning?: string;
}

/** Pure: collapse the names the roster pages printed into one answer. */
export function decideTeamName(captureId: string, printed: readonly string[]): CaptureTeamName {
  const distinct = [...new Set(printed.map(n => n.trim()).filter(n => n.length > 0))];
  if (distinct.length === 0) return {};
  if (distinct.length === 1) return { teamName: distinct[0] };
  return {
    teamNameWarning: `The roster pages of capture ${captureId} print different team names (${distinct.join(' / ')}), so no school name is shown.`,
  };
}

export async function readCaptureTeamName(
  store: FileSystemSwimCloudCaptureStore,
  record: SwimCloudCaptureRecord,
): Promise<CaptureTeamName> {
  if (record.subject.kind !== 'team') return {};
  const printed: string[] = [];
  for (const page of record.pages) {
    if (page.resourceKind !== 'teamRoster' || page.outcome !== 'ok') continue;
    const entry = await store.readPage(page.canonicalUrl);
    if (entry?.html === undefined) continue;
    try {
      const parsed = parseTeamRosterHtml(entry.html, {
        sourceUrl: page.canonicalUrl,
        retrievedAt: page.retrievedAt,
        track: record.track,
      });
      if (parsed.ok && parsed.data.teamName !== undefined) printed.push(parsed.data.teamName);
    } catch {
      // An unreadable page contributes nothing. The parse route reports it properly.
    }
  }
  return decideTeamName(record.captureId, printed);
}

/**
 * Answer for the capture list. A record that already has a label keeps it.
 * Otherwise the name is read from the stored pages and cached in `label`
 * (once; a conflict is never cached). A crawl in progress is not written to,
 * so the cache write cannot race the crawl's own updates.
 */
export async function withTeamName(
  store: FileSystemSwimCloudCaptureStore,
  record: SwimCloudCaptureRecord,
): Promise<SwimCloudCaptureRecord & CaptureTeamName> {
  if (record.subject.kind !== 'team') return record;
  if (record.label !== undefined && record.label.trim().length > 0) return { ...record, teamName: record.label.trim() };
  const found = await readCaptureTeamName(store, record);
  if (found.teamName === undefined || record.completeness === 'in-progress') return { ...record, ...found };
  const saved = await store.upsertCapture({ ...record, label: found.teamName });
  return { ...saved, teamName: found.teamName };
}
