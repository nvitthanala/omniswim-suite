/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s "Rosters in this capture" section: a radio list
 * when roster-history leads, a read-only expandable list otherwise. Pure
 * extraction from `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 */

import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { CaptureSection } from './SwimCloudCaptureSection';
import {
  capturePassStatus,
  describeRosterCoverage,
  describeUnplannedPass,
  rosterHeading,
  rosterTeamLabel,
  type SwimCloudCaptureParseResponse,
  type SwimCloudCaptureRecord,
} from './swimCloudCaptureBrowserView';
import type { SwimCloudCaptureRosterOption } from './useSwimCloudCaptureSelection';

/** The roster-history scope the section leads under; `null` in meet-results mode. */
export interface SwimCloudCaptureRosterScope {
  readonly team: string;
  readonly genderLabel: string;
}

interface RosterLeadListProps {
  readonly options: readonly SwimCloudCaptureRosterOption[];
  readonly selectedKey: string | null;
  readonly onSelect: (key: string) => void;
  readonly genderLabel: string;
}

/** Roster-history mode: pick exactly one roster to import. */
function RosterLeadList({ options, selectedKey, onSelect, genderLabel }: RosterLeadListProps) {
  return (
    <ul className="space-y-1.5">
      {options.map(option => (
        <li key={option.key} className="border border-theme-soft rounded-lg px-3 py-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="swimcloud-capture-roster"
              className="mt-1"
              checked={selectedKey === option.key}
              onChange={() => onSelect(option.key)}
            />
            <span className="flex-1">
              <span className="block text-ui-body text-[var(--text-primary)]">
                {rosterHeading(option.roster)}
              </span>
              <span className="block text-ui-caption text-theme-muted">
                {option.coverage ? describeRosterCoverage(option.coverage) : ''}
              </span>
              {option.genderMismatch ? (
                <span className="mt-1 inline-flex items-center gap-1 text-ui-micro badge-warning px-1.5 py-0.5 rounded-full">
                  <AlertTriangle size={11} />
                  This roster is {option.roster.gender}; this importer is scoped to{' '}
                  {genderLabel}.
                </span>
              ) : null}
            </span>
          </label>
        </li>
      ))}
    </ul>
  );
}

interface RosterBrowseListProps {
  readonly options: readonly SwimCloudCaptureRosterOption[];
  readonly expandedKeys: Readonly<Record<string, boolean>>;
  readonly onToggle: (key: string) => void;
}

/** Meet-results mode: browse who is on each roster; nothing here is imported. */
function RosterBrowseList({ options, expandedKeys, onToggle }: RosterBrowseListProps) {
  return (
    <ul className="space-y-1.5">
      {options.map(option => {
        const isExpanded = expandedKeys[option.key] === true;
        return (
          <li key={option.key} className="border border-theme-soft rounded-lg">
            <button
              type="button"
              onClick={() => onToggle(option.key)}
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? 'Hide' : 'Show'} athletes on ${rosterTeamLabel(option.roster)}`}
              className="w-full flex items-center gap-2 px-3 py-2 text-left"
            >
              {isExpanded ? (
                <ChevronDown size={14} className="text-theme-secondary shrink-0" />
              ) : (
                <ChevronRight size={14} className="text-theme-secondary shrink-0" />
              )}
              <span className="text-sm text-[var(--text-primary)]">
                {rosterTeamLabel(option.roster)}
              </span>
              <span className="text-ui-caption text-theme-secondary">
                {option.roster.gender ?? 'unknown gender'} ·{' '}
                {option.roster.season ?? 'unknown season'} · {option.roster.athletes.length}{' '}
                athlete{option.roster.athletes.length === 1 ? '' : 's'}
              </span>
            </button>
            {isExpanded ? (
              <ul className="px-3 pb-2 space-y-1">
                {option.roster.athletes.map((athlete, athleteIndex) => (
                  <li
                    key={athlete.swimCloudSwimmerId ?? `${option.key}::athlete::${athleteIndex}`}
                    className="text-ui-caption text-theme-secondary flex flex-wrap gap-x-1.5"
                  >
                    <span className="text-[var(--text-primary)]">{athlete.name}</span>
                    {athlete.hometown ? <span>· {athlete.hometown}</span> : null}
                    {athlete.classYear && athlete.classYear !== 'unknown' ? (
                      <span>· {athlete.classYear}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

interface RosterImportButtonProps {
  readonly scope: SwimCloudCaptureRosterScope;
  readonly selectedRoster: SwimCloudCaptureRosterOption | null;
  readonly isImporting: boolean;
  readonly onImport: () => void;
}

/** The "Import this roster" action shown in the section header. */
function RosterImportButton({ scope, selectedRoster, isImporting, onImport }: RosterImportButtonProps) {
  return (
    <Button
      variant="primary"
      size="sm"
      onClick={onImport}
      disabled={isImporting || selectedRoster === null || scope.team.trim() === ''}
      aria-label={
        selectedRoster?.genderMismatch
          ? 'Import this roster despite the gender disagreement'
          : 'Import the selected roster'
      }
      title={
        selectedRoster === null
          ? 'Pick a capture, then a roster in it.'
          : `Imports ${selectedRoster.coverage?.withCapturedTimes ?? 0} swimmer(s) now; the other ${
              selectedRoster.coverage?.withoutCapturedTimes ?? 0
            } stay on the checklist.`
      }
      className="shrink-0"
    >
      {isImporting
        ? 'Importing…'
        : selectedRoster?.genderMismatch
          ? 'Import anyway'
          : 'Import this roster'}
    </Button>
  );
}

interface SwimCloudCaptureRosterSectionProps {
  readonly parseResponse: SwimCloudCaptureParseResponse;
  readonly selectedCapture: SwimCloudCaptureRecord | null;
  /** Set only in roster-history mode, which is also the mode where this section leads. */
  readonly rosterScope: SwimCloudCaptureRosterScope | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly rosterOptions: readonly SwimCloudCaptureRosterOption[];
  readonly selectedRosterKey: string | null;
  readonly selectedRoster: SwimCloudCaptureRosterOption | null;
  readonly onSelectRoster: (key: string) => void;
  readonly expandedRosterKeys: Readonly<Record<string, boolean>>;
  readonly onToggleRosterExpanded: (key: string) => void;
  readonly isImporting: boolean;
  readonly onImportRoster: () => void;
}

export function SwimCloudCaptureRosterSection({
  parseResponse,
  selectedCapture,
  rosterScope,
  expanded,
  onToggle,
  rosterOptions,
  selectedRosterKey,
  selectedRoster,
  onSelectRoster,
  expandedRosterKeys,
  onToggleRosterExpanded,
  isImporting,
  onImportRoster,
}: SwimCloudCaptureRosterSectionProps) {
  const isLead = rosterScope !== null;
  if (!isLead && parseResponse.rosters.length === 0) return null;

  const count = parseResponse.rosters.length;
  // Each roster's coverage sentence ("0 of 35 athletes have captured times")
  // is true whether or not the crawl planned the swimmer-times pass, but it
  // reads as a gap in the capture. When the pass was definitely never planned
  // it is not a gap, and that decides whether re-crawling would help. An
  // unrecorded scope is left to the status line rather than repeated over
  // every roster — it says nothing this specific.
  const rosterTimesCaveat =
    capturePassStatus(selectedCapture, 'swimmerTimes') === 'not-planned'
      ? describeUnplannedPass(selectedCapture, 'swimmerTimes')
      : null;
  const action = isLead ? (
    <RosterImportButton
      scope={rosterScope}
      selectedRoster={selectedRoster}
      isImporting={isImporting}
      onImport={onImportRoster}
    />
  ) : undefined;

  return (
    <CaptureSection
      id="rosters"
      title={`Rosters in this capture (${count} team${count === 1 ? '' : 's'})`}
      expanded={expanded}
      onToggle={onToggle}
      action={action}
    >
      {count > 0 && rosterTimesCaveat !== null ? (
        <p className="text-ui-body text-theme-muted mb-2">{rosterTimesCaveat}</p>
      ) : null}
      {count === 0 ? (
        <p className="text-ui-body text-theme-muted">
          This capture holds no team-roster page, so there is no roster to import.{' '}
          {describeUnplannedPass(selectedCapture, 'teamRoster') ??
            'The clipboard path still works for one swimmer at a time.'}
        </p>
      ) : isLead ? (
        <RosterLeadList
          options={rosterOptions}
          selectedKey={selectedRosterKey}
          onSelect={onSelectRoster}
          genderLabel={rosterScope.genderLabel}
        />
      ) : (
        <RosterBrowseList
          options={rosterOptions}
          expandedKeys={expandedRosterKeys}
          onToggle={onToggleRosterExpanded}
        />
      )}
    </CaptureSection>
  );
}
