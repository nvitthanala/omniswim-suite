/**
 * Not a spec. Run by tests/e2e/theoretical-meet.spec.ts through `tsx`:
 *
 *   node node_modules/tsx/dist/cli.mjs tests/e2e/theoreticalMeetCaptureMocks.ts <out.json>
 *
 * It writes the bodies the mocked capture routes return, built from the committed fixtures in
 * tests/fixtures/theoretical-meet with the same functions the data-layer golden test uses:
 * `FileSystemSwimCloudCaptureStore.listCaptures()` for the list and `parseSwimCloudCapture` for each parse.
 * Playwright's own loader cannot import those modules (the core data files are JSON imports), so this
 * runs in its own process.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemSwimCloudCaptureStore } from '../../packages/swimcloud/src/captureStore';
import { parseSwimCloudCapture } from '../../apps/shell/lib/swimcloudCaptureRoutes';
import { readCaptureTeamName } from '../../apps/shell/lib/swimcloudCaptureTeamName';

const out = process.argv[2];
if (out === undefined) throw new Error('Pass the output file path.');

const store = new FileSystemSwimCloudCaptureStore(join(import.meta.dirname, '../fixtures/theoretical-meet'));
const records = await store.listCaptures();
const parses: Record<string, unknown> = {};
for (const record of records) parses[record.captureId] = await parseSwimCloudCapture(store, record);

// What GET /api/swimcloud/captures returns after the school-name change. The fixture records carry no
// label. Team 412 is shown as a capture the extension labelled (a new crawl). The others are shown as
// old captures: the server reads the name from their stored roster pages (`readCaptureTeamName`, the
// same function the route calls) and reports it as `teamName`.
const names: Record<string, string> = {};
const list: unknown[] = [];
for (const record of records) {
  const found = await readCaptureTeamName(store, record);
  if (found.teamName === undefined || record.subject.kind !== 'team') throw new Error(`fixture ${record.captureId} prints no team name`);
  names[record.subject.teamId] = found.teamName;
  list.push(record.captureId === 'team-412-2026-2027' ? { ...record, label: found.teamName } : { ...record, ...found });
}
writeFileSync(out, JSON.stringify({ list, parses, names }));
