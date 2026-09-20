/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "Select a team…" placeholder option followed by a `teams.map(...)` of
 * `<option>` elements was hand-rolled 6 times across `packages/manager`
 * (IndRelayManagementView, RosterImportWizard, RosterOptimizeStepParts,
 * RosterRelayStep, TeamRosterPanel, AthleteHistoryImportPanel), each with
 * its own `glass-input` class list and small behavioural variations
 * (a disabled placeholder option, an empty-roster fallback label, a
 * placeholder that only shows when the current value isn't a valid team).
 *
 * This component covers only the `<select>` + `<option>` markup — every
 * call site keeps its own surrounding `<label>`/`<span>` (label text,
 * icons, helper copy, and a following custom-team `<input>` at one site all
 * differ enough that folding them in here would either lose information or
 * force a redesign). It intentionally extends `SelectHTMLAttributes`
 * directly, the same way `Button` extends `ButtonHTMLAttributes`, so a
 * caller passes `className`, `disabled`, `id`, `value`, `onChange`, etc.
 * exactly as it would to a native `<select>`.
 */
import type { SelectHTMLAttributes } from 'react';

export type TeamSelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> & {
  /** Team names to list as options, in the order given. */
  teams: string[];
  /** Placeholder option text. Defaults to 'Select a team…'. */
  placeholder?: string;
  /** Whether the placeholder option itself is `disabled` (unselectable once a real team is chosen). Defaults to false. */
  placeholderDisabled?: boolean;
  /**
   * Whether the placeholder option renders at all. Defaults to true.
   * TeamRosterPanel only shows it when the controlled value isn't a valid
   * team, so it passes this explicitly rather than relying on the default.
   */
  showPlaceholder?: boolean;
  /**
   * When `teams` is empty, render a single option with this text instead
   * of the normal placeholder + map. Omit to fall back to the normal
   * placeholder behaviour (which renders no team options, just the
   * placeholder) when the list is empty.
   */
  emptyTeamsLabel?: string;
};

export function TeamSelect({
  teams,
  placeholder = 'Select a team…',
  placeholderDisabled = false,
  showPlaceholder = true,
  emptyTeamsLabel,
  ...props
}: TeamSelectProps) {
  const noTeams = teams.length === 0 && emptyTeamsLabel !== undefined;

  return (
    <select {...props}>
      {noTeams ? (
        <option value="">{emptyTeamsLabel}</option>
      ) : (
        <>
          {showPlaceholder ? (
            <option value="" disabled={placeholderDisabled}>
              {placeholder}
            </option>
          ) : null}
          {teams.map(team => (
            <option key={team} value={team}>
              {team}
            </option>
          ))}
        </>
      )}
    </select>
  );
}
