/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Per-swimmer class-year pickers for new roster additions, shown above the
 * preview table in AthleteHistoryImportPanel — split out of the panel's own
 * function body.
 */
import type { ClassYear } from '@omniswim/core/types';
import { CLASS_YEAR_OPTIONS } from './AthleteHistoryImportPanelParts';

type Props = {
  previewNames: string[];
  importDisabled?: boolean;
  classYears: Record<string, ClassYear>;
  onSetClassYear: (name: string, year: ClassYear) => void;
};

export default function AthleteHistoryClassYearsGrid({
  previewNames,
  importDisabled,
  classYears,
  onSetClassYear,
}: Props) {
  if (previewNames.length === 0 || importDisabled) return null;

  return (
    <div className="mb-3">
      <p className="text-ui-caption text-theme-muted mb-1.5">
        Class years for new roster additions (existing swimmers keep theirs)
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 max-h-40 overflow-y-auto custom-scrollbar pr-1">
        {previewNames.map(name => (
          <label key={name} className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-ui-body text-theme-secondary truncate" title={name}>
              {name}
            </span>
            <select
              value={classYears[name] ?? ''}
              onChange={e => onSetClassYear(name, e.target.value as ClassYear)}
              className="glass-input rounded-lg px-2 py-1 text-ui-caption shrink-0"
            >
              <option value="" disabled>
                Default
              </option>
              {CLASS_YEAR_OPTIONS.map(y => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}
