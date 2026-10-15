/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The collapsible shell every `SwimCloudCaptureBrowser` section sits in.
 * Pure extraction from `SwimCloudCaptureBrowser.tsx` — no behaviour change.
 */

import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { SectionId } from './swimCloudCaptureBrowserView';

export function CaptureSection({
  id,
  title,
  expanded,
  onToggle,
  action,
  children,
}: {
  readonly id: SectionId;
  readonly title: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const bodyId = `swimcloud-capture-section-${id}`;
  return (
    <section className="border border-theme-soft rounded-lg">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="flex flex-1 min-w-0 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronDown size={14} className="text-theme-secondary shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-theme-secondary shrink-0" />
          )}
          <span className="text-ui-caption font-bold uppercase tracking-widest text-[var(--text-primary)] truncate">
            {title}
          </span>
        </button>
        {action}
      </div>
      {expanded ? (
        <div id={bodyId} className="px-3 pb-3">
          {children}
        </div>
      ) : null}
    </section>
  );
}
