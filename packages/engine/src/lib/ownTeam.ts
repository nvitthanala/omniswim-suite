/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The workspace's own team: the team the coach is. It is stored in the workspace's
 * existing settings object (`ScoringSettings.ownTeam`, saved in the `scoring_settings`
 * column), so it needs no column and no migration. Absent, or blank, means unset.
 *
 * It is not a scoring rule. The scoring engine never reads it, and a scoring preset
 * never carries it (`WORKSPACE_ONLY_SETTINGS_KEYS`).
 */
import type { ScoringSettings, Workspace } from '../types';
import { DEFAULT_SCORING_SETTINGS } from './scoringDefaults';

/** Keys of `ScoringSettings` that belong to one workspace and are never part of a rule set. */
export const WORKSPACE_ONLY_SETTINGS_KEYS = ['ownTeam'] as const;

/** The workspace's own team, trimmed, or `null` when none is set. */
export function workspaceOwnTeam(workspace: Pick<Workspace, 'scoringSettings'> | null | undefined): string | null {
  const raw = workspace?.scoringSettings?.ownTeam;
  if (typeof raw !== 'string') return null;
  const team = raw.trim();
  return team === '' ? null : team;
}

/**
 * `settings` with the own team set, or cleared when `team` is `null` or blank. A clear is
 * written as `ownTeam: ''` and not by dropping the key: a settings save that has no
 * `ownTeam` key is read as "this save did not touch it" (`keepOwnTeam`), so only an
 * explicit blank clears. `undefined` settings start from the generic defaults.
 */
export function withOwnTeam(settings: ScoringSettings | undefined, team: string | null): ScoringSettings {
  return { ...(settings ?? DEFAULT_SCORING_SETTINGS), ownTeam: team?.trim() ?? '' };
}

/**
 * Carries the own team across a save that replaces the whole settings object (a preset
 * load, the rules dialog, an import). `next` wins when it names the key, blank included.
 * When it does not, the current team stays, so changing a scoring rule cannot unset it.
 */
export function keepOwnTeam(
  next: ScoringSettings,
  current: Pick<Workspace, 'scoringSettings'> | null | undefined
): ScoringSettings {
  if (Object.prototype.hasOwnProperty.call(next, 'ownTeam')) return next;
  const team = workspaceOwnTeam(current);
  return team === null ? next : { ...next, ownTeam: team };
}

/** A copy of `settings` without the keys a rule set must not carry. */
export function withoutWorkspaceOnlySettings<T extends object>(settings: T): T {
  const copy: Record<string, unknown> = { ...(settings as Record<string, unknown>) };
  for (const key of WORKSPACE_ONLY_SETTINGS_KEYS) delete copy[key];
  return copy as T;
}
