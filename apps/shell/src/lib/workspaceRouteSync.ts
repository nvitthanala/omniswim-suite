import { Gender } from '@omniswim/core/types';

/**
 * Pure planning step for the shell's workspace/gender URL sync.
 *
 * Two values live in two places: the selection in `SuiteWorkspaceProvider` and the
 * `?workspace=` / `?gender=` URL params. The sync must decide, on every effect run,
 * which side leads. The old version compared the two sides ("they differ, so fix the
 * URL" / "they differ, so fix the state") from two separate effects. On a cold load
 * where they differed, each effect saw the other's stale value as the truth, and the
 * pair swapped the id about 30 times a second.
 *
 * The rule here never compares who is right. It asks which side MOVED since the last
 * run:
 *   - The URL moved (cold load, link, back/forward) and names a valid value: the URL
 *     leads. Set the state. Never write the URL.
 *   - Otherwise the state moved (sidebar click, palette, gender toggle) or the URL has
 *     no usable value: the state leads. Write the URL.
 *   - Neither moved: do nothing. A re-run with the same inputs (StrictMode's second
 *     mount run, a workspace list refetch) is therefore a no-op, which is what breaks
 *     the feedback loop.
 * If both moved in the same run the URL wins, because a link or back button is an
 * explicit user action.
 */
export interface RouteSyncSnapshot {
  /** Raw `?workspace=` value, or null when absent. */
  urlWorkspace: string | null;
  /** Raw `?gender=` value, or null when absent. */
  urlGender: string | null;
  /** Selection from the provider. Null while there is no workspace to select. */
  activeWorkspaceId: string | null;
  activeGender: Gender;
}

export interface RouteSyncPlan {
  /** Set the provider's workspace selection to this id. */
  setActiveWorkspaceId?: string;
  /** Set the provider's gender to this value. */
  setActiveGender?: Gender;
  /** Replace the URL params with these values. Only the keys present are written. */
  writeUrl?: { workspace?: string; gender?: Gender };
}

export function planRouteSync(
  prev: RouteSyncSnapshot | null,
  cur: RouteSyncSnapshot,
  knownWorkspaceIds: readonly string[]
): RouteSyncPlan {
  const plan: RouteSyncPlan = {};

  // Workspace.
  const urlWorkspaceValid = cur.urlWorkspace != null && knownWorkspaceIds.includes(cur.urlWorkspace);
  const urlWorkspaceMoved = prev == null || prev.urlWorkspace !== cur.urlWorkspace;
  const stateWorkspaceMoved = prev != null && prev.activeWorkspaceId !== cur.activeWorkspaceId;
  if (urlWorkspaceValid && urlWorkspaceMoved) {
    if (cur.urlWorkspace !== cur.activeWorkspaceId) plan.setActiveWorkspaceId = cur.urlWorkspace!;
  } else if (
    cur.activeWorkspaceId != null &&
    cur.urlWorkspace !== cur.activeWorkspaceId &&
    (stateWorkspaceMoved || urlWorkspaceMoved)
  ) {
    plan.writeUrl = { ...plan.writeUrl, workspace: cur.activeWorkspaceId };
  }

  // Gender.
  const urlGenderValid = cur.urlGender === Gender.MEN || cur.urlGender === Gender.WOMEN;
  const urlGenderMoved = prev == null || prev.urlGender !== cur.urlGender;
  const stateGenderMoved = prev != null && prev.activeGender !== cur.activeGender;
  if (urlGenderValid && urlGenderMoved) {
    if (cur.urlGender !== cur.activeGender) plan.setActiveGender = cur.urlGender as Gender;
  } else if (cur.urlGender !== cur.activeGender && (stateGenderMoved || urlGenderMoved)) {
    plan.writeUrl = { ...plan.writeUrl, gender: cur.activeGender };
  }

  return plan;
}
