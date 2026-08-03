/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Load this meet here" — copy another workspace's frozen meet results (and
 * scoring config) into this one via copyMeetIntoWorkspace. Only touches the
 * meet-results plane; roster plans/recruits in this workspace are untouched.
 */

import React, { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, X } from 'lucide-react';
import { Workspace } from '@omniswim/core/types';
import { copyMeetIntoWorkspace, type CopyMeetResult } from '@omniswim/core/lib/swimEditor';
import { useSuiteWorkspace } from '@omniswim/core/store/SuiteWorkspaceProvider';
import { useToast } from '@omniswim/ui';

type Props = {
  workspace: Workspace;
  onUpdate: (patch: Partial<Workspace>) => void;
  /** When false, matches the surrounding step's What-if gating for other roster/meet edits. */
  whatIfMode: boolean;
};

function hasLoadedMeetResults(w: Workspace): boolean {
  return (w.menResults?.length ?? 0) + (w.womenResults?.length ?? 0) > 0;
}

export default function LoadMeetHereCard({ workspace, onUpdate, whatIfMode }: Props) {
  const { workspaces } = useSuiteWorkspace();
  const toast = useToast();
  const [sourceId, setSourceId] = useState('');
  const [pending, setPending] = useState<CopyMeetResult | null>(null);

  const sourceOptions = useMemo(
    () => workspaces.filter(w => w.id !== workspace.id && hasLoadedMeetResults(w)),
    [workspaces, workspace.id]
  );

  const requestCopy = () => {
    const source = sourceOptions.find(w => w.id === sourceId);
    if (!source) return;
    setPending(copyMeetIntoWorkspace(source, workspace));
  };

  const confirmCopy = () => {
    if (!pending) return;
    onUpdate(pending.patch);
    toast.push('success', pending.description);
    setPending(null);
    setSourceId('');
  };

  return (
    <section className="surface-card rounded-xl p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-1">
        <ArrowLeftRight size={16} className="text-[var(--text-accent)] shrink-0" />
        <h4 className="text-ui-label font-semibold text-[var(--text-primary)]">
          Load a meet from another workspace
        </h4>
      </div>
      <p className="text-ui-body text-theme-secondary mb-3 leading-relaxed">
        Copy the frozen meet results and scoring config from another workspace into this one.
        Roster plans and recruits here stay untouched.
      </p>

      {!whatIfMode ? (
        <p className="text-ui-caption rounded-lg border border-theme-soft surface-muted-bg px-3 py-2 text-theme-secondary mb-3">
          Enable <strong className="text-[var(--text-primary)]">What-if</strong> to copy meet results
          here.
        </p>
      ) : null}

      {sourceOptions.length > 0 ? (
        <div className="flex flex-col sm:flex-row gap-2">
          <select
            value={sourceId}
            disabled={!whatIfMode}
            onChange={e => setSourceId(e.target.value)}
            className="glass-input flex-1 min-w-0 rounded-lg px-3 py-2.5 text-ui-body appearance-none disabled:opacity-50"
          >
            <option value="">Select a workspace…</option>
            {sourceOptions.map(w => (
              <option key={w.id} value={w.id}>
                {w.name}
                {w.loadedMeet?.pdfFilename ? ` — ${w.loadedMeet.pdfFilename}` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!whatIfMode || !sourceId}
            onClick={requestCopy}
            className="text-ui-label px-4 py-2 btn-accent-outline rounded-lg font-medium disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Copy meet results into this workspace
          </button>
        </div>
      ) : (
        <p className="text-ui-caption text-theme-muted">
          No other workspaces have loaded meet results yet.
        </p>
      )}

      {pending ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop backdrop-blur-sm">
          <div
            className="surface-card border border-[var(--text-accent)]/20 rounded-xl max-w-md w-full mx-4 p-6"
            style={{ boxShadow: 'var(--ui-shadow-lg)' }}
          >
            <div className="flex justify-between items-start mb-6">
              <div className="flex gap-4">
                <div className="w-10 h-10 rounded-full bg-[var(--text-accent)]/15 text-[var(--text-accent)] flex items-center justify-center shrink-0 border border-[var(--text-accent)]/20">
                  <AlertTriangle size={20} />
                </div>
                <div>
                  <h2 className="text-heading-2">Load this meet here?</h2>
                  <p className="text-ui-body text-theme-secondary mt-1 leading-relaxed">
                    {pending.description}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPending(null)}
                className="text-theme-muted hover:text-[var(--text-primary)] transition-colors"
                aria-label="Close"
              >
                <X size={20} />
              </button>
            </div>

            {pending.warnings.length > 0 ? (
              <ul className="text-ui-caption text-amber-400/90 bg-amber-400/10 border border-amber-400/20 rounded-lg p-3 mb-6 list-disc list-inside space-y-1">
                {pending.warnings.map((w, i) => (
                  <li key={i} className="break-words">
                    {w}
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex justify-end gap-3 font-medium">
              <button
                type="button"
                onClick={() => setPending(null)}
                className="px-5 py-2 border border-theme-soft hover:bg-[var(--surface-strong)] rounded-lg text-[var(--text-primary)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmCopy}
                className="px-5 py-2 bg-[var(--text-accent)] hover:bg-[var(--text-accent)]/90 text-white rounded-lg transition-colors"
              >
                Confirm copy
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
