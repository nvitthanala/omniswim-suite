/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TeamCard's custom chart-tooltip tree: the header, the two list bodies (class
 * top performers / event swimmers), one swimmer row, and the panel that picks
 * between them.
 *
 * The panel is a real tooltip renderer rather than a recharts `<Tooltip>` —
 * TeamCard positions and pins it itself to avoid recharts' z-index and
 * positioning issues. Pure extraction from `TeamCard.tsx` — no behavior change.
 */

import type { Gender, SwimmerResult } from '@omniswim/core/types';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import { entryKey, prelimsOuOverUnderForDisplay } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import { psychExpectedForResult } from '@omniswim/core/lib/psychProjection';
import { displayTimeForRelayLeg, formatLegSplitSummary } from '@omniswim/core/lib/relaySplits';
import { CompactEventLabel, PlacementExpectedValue, PrelimsOuValue } from './matrixPresentation';
import { CutlineVerdict, PodiumMedal } from './TeamCardParts';
import {
  buildTeamRowCutlineTags,
  computeClassTopPerformers,
  relayMissingStrokeLabel,
  sortSwimmersByPoints,
} from './teamCardView';

/** Chart tooltip title + points, with the event tooltip's optional over/under badge. */
export function TooltipHeader({ isClass, data, showPrelimsPerformance }: { isClass: boolean; data: any; showPrelimsPerformance?: boolean }) {
  const showOverUnder = !isClass && showPrelimsPerformance && data.overUnder != null && Math.abs(data.overUnder) > 0.05;
  return (
    <div className="flex justify-between items-center mb-2 pb-2 border-b border-theme-soft shrink-0">
      <h4 className="font-bold text-[var(--text-accent)] uppercase tracking-widest" style={{ fontSize: 'clamp(8px, 5cqi, 12px)' }}>
        {isClass ? `Class of ${data.name}` : <CompactEventLabel event={data.rawEvent} />}
      </h4>
      <div className="flex flex-col items-end gap-0.5">
        <span className="font-mono font-black" style={{ fontSize: 'clamp(9px, 6cqi, 14px)' }}>{data.points.toFixed(1)} PTS</span>
        {showOverUnder ? <PrelimsOuValue value={data.overUnder} compact /> : null}
      </div>
    </div>
  );
}

/** The class chart tooltip's "Top Performers" list, or its empty state. */
export function ClassTopPerformersList({ topPerformers }: { topPerformers: [string, number][] }) {
  if (topPerformers.length === 0) {
    return <div className="text-theme-muted text-ui-micro italic">No scoring swimmers</div>;
  }
  return (
    <>
      {topPerformers.map(([name, pts], idx) => (
        <div key={idx} className="flex items-center justify-between py-0.5 border-b border-theme-soft/50 last:border-0 swimmer-row" style={{ fontSize: 'clamp(8px, 4.5cqi, 11px)' }}>
          <span className="font-medium text-[var(--text-primary)] truncate pr-2 max-w-[150px]">{name}</span>
          <span className="font-mono text-points-positive font-bold">{pts.toFixed(1)}</span>
        </div>
      ))}
    </>
  );
}

/** The event chart tooltip's swimmer list, or its empty state. */
export function TooltipSwimmerList({
  swimmers,
  gender,
  teamName,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: {
  swimmers: SwimmerResult[];
  gender: Gender | string;
  teamName: string;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
}) {
  if (swimmers.length === 0) {
    return <div className="text-theme-muted text-ui-micro italic">No scoring swimmers</div>;
  }
  return (
    <>
      {swimmers.map((s: any, idx: number) => (
        <TooltipSwimmerRow
          key={idx}
          s={s}
          gender={gender}
          teamName={teamName}
          showPrelimsPerformance={showPrelimsPerformance}
          prelimsOuByEntry={prelimsOuByEntry}
          showPsychPerformance={showPsychPerformance}
          psychOuByEntry={psychOuByEntry}
        />
      ))}
    </>
  );
}

interface TooltipSwimmerRowProps {
  s: any;
  gender: Gender | string;
  teamName: string;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
}

/** One swimmer row inside the event/class chart tooltip's swimmer list. */
export function TooltipSwimmerRow({
  s,
  gender,
  teamName,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: TooltipSwimmerRowProps) {
  const rowTags = buildTeamRowCutlineTags(s, gender, teamName, s.finalsTime || s.time);
  const hasRelaySplit = s.isRelay && (s.relayLegSplitDetail || s.relayLegSplit);

  return (
    <div className="flex items-center justify-between py-1 border-b border-theme-soft/50 last:border-0 swimmer-row text-ui-caption">
      <div className="flex items-center gap-2">
        <span className="w-4 font-mono text-theme-muted">{s.rank || '-'}</span>
        <span className="w-4 shrink-0 inline-flex justify-center">
          <PodiumMedal podium={s.podium} />
        </span>
        <span className="font-medium text-[var(--text-primary)] truncate max-w-[120px]">{s.name}</span>
        {hasRelaySplit && (
          <span className="text-ui-micro text-theme-muted font-mono" title="Relay leg split">Split</span>
        )}
        {s.relayMissingLeg && (
          <span className="text-ui-micro bg-amber-500/15 text-amber-400 px-1 border border-amber-500/30 rounded-sm ml-1" title="Missing relay leg">
            Missing L{(s.relayMissingLeg.legIndex ?? 0) + 1}: {relayMissingStrokeLabel(s.relayMissingLeg.stroke)}
          </span>
        )}
        {/* Non-relay rows only — a relay's verdicts belong next to the
            relay team time and the leg split, not the swimmer's name. */}
        {rowTags.kind === 'single' && <CutlineVerdict result={rowTags.result} className="ml-1" />}
      </div>
      <div className="flex gap-3 text-right">
        <span className="font-mono text-theme-muted">{s.prelimsTime ? `P:${s.prelimsTime}` : ''}</span>
        <span className="font-mono text-theme-secondary">
          {hasRelaySplit ? (
            <>
              <span className="text-points-positive">{displayTimeForRelayLeg(s)}</span>
              {/* The leg's own individual verdict, when this leg is
                  eligible (e.g. a medley relay's backstroke leadoff) —
                  anchored to the split it actually describes. */}
              {rowTags.kind === 'relay' && rowTags.tags.legQualification ? (
                <span className="inline-flex items-center gap-1 ml-1 align-middle no-underline">
                  <CutlineVerdict result={rowTags.tags.legQualification} />
                </span>
              ) : null}
              {s.relayLegSplitDetail ? (
                <span className="block text-ui-micro text-theme-muted font-sans">
                  {formatLegSplitSummary(s.relayLegSplitDetail)}
                </span>
              ) : null}
              <span className="text-theme-muted ml-1">R:{s.relayTeamTime || s.finalsTime || s.time}</span>
            </>
          ) : s.finalsTime ? (
            `F:${s.finalsTime}`
          ) : (
            s.time
          )}
          {/* The relay's own verdict, next to the relay team time —
              repeats once per leg row on purpose: legs are sorted by
              points and are not necessarily adjacent, so this is the
              only placement that is unambiguous on every row. */}
          {rowTags.kind === 'relay' ? (
            <span className="inline-flex items-center gap-1 ml-1 align-middle no-underline">
              <CutlineVerdict result={rowTags.tags.relay} />
            </span>
          ) : null}
        </span>
        <span className="font-mono text-points-positive font-bold">{typeof s.points === 'number' ? s.points.toFixed(1) : s.points}</span>
        <div className="flex flex-col items-end gap-0.5">
          {showPrelimsPerformance && prelimsOuByEntry ? (
            <PlacementExpectedValue
              label="Prelims"
              value={prelimsOuByEntry.get(entryKey(s))?.expected}
            />
          ) : null}
          {showPsychPerformance && psychOuByEntry ? (
            <PlacementExpectedValue
              label="Psych"
              value={psychExpectedForResult(s, psychOuByEntry)}
            />
          ) : null}
          {showPrelimsPerformance && prelimsOuByEntry ? (
            <PrelimsOuValue
              value={prelimsOuOverUnderForDisplay(s, prelimsOuByEntry)}
              compact
              className="ml-1"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

interface TeamCardChartTooltipProps {
  data: any;
  /** A pinned tooltip is resizable and carries a close affordance. */
  isPinned?: boolean;
  /** The class chart's tooltip lists per-class top performers; the event chart's lists swimmers. */
  isClass?: boolean;
  gender: Gender | string;
  teamName: string;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
  /** Clears whichever pinned-tooltip state this tooltip was rendered from. */
  onClose: () => void;
}

/** Custom tooltips renderer logic to avoid recharts z-index and positioning issues */
export function TeamCardChartTooltip({
  data,
  isPinned = false,
  isClass = false,
  gender,
  teamName,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
  onClose,
}: TeamCardChartTooltipProps) {
  const topPerformers = isClass && data.swimmers ? computeClassTopPerformers(data.swimmers) : [];
  const swimmersSorted = !isClass && data.swimmers ? sortSwimmersByPoints(data.swimmers) : [];

  return (
    <div
      className="relative theme-popover p-3 z-[999] pointer-events-auto h-full flex flex-col"
      style={{
        resize: isPinned ? 'both' : 'none',
        overflow: 'hidden',
        minWidth: '220px',
        minHeight: '120px',
        containerType: 'size', // Container queries for dynamic resizing
      }}
    >
      {isPinned && (
        <div className="absolute top-1 right-1 cursor-pointer text-theme-muted hover:text-[var(--text-primary)]" onClick={onClose}>
          ✕
        </div>
      )}
      <TooltipHeader isClass={isClass} data={data} showPrelimsPerformance={showPrelimsPerformance} />

      <div className="space-y-1 mt-2 flex-1 overflow-y-auto custom-scrollbar">
        {isClass ? (
          <>
            <div className="text-theme-muted font-bold uppercase mb-1" style={{ fontSize: 'clamp(7px, 4cqi, 10px)' }}>Top Performers</div>
            <ClassTopPerformersList topPerformers={topPerformers} />
          </>
        ) : (
          <TooltipSwimmerList
            swimmers={swimmersSorted}
            gender={gender}
            teamName={teamName}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            showPsychPerformance={showPsychPerformance}
            psychOuByEntry={psychOuByEntry}
          />
        )}
      </div>
    </div>
  );
}
