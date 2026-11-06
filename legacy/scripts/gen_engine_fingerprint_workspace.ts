/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Writes `tests/fixtures/engineExtractionFingerprintTheoretical.workspace.json`, the workspace
 * that `tests/engineExtractionFingerprintTheoretical.test.ts` fingerprints (D2 E1).
 *
 * It runs the chain and the parameters of `legacy/tests/theoreticalMeetGolden.test.ts`
 * (`runChain`, lines 94-102, and the constants at lines 59-67): the three committed capture
 * records in `tests/fixtures/theoretical-meet/`, SCY, conference `NSISC`, the NSISC preset,
 * `WORKSPACE_ID = 'ws-theoretical-golden'`, `CREATED_AT = 1_760_000_000_000`, no `eventOrder`,
 * no relays. The output is the built workspace payload, unmodified.
 *
 * Run: `npx tsx legacy/scripts/gen_engine_fingerprint_workspace.ts`
 * The run is deterministic. Run it twice: the bytes must match.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FileSystemSwimCloudCaptureStore } from '../../packages/swimcloud/src/captureStore.ts';
import { parseSwimCloudCapture } from '../apps/shell/lib/swimcloudCaptureRoutes.ts';
import { presetIdForConference, settingsForBuiltInScoringPreset } from '../../packages/core/src/lib/scoringDefaults.ts';
import { theoreticalMeetFromCaptures, type TheoreticalCaptureDeps } from '../packages/manager/src/lib/theoreticalMeetFromCaptures.ts';
import { buildTheoreticalMeetSeeds } from '../packages/manager/src/lib/theoreticalMeetSeeds.ts';
import { buildTheoreticalMeetWorkspace } from '../packages/manager/src/lib/theoreticalMeetWorkspace.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE_ROOT = join(root, 'tests', 'fixtures', 'theoretical-meet');
const OUT = join(root, 'tests', 'fixtures', 'engineExtractionFingerprintTheoretical.workspace.json');
const CAPTURE_IDS = ['team-412-2026-2027', 'team-58-2026-2027', 'team-48-2026-2027'];
const WORKSPACE_ID = 'ws-theoretical-golden';
const CREATED_AT = 1_760_000_000_000;

const store = new FileSystemSwimCloudCaptureStore(FIXTURE_ROOT);
const deps: TheoreticalCaptureDeps = {
  listCaptures: async () => store.listCaptures(),
  parseCapture: async captureId => {
    const record = await store.getCapture(captureId);
    if (record === undefined) throw new Error(`no capture ${captureId}`);
    return parseSwimCloudCapture(store, record);
  },
  readRosterPageHtml: async (_captureId, canonicalUrl) => (await store.readPage(canonicalUrl))?.html,
};

const presetId = presetIdForConference('NSISC');
if (presetId === null) throw new Error('no preset for NSISC');
const scoringSettings = settingsForBuiltInScoringPreset(presetId);
const captures = await theoreticalMeetFromCaptures(CAPTURE_IDS, deps);
const seeds = buildTheoreticalMeetSeeds({ meetId: WORKSPACE_ID, course: 'SCY', scoringSettings, conference: 'NSISC', teams: captures.teams });
const built = buildTheoreticalMeetWorkspace({ workspaceId: WORKSPACE_ID, createdAt: CREATED_AT, seeds, scoringSettings, conference: 'NSISC' });

writeFileSync(OUT, `${JSON.stringify(built.payload, null, 2)}\n`);
console.log(`Wrote ${OUT}`);
