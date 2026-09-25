/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Merge into existing data" vs. "Replace this team's SwimCloud data" —
 * shared between RosterImportWizard and AthleteHistoryImportPanel so the
 * choice reads and behaves the same in both import flows. Defaults to
 * `'merge'` in both callers; this component only renders the choice already
 * made, it does not default anything itself.
 */
import type { SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';

type Props = {
  mode: SwimCloudImportMode;
  onChange: (mode: SwimCloudImportMode) => void;
  disabled?: boolean;
};

export default function SwimCloudImportModePicker({ mode, onChange, disabled }: Props) {
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="label-caps mb-1">Import as</legend>
      <label className="flex items-start gap-2 text-ui-body cursor-pointer">
        <input
          type="radio"
          name="swimcloud-import-mode"
          checked={mode === 'merge'}
          onChange={() => onChange('merge')}
          className="mt-1"
        />
        <span>
          <span className="text-[var(--text-primary)] font-medium">Merge into existing data</span>
          <span className="block text-ui-caption text-theme-muted">
            Add these swims. Nothing already on the roster is removed.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-ui-body cursor-pointer">
        <input
          type="radio"
          name="swimcloud-import-mode"
          checked={mode === 'replace'}
          onChange={() => onChange('replace')}
          className="mt-1"
        />
        <span>
          <span className="text-[var(--text-primary)] font-medium">Replace this team's SwimCloud data</span>
          <span className="block text-ui-caption text-theme-muted">
            Remove this team and gender's SwimCloud history, recruit rows and lineup entries first, then
            import. Manual and PDF data stay. A backup is taken first.
          </span>
        </span>
      </label>
    </fieldset>
  );
}
