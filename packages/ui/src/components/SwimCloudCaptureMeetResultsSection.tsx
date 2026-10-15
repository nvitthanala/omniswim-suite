/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s "Meet results in this capture" section: a
 * checkbox per team/gender group when meet-results leads, a read-only list
 * otherwise. Pure extraction from `SwimCloudCaptureBrowser.tsx` — no
 * behaviour change.
 */

import { Button } from './Button';
import { CaptureSection } from './SwimCloudCaptureSection';
import {
  describeUnplannedPass,
  type SwimCloudCaptureParseGroup,
  type SwimCloudCaptureParseResponse,
  type SwimCloudCaptureRecord,
} from './swimCloudCaptureBrowserView';

interface GroupListProps {
  readonly groups: readonly SwimCloudCaptureParseGroup[];
}

/** "(12 rows, 2 pages)" — the same sentence in both the checkbox and read-only lists. */
function GroupCounts({ group }: { readonly group: SwimCloudCaptureParseGroup }) {
  return (
    <>
      ({group.rowCount} row{group.rowCount === 1 ? '' : 's'}, {group.parses.length} page
      {group.parses.length === 1 ? '' : 's'})
    </>
  );
}

function CheckableGroupList({
  groups,
  checkedGroups,
  onToggleGroup,
}: GroupListProps & {
  readonly checkedGroups: Readonly<Record<string, boolean>>;
  readonly onToggleGroup: (key: string) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {groups.map(group => (
        <li key={group.key} className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`swimcloud-capture-group-${group.key}`}
            checked={checkedGroups[group.key] !== false}
            onChange={() => onToggleGroup(group.key)}
          />
          <label
            htmlFor={`swimcloud-capture-group-${group.key}`}
            className="text-sm text-[var(--text-primary)]"
          >
            {group.label}
          </label>
          <span className="text-ui-caption text-theme-secondary tabular-nums">
            <GroupCounts group={group} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReadOnlyGroupList({ groups }: GroupListProps) {
  return (
    <ul className="space-y-1.5">
      {groups.map(group => (
        <li key={group.key} className="text-ui-caption text-theme-secondary">
          <span className="text-[var(--text-primary)]">{group.label}</span>{' '}
          <span className="tabular-nums">
            <GroupCounts group={group} />
          </span>
        </li>
      ))}
    </ul>
  );
}

interface SwimCloudCaptureMeetResultsSectionProps {
  readonly parseResponse: SwimCloudCaptureParseResponse;
  readonly selectedCapture: SwimCloudCaptureRecord | null;
  /** True in meet-results mode, where this section leads and carries the import action. */
  readonly isLead: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly groups: readonly SwimCloudCaptureParseGroup[];
  readonly checkedGroups: Readonly<Record<string, boolean>>;
  readonly onToggleGroup: (key: string) => void;
  readonly isImporting: boolean;
  readonly onImportMeetResults: () => void;
}

export function SwimCloudCaptureMeetResultsSection({
  parseResponse,
  selectedCapture,
  isLead,
  expanded,
  onToggle,
  groups,
  checkedGroups,
  onToggleGroup,
  isImporting,
  onImportMeetResults,
}: SwimCloudCaptureMeetResultsSectionProps) {
  if (!isLead && parseResponse.parses.length === 0) return null;

  const action = isLead ? (
    <Button
      variant="primary"
      size="sm"
      onClick={onImportMeetResults}
      disabled={isImporting || groups.length === 0}
      aria-label="Import the checked teams and genders"
      className="shrink-0"
    >
      {isImporting ? 'Importing…' : 'Import selected'}
    </Button>
  ) : undefined;

  return (
    <CaptureSection
      id="meetResults"
      title={`Meet results in this capture (${groups.length} team/gender group${groups.length === 1 ? '' : 's'})`}
      expanded={expanded}
      onToggle={onToggle}
      action={action}
    >
      {groups.length === 0 ? (
        <p className="text-ui-body text-theme-muted">
          Nothing parseable in this capture yet.{' '}
          {describeUnplannedPass(selectedCapture, 'meetTeamSwims') ?? ''}
        </p>
      ) : isLead ? (
        <CheckableGroupList groups={groups} checkedGroups={checkedGroups} onToggleGroup={onToggleGroup} />
      ) : (
        <ReadOnlyGroupList groups={groups} />
      )}
    </CaptureSection>
  );
}
