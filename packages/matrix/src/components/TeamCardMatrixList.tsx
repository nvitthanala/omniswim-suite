/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * TeamCard's expanded "Team Matrix" section: the by-event/by-swimmer sort +
 * grouping controls, and the scrollable list of group cards (each holding
 * `TeamMatrixSwimmerRow`s). Pure extraction from `TeamCard.tsx` — no behavior
 * change. Edit state and handlers stay in `TeamCard`; this only renders from
 * them and reports back via callbacks.
 */

import { List, Trash2 } from 'lucide-react';
import { Button, SegmentedControl } from '@omniswim/ui';
import type { Gender, SwimmerResult } from '@omniswim/core/types';
import type { PrelimsOverUnderEntry } from '@omniswim/core/lib/prelimsProjection';
import { sumPrelimsOuForSwimmers } from '@omniswim/core/lib/prelimsProjection';
import type { PsychOverUnderEntry } from '@omniswim/core/lib/psychProjection';
import { CompactEventLabel, PrelimsOuValue } from './matrixPresentation';
import { TeamMatrixSwimmerRow } from './TeamCardMatrixRow';

type SortMode = 'chrono' | 'eventDesc' | 'eventAsc' | 'swimmerDesc' | 'swimmerAsc';
type ViewMode = 'swimmer' | 'event';

interface TeamCardMatrixControlsProps {
  viewMode: ViewMode;
  sortMode: SortMode;
  onSortModeChange: (mode: SortMode) => void;
  onViewModeChange: (mode: ViewMode) => void;
}

/** The "Team Matrix" heading plus its sort-select and grouping toggle. */
export function TeamCardMatrixControls({ viewMode, sortMode, onSortModeChange, onViewModeChange }: TeamCardMatrixControlsProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
      <div className="flex items-center gap-2 min-w-0">
        <List size={14} className="text-[var(--text-accent)] shrink-0" />
        <span className="text-ui-micro font-medium uppercase tracking-widest text-theme-secondary truncate">Team Matrix</span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 min-w-0">
        <select
          className="glass-input text-ui-micro uppercase tracking-widest text-theme-secondary rounded p-1 outline-none"
          value={sortMode}
          onChange={(e) => onSortModeChange(e.target.value as SortMode)}
          aria-label="Sort team matrix"
        >
          {viewMode === 'event' && <option value="chrono">Chronological</option>}
          {viewMode === 'event' && <option value="eventDesc">High to Low</option>}
          {viewMode === 'event' && <option value="eventAsc">Low to High</option>}
          {viewMode === 'swimmer' && <option value="swimmerDesc">High to Low</option>}
          {viewMode === 'swimmer' && <option value="swimmerAsc">Low to High</option>}
        </select>

        <SegmentedControl
          layout="inline"
          ariaLabel="Team matrix grouping"
          value={viewMode}
          onChange={onViewModeChange}
          options={[
            { value: 'event', label: 'By Event', ariaLabel: 'Group team matrix by event' },
            { value: 'swimmer', label: 'By Swimmer', ariaLabel: 'Group team matrix by swimmer' },
          ]}
        />
      </div>
    </div>
  );
}

interface TeamCardMatrixListProps {
  groups: any[];
  viewMode: ViewMode;
  gender: Gender | string;
  teamName: string;
  onUpdateTime?: (id: string, newTime: string) => void;
  onRequestDeleteSwimmer?: (name: string) => void;
  editingResultId: string | null;
  editValue: string;
  onStartEdit: (id: string, time: string) => void;
  onEditValueChange: (value: string) => void;
  onCancelEdit: () => void;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  showPsychPerformance?: boolean;
  psychOuByEntry?: Map<string, PsychOverUnderEntry>;
}

/** One group card's header: name/event label, class-year badge, delete affordance, points + prelims O/U. */
function TeamCardMatrixGroupHeader({
  group,
  viewMode,
  showPrelimsPerformance,
  prelimsOuByEntry,
  onRequestDeleteSwimmer,
}: {
  group: any;
  viewMode: ViewMode;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
  onRequestDeleteSwimmer?: (name: string) => void;
}) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-3">
        <h4 className="text-xs font-medium text-[var(--text-primary)] uppercase group-hover:text-[var(--text-accent)] transition-colors">
          {viewMode === 'swimmer' ? group.name : <CompactEventLabel event={group.event} className="font-mono" />}
        </h4>
        {viewMode === 'swimmer' && (
          <span className="px-1.5 py-0.5 rounded surface-overlay border border-theme-soft text-ui-micro font-mono font-medium text-theme-secondary">
            {group.classYear}
          </span>
        )}
        {viewMode === 'swimmer' && onRequestDeleteSwimmer && (
          <Button
            variant="outline"
            size="sm"
            title="Remove swimmer from workspace"
            aria-label={`Remove ${group.name} from workspace`}
            className="p-1"
            onClick={() => onRequestDeleteSwimmer(group.name)}
            leadingIcon={<Trash2 size={12} />}
          />
        )}
      </div>
      <PrelimsOuValueOrPoints group={group} viewMode={viewMode} showPrelimsPerformance={showPrelimsPerformance} prelimsOuByEntry={prelimsOuByEntry} />
    </div>
  );
}

function PrelimsOuValueOrPoints({
  group,
  viewMode,
  showPrelimsPerformance,
  prelimsOuByEntry,
}: {
  group: any;
  viewMode: ViewMode;
  showPrelimsPerformance?: boolean;
  prelimsOuByEntry?: Map<string, PrelimsOverUnderEntry>;
}) {
  return (
    <div className="text-right flex flex-col items-end gap-0.5">
      <span className="font-mono font-black text-[var(--text-primary)] text-xs">
        {group.points.toFixed(1)} <span className="text-ui-micro text-theme-secondary">PTS</span>
      </span>
      {showPrelimsPerformance && prelimsOuByEntry ? (
        <PrelimsOuValue
          value={sumPrelimsOuForSwimmers(group.swimmers, prelimsOuByEntry, {
            includeRelay: viewMode === 'event',
          })}
          compact
        />
      ) : null}
    </div>
  );
}

/** The scrollable list of group cards (by-event or by-swimmer) with their swimmer rows. */
export function TeamCardMatrixList({
  groups,
  viewMode,
  gender,
  teamName,
  onUpdateTime,
  onRequestDeleteSwimmer,
  editingResultId,
  editValue,
  onStartEdit,
  onEditValueChange,
  onCancelEdit,
  showPrelimsPerformance,
  prelimsOuByEntry,
  showPsychPerformance,
  psychOuByEntry,
}: TeamCardMatrixListProps) {
  return (
    <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar">
      {groups.map((group: any) => (
        <div key={group.name || group.event} className="p-3 rounded-lg surface-overlay border border-theme-soft group transition-colors hover:border-[var(--border)]">
          <TeamCardMatrixGroupHeader
            group={group}
            viewMode={viewMode}
            showPrelimsPerformance={showPrelimsPerformance}
            prelimsOuByEntry={prelimsOuByEntry}
            onRequestDeleteSwimmer={onRequestDeleteSwimmer}
          />

          <div className="space-y-1">
            {group.swimmers.map((res: SwimmerResult, i: number) => (
              <TeamMatrixSwimmerRow
                key={i}
                res={res}
                gender={gender}
                teamName={teamName}
                viewMode={viewMode}
                onUpdateTime={onUpdateTime}
                editingResultId={editingResultId}
                editValue={editValue}
                onStartEdit={onStartEdit}
                onEditValueChange={onEditValueChange}
                onCancelEdit={onCancelEdit}
                showPrelimsPerformance={showPrelimsPerformance}
                prelimsOuByEntry={prelimsOuByEntry}
                showPsychPerformance={showPsychPerformance}
                psychOuByEntry={psychOuByEntry}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
