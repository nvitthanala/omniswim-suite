/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Eligible swimmers" drag-source sidebar for IndRelayManagementView — split
 * out of the view's own function body.
 */
import type { SwimmerResult } from '@omniswim/core/types';
import { ProvenanceBadges } from '@omniswim/ui';
import type { DragPayload } from './IndRelayManagementView';

type Props = {
  eventLabel: string;
  poolCandidates: SwimmerResult[];
};

export default function RelayEligibleSwimmersPanel({ eventLabel, poolCandidates }: Props) {
  return (
    <div className="surface-card rounded-xl p-4 sm:p-5 w-full lg:w-72 shrink-0 flex flex-col min-h-[12rem] max-h-[40vh] lg:max-h-none">
      <h4 className="text-ui-caption font-bold text-[var(--text-primary)] mb-1">
        Eligible swimmers
      </h4>
      <p className="text-ui-micro text-theme-secondary mb-3 leading-relaxed">
        Drag onto a vacant leg for <span className="text-[var(--text-accent)]">{eventLabel}</span>. Stroke must
        match the leg distance.
      </p>
      {poolCandidates.length === 0 ? (
        <p className="text-ui-caption text-theme-muted italic">No eligible candidates for vacant legs.</p>
      ) : (
        <ul className="flex-1 min-h-0 overflow-y-auto custom-scrollbar space-y-1">
          {poolCandidates.map(swimmer => (
            <li
              key={swimmer.id || swimmer.name}
              draggable
              onDragStart={e => {
                e.dataTransfer.setData(
                  'application/x-omni-relay-leg',
                  JSON.stringify({
                    name: swimmer.name,
                    recruitId: swimmer.isRecruit ? swimmer.id : undefined,
                    classYear: String(swimmer.classYear),
                  } satisfies DragPayload)
                );
                e.dataTransfer.effectAllowed = 'move';
              }}
              className="border border-theme-soft rounded-lg px-2 py-1.5 cursor-grab active:cursor-grabbing hover:border-[var(--text-accent)]/40 transition-colors"
            >
              <p className="text-ui-caption text-[var(--text-primary)] truncate">{swimmer.name}</p>
              <p className="text-ui-micro text-theme-secondary truncate">
                {swimmer.classYear}
                {swimmer.isRecruit ? ' · recruit' : ''} · {swimmer.event} {swimmer.time}
              </p>
              {swimmer.relayLegHistory || swimmer.convertedFrom ? (
                <ProvenanceBadges
                  swim={{ fromHistory: !!swimmer.relayLegHistory, convertedFrom: swimmer.convertedFrom }}
                  compact
                  className="mt-1"
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
