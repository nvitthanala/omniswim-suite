/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Collapsible section used to break a drawer body into focused chunks.
 * Extracted verbatim from AthleteLineupEditorPanel so the athlete drawer's
 * sections can live in their own files without each re-implementing the
 * disclosure behaviour.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export default function DrawerSection({
  title,
  icon,
  defaultOpen = false,
  badge,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-theme-soft last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex items-center gap-1.5 text-ui-caption font-semibold text-theme-muted">
          {icon}
          {title}
          {badge}
        </span>
        {open ? (
          <ChevronUp size={14} className="text-theme-secondary shrink-0" />
        ) : (
          <ChevronDown size={14} className="text-theme-secondary shrink-0" />
        )}
      </button>
      {open ? <div className="px-4 pb-4">{children}</div> : null}
    </div>
  );
}
