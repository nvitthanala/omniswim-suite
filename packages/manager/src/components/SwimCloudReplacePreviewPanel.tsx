/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Preview for a SwimCloud "replace this team's data" reimport (plans/2026-09-24,
 * item A1). Shown before a coach confirms `importHistoryToRoster(..., { mode:
 * 'replace' })` — see that function and `previewSwimCloudReplace` in
 * packages/core/src/lib/historyImportRoster.ts for what a replace removes and
 * why. Pure display: this component decides nothing, it only renders the
 * `SwimCloudReplacePreview` its caller already computed.
 */
import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import type { SwimCloudReplacePreview } from '@omniswim/core/lib/historyImportRoster';
import type { SwimCloudReplaceReason } from '@omniswim/core/lib/swimCloudReplace';
import type { PlannedSwimEntry, Recruit } from '@omniswim/core/types';
import { Badge } from '@omniswim/ui';

type Props = {
  preview: SwimCloudReplacePreview;
};

function reasonLabel(reason: SwimCloudReplaceReason, tracedTo?: { event: string; time: string }): string {
  if (reason === 'swimcloud_source') return 'from a SwimCloud import';
  return tracedTo ? `matches a removed swim (${tracedTo.event} ${tracedTo.time})` : 'matches a removed swim';
}

function RemovedRow({ row, reason, tracedTo }: { row: Recruit | PlannedSwimEntry; reason: SwimCloudReplaceReason; tracedTo?: { event: string; time: string } }) {
  return (
    <li className="text-ui-caption text-theme-secondary py-1 px-2 border-b border-theme-soft/50 last:border-0">
      <span className="text-[var(--text-primary)] font-medium">{row.name}</span>
      {' — '}
      {row.event} {row.time}
      <span className="text-theme-muted"> · {reasonLabel(reason, tracedTo)}</span>
    </li>
  );
}

function Collapsible({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <div className="border border-theme-soft rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-ui-caption font-bold uppercase tracking-widest nav-tab-inactive hover:text-[var(--text-primary)] transition-colors"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label} ({count})
      </button>
      {open ? <ul className="max-h-48 overflow-y-auto custom-scrollbar">{children}</ul> : null}
    </div>
  );
}

export default function SwimCloudReplacePreviewPanel({ preview }: Props) {
  const { historyToRemove, recruitsToRemove, plansToRemove, keptCounts, keptAmbiguous, keptUntraced, relayOverridesLosingRecruit, athletesAbsentFromIncoming } = preview;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-ui-caption">
        <Badge tone="warning" className="px-2 py-0.5 font-normal normal-case tracking-normal">
          {historyToRemove.length} history row{historyToRemove.length === 1 ? '' : 's'} removed
        </Badge>
        <Badge tone="warning" className="px-2 py-0.5 font-normal normal-case tracking-normal">
          {recruitsToRemove.length} recruit row{recruitsToRemove.length === 1 ? '' : 's'} removed
        </Badge>
        <Badge tone="warning" className="px-2 py-0.5 font-normal normal-case tracking-normal">
          {plansToRemove.length} lineup entr{plansToRemove.length === 1 ? 'y' : 'ies'} removed
        </Badge>
        <Badge tone="info" className="px-2 py-0.5 font-normal normal-case tracking-normal">
          {keptCounts.history + keptCounts.recruits + keptCounts.plans} row(s) kept
        </Badge>
      </div>

      {plansToRemove.length > 0 ? (
        <p className="text-ui-caption text-amber-400/90 flex items-start gap-1.5">
          <AlertTriangle size={13} className="shrink-0 mt-0.5" />
          Removed lineup entries include scoring-theory (optimizer) plans. Re-run the scoring theory
          after the replace to refill any lineup slots it leaves open.
        </p>
      ) : null}

      <Collapsible label="Recruit rows removed" count={recruitsToRemove.length}>
        {recruitsToRemove.map(r => (
          <RemovedRow key={r.row.id} row={r.row} reason={r.reason} tracedTo={r.tracedTo} />
        ))}
      </Collapsible>

      <Collapsible label="Lineup entries removed" count={plansToRemove.length}>
        {plansToRemove.map(r => (
          <RemovedRow key={r.row.id} row={r.row} reason={r.reason} tracedTo={r.tracedTo} />
        ))}
      </Collapsible>

      {athletesAbsentFromIncoming.length > 0 ? (
        <div className="border border-amber-400/30 rounded-lg p-2.5 space-y-1">
          <p className="text-ui-caption font-bold text-amber-400/90 flex items-center gap-1.5">
            <AlertTriangle size={13} /> These swimmers lose data and are not in this capture
          </p>
          <p className="text-ui-caption text-theme-secondary">
            {athletesAbsentFromIncoming.join(', ')}
          </p>
        </div>
      ) : null}

      {keptAmbiguous.recruits.length + keptAmbiguous.plans.length > 0 ? (
        <p className="text-ui-caption text-theme-muted">
          {keptAmbiguous.recruits.length + keptAmbiguous.plans.length} row(s) kept even though they
          match a removed swim — the same time also matches data this replace does not touch, so it
          could have come from either and is not deleted.
        </p>
      ) : null}

      {keptUntraced.recruits.length + keptUntraced.plans.length > 0 ? (
        <p className="text-ui-caption text-theme-muted">
          {keptUntraced.recruits.length + keptUntraced.plans.length} row(s) kept for an athlete losing
          SwimCloud history, but their own time does not match any removed swim, so they were not
          touched.
        </p>
      ) : null}

      {relayOverridesLosingRecruit.length > 0 ? (
        <p className="text-ui-caption text-amber-400/90">
          {relayOverridesLosingRecruit.length} relay leg override{relayOverridesLosingRecruit.length === 1 ? '' : 's'} lose their assigned recruit and fall back to the name on the leg.
        </p>
      ) : null}
    </div>
  );
}
