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

const out = process.argv[2];
if (out === undefined) throw new Error('Pass the output file path.');

const store = new FileSystemSwimCloudCaptureStore(join(import.meta.dirname, '../fixtures/theoretical-meet'));
const list = await store.listCaptures();
const parses: Record<string, unknown> = {};
for (const record of list) parses[record.captureId] = await parseSwimCloudCapture(store, record);
writeFileSync(out, JSON.stringify({ list, parses }));
