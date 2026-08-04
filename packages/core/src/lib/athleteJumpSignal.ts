/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cross-applet "jump to athlete" hand-off. The shell command palette cannot
 * reach Manager's internal jump state (props/URL params are not threaded), so
 * the request travels out-of-band: sessionStorage covers the
 * navigate-then-mount case, a window CustomEvent covers the already-mounted
 * case. Consumers must call consumePendingAthleteJump() (which clears the
 * stored entry) so a jump is never replayed on a later mount.
 */

import { Gender } from '../types';

export const ATHLETE_JUMP_EVENT = 'omniswim:jump-athlete';
export const ATHLETE_JUMP_STORAGE_KEY = 'omniswim.jumpAthlete';

export type AthleteJumpDetail = {
  name: string;
  team?: string;
  gender?: Gender;
};

/** Publish a jump request (storage + event), then navigate to Manager. */
export function requestAthleteJump(detail: AthleteJumpDetail): void {
  try {
    sessionStorage.setItem(ATHLETE_JUMP_STORAGE_KEY, JSON.stringify(detail));
  } catch {
    // Storage unavailable (private mode) — the event path still works.
  }
  window.dispatchEvent(new CustomEvent(ATHLETE_JUMP_EVENT, { detail }));
}

/** Read and clear the pending jump request, if any. */
export function consumePendingAthleteJump(): AthleteJumpDetail | null {
  try {
    const raw = sessionStorage.getItem(ATHLETE_JUMP_STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(ATHLETE_JUMP_STORAGE_KEY);
    const parsed = JSON.parse(raw) as AthleteJumpDetail;
    return parsed && typeof parsed.name === 'string' && parsed.name ? parsed : null;
  } catch {
    return null;
  }
}
