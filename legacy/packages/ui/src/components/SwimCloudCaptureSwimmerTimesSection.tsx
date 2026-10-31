/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * `SwimCloudCaptureBrowser`'s "Swimmer times in this capture" section: one
 * expandable row per swimmer, with their personal bests in a table. Pure
 * extraction from `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { CaptureSection } from './SwimCloudCaptureSection';
import {
  capturePassStatus,
  describeUnplannedPass,
  swimmerTimesLabel,
  type SwimCloudCaptureParseResponse,
  type SwimCloudCaptureRecord,
} from './swimCloudCaptureBrowserView';

type SwimmerTimes = SwimCloudCaptureParseResponse['swimmerTimes'][number];

function PersonalBestsTable({ swimmer }: { readonly swimmer: SwimmerTimes }) {
  return (
    <div className="overflow-x-auto px-3 pb-2">
      <table className="w-full text-ui-caption">
        <thead>
          <tr className="text-left text-theme-muted">
            <th className="py-1 pr-3">Event</th>
            <th className="py-1 pr-3">Time</th>
            <th className="py-1 pr-3">Meet</th>
            <th className="py-1 pr-3">Date</th>
          </tr>
        </thead>
        <tbody>
          {swimmer.personalBests.map(pb => (
            <tr key={pb.swimKey}>
              <td className="py-1 pr-3 text-[var(--text-primary)]">{pb.eventLabel}</td>
              <td className="py-1 pr-3 text-theme-secondary tabular-nums">
                {pb.time ?? pb.rawTimeToken ?? '—'}
              </td>
              <td className="py-1 pr-3 text-theme-secondary">{pb.meetName ?? '—'}</td>
              <td className="py-1 pr-3 text-theme-secondary">{pb.date ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface SwimmerRowProps {
  readonly swimmer: SwimmerTimes;
  readonly isExpanded: boolean;
  readonly onToggle: (key: string) => void;
}

function SwimmerRow({ swimmer, isExpanded, onToggle }: SwimmerRowProps) {
  const key = swimmer.swimCloudSwimmerId;
  return (
    <li className="border border-theme-soft rounded-lg">
      <button
        type="button"
        onClick={() => onToggle(key)}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? 'Hide' : 'Show'} personal bests for ${swimmerTimesLabel(swimmer)}`}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {isExpanded ? (
          <ChevronDown size={14} className="text-theme-secondary shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-theme-secondary shrink-0" />
        )}
        <span
          className="text-sm text-[var(--text-primary)]"
          title={
            swimmer.name
              ? 'Printed by SwimCloud as "Last, First M" — not reformatted here.'
              : undefined
          }
        >
          {swimmerTimesLabel(swimmer)}
        </span>
        <span className="text-ui-caption text-theme-secondary">
          {swimmer.personalBests.length} personal best
          {swimmer.personalBests.length === 1 ? '' : 's'}
        </span>
      </button>
      {isExpanded ? <PersonalBestsTable swimmer={swimmer} /> : null}
    </li>
  );
}

interface SwimCloudCaptureSwimmerTimesSectionProps {
  readonly parseResponse: SwimCloudCaptureParseResponse;
  readonly selectedCapture: SwimCloudCaptureRecord | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly expandedSwimmerKeys: Readonly<Record<string, boolean>>;
  readonly onToggleSwimmerExpanded: (key: string) => void;
}

export function SwimCloudCaptureSwimmerTimesSection({
  parseResponse,
  selectedCapture,
  expanded,
  onToggle,
  expandedSwimmerKeys,
  onToggleSwimmerExpanded,
}: SwimCloudCaptureSwimmerTimesSectionProps) {
  const count = parseResponse.swimmerTimes.length;
  // An empty swimmer-times list normally means nothing worth a section, and
  // a capture that merely does not record its scope has already said so on
  // the status line above. A capture that *definitely* declined the pass is
  // different: there, a missing section reads as "there was nothing here",
  // which is the one reading that is wrong. So the section is conjured for
  // 'not-planned' only — a statement, never an uncertainty.
  const unplanned =
    count === 0 && capturePassStatus(selectedCapture, 'swimmerTimes') === 'not-planned'
      ? describeUnplannedPass(selectedCapture, 'swimmerTimes')
      : null;
  if (count === 0 && unplanned === null) return null;
  return (
    <CaptureSection
      id="swimmerTimes"
      title={`Swimmer times in this capture (${count} swimmer${count === 1 ? '' : 's'})`}
      expanded={expanded || unplanned !== null}
      onToggle={onToggle}
    >
      {unplanned !== null ? <p className="text-ui-body text-theme-muted">{unplanned}</p> : null}
      <ul className="space-y-1.5">
        {parseResponse.swimmerTimes.map(swimmer => (
          <SwimmerRow
            key={swimmer.swimCloudSwimmerId}
            swimmer={swimmer}
            isExpanded={expandedSwimmerKeys[swimmer.swimCloudSwimmerId] === true}
            onToggle={onToggleSwimmerExpanded}
          />
        ))}
      </ul>
    </CaptureSection>
  );
}
