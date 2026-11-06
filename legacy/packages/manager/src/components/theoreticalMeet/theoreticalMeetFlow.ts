/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The non-React half of the "Build theoretical meet" flow. It calls the data layer and nothing else:
 *
 * ```
 * readTeamCapture      -> theoreticalMeetFromCaptures([id], deps)      one capture at a time
 * combineCaptureResults                                                 in the order the user picked
 * buildMeet            -> buildTheoreticalMeetSeeds -> buildTheoreticalMeetWorkspace
 * createMeet           -> a FRESH id, then restoreWorkspace(payload)   never an id that exists
 * ```
 *
 * Reading one capture per call gives per-team progress and a per-team Retry. It is the same result as
 * one call with every id, because the data layer reads each capture on its own.
 *
 * `restoreWorkspace` is the provider's "create with a full payload" action (`createWorkspace(name, body)`
 * and `POST /api/workspaces`). It adds the workspace to the list and makes it the active one.
 */

import type { Workspace } from '@omniswim/core/types';
import { theoreticalMeetFromCaptures, type TheoreticalMeetFromCapturesResult } from '../../lib/theoreticalMeetFromCaptures';
import {
  buildTheoreticalMeetSeeds,
  type RelayFlyingStartAdjustment,
  type TheoreticalEventExclusion,
  type TheoreticalMeetSeeds,
} from '../../lib/theoreticalMeetSeeds';
import {
  TheoreticalWorkspaceError,
  buildTheoreticalMeetWorkspace,
  defaultTheoreticalMeetName,
  newTheoreticalWorkspaceId,
  sanitizeWorkspaceName,
  type TheoreticalMeetWorkspaceBuild,
} from '../../lib/theoreticalMeetWorkspace';
import type { CaptureApi } from './captureApi';
import {
  buildPreviewModel,
  combineCaptureResults,
  resolveScoringChoice,
  teamNamesOf,
  type PreviewModel,
} from './theoreticalMeetView';

/** Read one team capture. The list is the one already loaded, so no second list call is made. */
export async function readTeamCapture(
  api: CaptureApi,
  captureId: string,
  knownRecords: Awaited<ReturnType<CaptureApi['listCaptures']>>
): Promise<TheoreticalMeetFromCapturesResult> {
  return theoreticalMeetFromCaptures([captureId], {
    listCaptures: async () => knownRecords,
    parseCapture: id => api.parseCapture(id),
  });
}

export interface BuildMeetArgs {
  /** Capture ids in the order the user picked them. Team order in the meet follows it. */
  readonly captureIds: readonly string[];
  readonly resultsByCaptureId: Readonly<Record<string, TheoreticalMeetFromCapturesResult | undefined>>;
  readonly scoringChoiceId: string;
  /** Exhibition swims: true seeds from them (the default, tagged in the preview), false drops those events entirely. */
  readonly includeExhibition?: boolean;
  /** Event labels in meet order, or undefined for the standard program order. */
  readonly eventOrder?: readonly string[];
  /**
   * (swimmer, event) pairs the user removed in the preview. They carry no meet id, so a rebuild under a
   * fresh workspace id (see `createMeet`) keeps them. Absent or empty: the strength-first selection.
   */
  readonly excludedEvents?: readonly TheoreticalEventExclusion[];
  /**
   * Also build relays from individual bests (estimates). Absent or false: no relay, as before. The dialog
   * passes `true` by default. A scoring preset with no relay program on record builds none and says so.
   */
  readonly includeRelays?: boolean;
  /**
   * Flying-start seconds per leg distance, as the user typed them. Used only with `includeRelays`. A distance
   * with no value gets no adjustment. There is no default.
   */
  readonly relayFlyingStartAdjustmentSec?: RelayFlyingStartAdjustment;
  /**
   * "Relays per swimmer: at most N". Used only with `includeRelays`. Absent: no limit beyond the entry caps.
   * A value that is not a whole number of 1 or more is rejected by the seed builder, never replaced.
   */
  readonly maxRelaysPerSwimmer?: number;
}

export interface BuiltMeet {
  readonly workspaceId: string;
  readonly captures: TheoreticalMeetFromCapturesResult;
  readonly seeds: TheoreticalMeetSeeds;
  readonly build: TheoreticalMeetWorkspaceBuild;
  readonly model: PreviewModel;
}

/**
 * Build the meet for one workspace id. The id is both the seed builder's `meetId` and the workspace id,
 * as the builder requires. Throws the data layer's own errors; the dialog maps each code to a sentence.
 */
export function buildMeet(args: BuildMeetArgs, workspaceId: string, createdAt: number): BuiltMeet {
  const captures = combineCaptureResults(args.captureIds, args.resultsByCaptureId);
  const { settings, conference } = resolveScoringChoice(args.scoringChoiceId);
  const seeds = buildTheoreticalMeetSeeds({
    meetId: workspaceId,
    course: 'SCY',
    scoringSettings: settings,
    ...(conference === undefined ? {} : { conference }),
    exhibitionSeeds: args.includeExhibition === false ? 'exclude' : 'include',
    ...(args.excludedEvents === undefined || args.excludedEvents.length === 0 ? {} : { excludedEvents: args.excludedEvents }),
    ...(args.includeRelays === true
      ? {
          includeRelays: true,
          ...(args.relayFlyingStartAdjustmentSec === undefined ? {} : { relayFlyingStartAdjustmentSec: args.relayFlyingStartAdjustmentSec }),
          ...(args.maxRelaysPerSwimmer === undefined ? {} : { maxRelaysPerSwimmer: args.maxRelaysPerSwimmer }),
        }
      : {}),
    teams: captures.teams,
  });
  const build = buildTheoreticalMeetWorkspace({
    workspaceId,
    createdAt,
    seeds,
    scoringSettings: settings,
    ...(conference === undefined ? {} : { conference }),
    name: defaultTheoreticalMeetName(teamNamesOf(captures)),
    ...(args.eventOrder === undefined ? {} : { eventOrder: args.eventOrder }),
  });
  return { workspaceId, captures, seeds, build, model: buildPreviewModel(captures, seeds, build) };
}

export interface CreateMeetDeps {
  /** The provider's `restoreWorkspace`: POST the full payload, add it to the list, make it active. */
  restoreWorkspace(workspace: Workspace): Promise<Workspace>;
  /** Ids of every workspace the app already holds. */
  existingWorkspaceIds(): readonly string[];
  /** A fresh id. Defaults to `newTheoreticalWorkspaceId`. */
  newId?(): string;
  now?(): number;
}

const MAX_ID_ATTEMPTS = 5;

/**
 * Create the workspace. Never reuses an id that exists: `POST /api/workspaces` with an existing id
 * overwrites that workspace and deletes its rows. The preview's id is used when it is free; otherwise
 * the meet is rebuilt under a fresh id. `name` (what the user typed, may be empty) replaces the default
 * name without a rebuild. Returns the workspace the server saved.
 */
export async function createMeet(
  deps: CreateMeetDeps,
  args: BuildMeetArgs,
  preview: BuiltMeet,
  name = ''
): Promise<{ workspace: Workspace; built: BuiltMeet }> {
  const taken = new Set(deps.existingWorkspaceIds());
  const newId = deps.newId ?? newTheoreticalWorkspaceId;
  const now = deps.now ?? Date.now;
  let built = preview;
  let attempts = 0;
  while (taken.has(built.workspaceId)) {
    if (attempts >= MAX_ID_ATTEMPTS) {
      throw new TheoreticalWorkspaceError('invalid-input', 'No unused workspace id could be made. Nothing was created.');
    }
    attempts += 1;
    const id = newId();
    if (!taken.has(id)) built = buildMeet(args, id, now());
  }
  const typed = sanitizeWorkspaceName(name);
  const payload = typed.length > 0 ? { ...built.build.payload, name: typed } : built.build.payload;
  const workspace = await deps.restoreWorkspace(payload as unknown as Workspace);
  return { workspace, built };
}
