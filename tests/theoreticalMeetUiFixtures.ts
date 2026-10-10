/**
 * Shared helpers for the theoretical-meet UI tests. Not a test file.
 *
 * The capture API is faked over the committed trimmed fixtures in `tests/fixtures/theoretical-meet`
 * (the same store the golden test reads), so the list records and the parse responses are the real
 * shapes the routes return. Nothing here is a competition value.
 */
import { join } from 'node:path';
import { FileSystemSwimCloudCaptureStore } from '../packages/swimcloud/src/captureStore';
import { parseSwimCloudCapture } from '../apps/shell/lib/swimcloudCaptureRoutes';
import type { CaptureApi } from '../packages/manager/src/components/theoreticalMeet/captureApi';
import type { CaptureListRecord } from '../packages/manager/src/components/theoreticalMeet/theoreticalMeetView';
import type { TheoreticalCaptureParse } from '../packages/manager/src/lib/theoreticalMeetFromCaptures';

export const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures', 'theoretical-meet');
export const CAPTURE_IDS = ['team-412-2026-2027', 'team-58-2026-2027', 'team-48-2026-2027'] as const;

/** The records as the list route returns them, from the fixture store. */
export async function fixtureRecords(): Promise<CaptureListRecord[]> {
  const store = new FileSystemSwimCloudCaptureStore(FIXTURE_ROOT);
  return (await store.listCaptures()) as unknown as CaptureListRecord[];
}

/** The parse response of one fixture capture, as the parse route returns it. */
export async function fixtureParse(captureId: string): Promise<TheoreticalCaptureParse> {
  const store = new FileSystemSwimCloudCaptureStore(FIXTURE_ROOT);
  const record = await store.getCapture(captureId);
  if (record === undefined) throw new Error(`no fixture capture ${captureId}`);
  return (await parseSwimCloudCapture(store, record)) as unknown as TheoreticalCaptureParse;
}

export interface FakeApi extends CaptureApi {
  readonly listCalls: number;
  readonly parseCalls: string[];
}

/** A capture API over the fixtures. `records` replaces the list. `failParse` makes a capture fail its first read. */
export function fakeCaptureApi(options: { records?: CaptureListRecord[]; failParseOnce?: readonly string[] } = {}): FakeApi {
  const failures = new Set(options.failParseOnce ?? []);
  const state = { listCalls: 0, parseCalls: [] as string[] };
  return {
    get listCalls() {
      return state.listCalls;
    },
    get parseCalls() {
      return state.parseCalls;
    },
    async listCaptures() {
      state.listCalls += 1;
      return options.records ?? (await fixtureRecords());
    },
    async parseCapture(captureId: string) {
      state.parseCalls.push(captureId);
      if (failures.delete(captureId)) throw new Error('simulated network failure');
      return fixtureParse(captureId);
    },
  };
}
