/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The input of the simulator adapter: the structure of a `SimSnapshot`
 * (`apps/extension/src/shared/bridgeSchema.ts`), written here so a package does not import app code.
 * `tests/swimcloudSimulatorAdapter.test.ts` assigns a parsed `SimSnapshot` to `SimulatorSnapshotInput`,
 * so a change to the schema that this type does not follow fails `npm run lint`.
 *
 * Browser-safe: types and one error class. Nothing here reads `node:` or any global.
 */

type Id = string | number;
type Num = string | number;

export interface SimulatorTeamInput {
  readonly id: number;
  readonly name: string;
  readonly abbr?: string | null | undefined;
  readonly orgcode?: Num | null | undefined;
}

export interface SimulatorSwimmerInput {
  readonly id: Id;
  readonly teamId: number;
  readonly name?: string | null | undefined;
  readonly display_name?: string | null | undefined;
  readonly gender?: string | null | undefined;
  readonly gradcollege?: Num | null | undefined;
}

export interface SimulatorSwimInput {
  readonly kind: 'ind' | 'split' | 'leadoff' | 'relay';
  readonly teamId: number;
  readonly swimmerId: Id | null;
  readonly id: Id;
  readonly eventstroke: string;
  readonly eventdistance: Num;
  readonly eventcourse: string;
  readonly eventgender: string;
  readonly numlegs: Num;
  readonly eventtime: Num;
  readonly flystart?: boolean | null | undefined;
  readonly pointvalue: Num | null;
}

export interface SimulatorSplashInput {
  readonly id: Id;
  readonly teamId: Id;
  readonly swimmerId: Id | null;
  readonly eventstroke: string;
  readonly eventdistance: Num;
  readonly eventcourse: string;
  readonly eventtime: Num | null;
  readonly eventgender?: string | null | undefined;
  readonly numlegs?: Num | null | undefined;
  readonly flystart?: boolean | null | undefined;
  readonly pointvalue?: Num | null | undefined;
  readonly relay_id?: Id | null | undefined;
  readonly legposition?: Num | null | undefined;
  readonly points?: number | null | undefined;
  readonly exhibition?: boolean | number | string | null | undefined;
}

/** The settings that decide how the page scores. The page's own names. */
export interface SimulatorSettingsInput {
  readonly seasonId: number | null;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly startSeason: string | null;
  readonly endSeason: string | null;
  readonly dateToUse: string;
  readonly pointSystem: string;
  readonly gender: string;
  readonly timeToUse: string;
  readonly eventCourse: string;
  readonly eventIds: readonly string[];
  readonly maxScorersPerTeam: number;
  readonly maxIndrecordsPerAthlete: number;
  readonly maxIndrecordsPerTeam: number;
  readonly maxRelaysPerAthlete: number;
  readonly maxRelaysPerTeam: number;
  readonly maxTotalPerAthlete: number;
  readonly freeRelayStrategy: string;
  readonly relayDataSource: string;
  readonly selectedShortcut: string | null;
  readonly inactiveSwimmers: readonly Id[];
  readonly meetChanges: readonly unknown[];
}

export interface SimulatorSnapshotInput {
  readonly teams: readonly SimulatorTeamInput[];
  readonly swimmers: readonly SimulatorSwimmerInput[] | null;
  readonly swims: readonly SimulatorSwimInput[] | null;
  readonly settings: SimulatorSettingsInput;
  readonly splashes: readonly SimulatorSplashInput[] | null;
  readonly totalScores: Readonly<Record<string, { readonly points: number; readonly place: number | null }>> | null;
}

export type AdapterErrorCode =
  | 'invalid_time'
  | 'unknown_event'
  | 'unsupported_course'
  | 'unsupported_gender'
  | 'invalid_setting'
  | 'invalid_window'
  | 'swimmer_gender'
  | 'unresolved_reference'
  | 'duplicate_id'
  | 'unsupported_exhibition'
  | 'invalid_splash'
  | 'invalid_relay'
  | 'time_not_in_swims'
  | 'relay_time_mismatch';

/** A snapshot the adapter cannot read faithfully. It names the field, and nothing is guessed past it. */
export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly path: string;

  constructor(code: AdapterErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'AdapterError';
    this.code = code;
    this.path = path;
  }
}
