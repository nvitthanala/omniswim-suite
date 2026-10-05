/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Step 1 of the "Build theoretical meet" dialog: pick crawled teams.
 * Reads `flow.list` and `flow.groups`; owns no state of its own.
 */

import { RefreshCw } from 'lucide-react';
import { Badge, Button } from '@omniswim/ui';
import type { TheoreticalMeetFlow } from './useTheoreticalMeetFlow';
import type { CaptureRow, TheoreticalProblem } from './theoreticalMeetView';

export function ProblemPanel({ problem, onRetry, retryLabel = 'Try again' }: { problem: TheoreticalProblem; onRetry?: () => void; retryLabel?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-[var(--toast-border)] bg-[var(--toast-bg)] p-3 text-ui-caption text-[var(--toast-text)]">
      <p className="font-medium">{problem.message}</p>
      {problem.detail !== null && problem.detail !== problem.message ? <p className="mt-1 break-words opacity-80">{problem.detail}</p> : null}
      {problem.retryable && onRetry !== undefined ? (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry} leadingIcon={<RefreshCw size={12} />}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading crawled teams" className="space-y-3">
      {[0, 1, 2].map(i => (
        <div key={i} className="rounded-xl border border-theme-soft p-3">
          <div className="skeleton-block h-4 w-40" />
          <div className="skeleton-block mt-3 h-12 w-full" />
        </div>
      ))}
    </div>
  );
}

function EmptyCaptures({ onReload }: { onReload: () => void }) {
  return (
    <div className="rounded-xl border border-dashed border-theme-soft p-6 text-center">
      <h3 className="text-ui-label font-semibold text-[var(--text-primary)]">No crawled teams yet</h3>
      <p className="mx-auto mt-2 max-w-md text-ui-caption text-theme-secondary">
        Crawl each team with the SwimCloud browser extension. Open the extension and choose Multi-team crawl, then pick the teams and the season.
        Come back here when the crawl finishes.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onReload} leadingIcon={<RefreshCw size={12} />}>
        Check again
      </Button>
    </div>
  );
}

function CaptureOption({ row, checked, onToggle }: { row: CaptureRow; checked: boolean; onToggle: () => void }) {
  const blocked = row.status === 'blocked';
  const id = `tmeet-capture-${row.captureId}`;
  const noteId = `${id}-note`;
  return (
    <li>
      <label
        htmlFor={id}
        className={`flex items-start gap-3 rounded-lg border border-theme-soft p-3 ${blocked ? 'opacity-70' : 'cursor-pointer theme-hover-row'}`}
      >
        <input
          id={id}
          type="checkbox"
          className="mt-1 h-4 w-4 shrink-0 accent-[var(--text-accent)]"
          checked={checked}
          disabled={blocked}
          onChange={onToggle}
          aria-describedby={noteId}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-ui-label font-medium text-[var(--text-primary)]">{row.season ?? 'Season not recorded'}</span>
            {blocked ? <Badge tone="warning">Not ready</Badge> : <Badge tone="success">Ready</Badge>}
          </span>
          <span id={noteId} className="mt-1 block space-y-0.5 text-ui-caption">
            <span className="block text-theme-secondary">{row.coverageText}</span>
            <span className="block text-theme-muted">
              {row.capturedOn !== null ? `${row.ageText.replace(/[.]$/, '')} (${row.capturedOn}).` : row.ageText}
            </span>
            {row.staleHint !== null ? <span className="block text-warning">{row.staleHint}</span> : null}
            {row.blockedReason !== null ? <span className="block text-warning">{row.blockedReason}</span> : null}
          </span>
        </span>
      </label>
    </li>
  );
}

export function TeamsStep({ flow }: { flow: TheoreticalMeetFlow }) {
  const { list, groups, selected, toggleCapture, reloadList } = flow;
  return (
    <div className="space-y-4">
      <p className="text-ui-caption text-theme-secondary">
        Pick the crawled teams that will meet. Each team enters its swimmers with their all-time best times. Only finished crawls can be picked.
      </p>
      {list.status === 'loading' ? <ListSkeleton /> : null}
      {list.status === 'error' ? <ProblemPanel problem={list.problem} onRetry={reloadList} retryLabel="Reload the list" /> : null}
      {list.status === 'ready' && groups.length === 0 ? <EmptyCaptures onReload={reloadList} /> : null}
      {list.status === 'ready'
        ? groups.map(group => (
            <section key={group.teamId} aria-labelledby={`tmeet-group-${group.teamId}`}>
              <h3 id={`tmeet-group-${group.teamId}`} className="mb-2 text-ui-label font-semibold text-[var(--text-primary)]">
                <span data-testid="tmeet-group-title">{group.title}</span>
                <Badge tone={group.divisionTag.division === null ? 'warning' : 'neutral'} className="ml-2 align-middle">
                  {group.divisionTag.text}
                </Badge>
              </h3>
              {group.nameWarning !== null ? <p className="mb-2 text-ui-caption text-warning">{group.nameWarning}</p> : null}
              <ul className="space-y-2">
                {group.rows.map(row => (
                  <CaptureOption key={row.captureId} row={row} checked={selected.includes(row.captureId)} onToggle={() => toggleCapture(row.captureId)} />
                ))}
              </ul>
            </section>
          ))
        : null}
    </div>
  );
}
