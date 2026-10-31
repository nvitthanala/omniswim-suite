/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Constants that the bridge (MAIN world) and the overlay (ISOLATED world) share.
 * This file imports nothing, so the 5 KB bridge can use it without pulling in zod.
 */

/** `source` on every message the bridge posts. */
export const BRIDGE_SOURCE = 'osx-bridge';

/** `source` on messages the overlay posts back (`kind: 'ready'` or `kind: 'write'`). */
export const OVERLAY_SOURCE = 'osx-overlay';

/** Only simulator controls with a native settings equivalent may be written. */
export const SIM_WRITE_KEYS = 'pointSystem maxScorersPerTeam maxIndrecordsPerAthlete maxIndrecordsPerTeam maxRelaysPerAthlete maxRelaysPerTeam maxTotalPerAthlete'.split(' ');

/** Protocol version, the `v` field. */
export const BRIDGE_VERSION = 1;

/**
 * The one request path whose response the bridge reads
 * (D3 2.7, recon Q5). Every other path is left alone.
 */
export const SIMULATOR_PATH = /^\/api\/teams\/\d+\/simulator\/$/;

/**
 * Settings the bridge copies from the simulator's Redux store, top level.
 * Names come from the store's initial state in the archived simulator bundle
 * (`data/swimcloud-captures/simulator/`, function `Hp`) and from `settings` in
 * `tests/fixtures/swimcloud/simulator/config-*.json`.
 * A name missing from the live store is an error, never a default.
 * One string, split at load, so the built bridge stays under 5 KB.
 */
export const SETTINGS_KEYS: readonly string[] =
  'seasonId startDate endDate startSeason endSeason dateToUse pointSystem gender timeToUse eventCourse eventIds maxScorersPerTeam maxIndrecordsPerAthlete maxIndrecordsPerTeam maxRelaysPerAthlete maxRelaysPerTeam maxTotalPerAthlete freeRelayStrategy relayDataSource selectedShortcut'.split(' ');
