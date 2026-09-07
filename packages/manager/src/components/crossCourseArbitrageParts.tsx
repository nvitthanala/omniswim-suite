/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Presentational pieces of CrossCourseArbitragePanel — the status pills, the
 * athlete jump button, the collapsible section and the show-all toggle.
 *
 * These are separate from `DrawerSection` on purpose: this Section draws a top
 * border and opens by default, the drawer's draws a bottom border and starts
 * closed, and they take different badge shapes. Merging them would mean one
 * component carrying both looks via flags.
 */

import React, { useState } from 'react';
import { ArrowLeftRight, ChevronDown, ChevronUp } from 'lucide-react';

/** Tiny muted pill flagging a best time older than the recency window. */
export function StalePill() {
  return (
    <span
      className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full border border-theme-soft text-theme-muted text-ui-micro font-semibold uppercase tracking-wide leading-none"
      title="Best time is older than the recency window — verify before relying on it"
    >
      stale
    </span>
  );
}

/** Amber pill for rows whose projected gain sits inside conversion-factor noise. */
export function VerifyPill() {
  return (
    <span
      className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full border border-amber-400/40 text-amber-400/90 text-ui-micro font-semibold uppercase tracking-wide leading-none"
      title="Winning margin is within ~1% of a converted (LCM/SCM→SCY) time — verify in practice before relying on this projection"
    >
      verify in practice
    </span>
  );
}

export function AthleteButton({
  name,
  onJumpAthlete,
  className = '',
}: {
  name: string;
  onJumpAthlete?: (name: string) => void;
  className?: string;
}) {
  if (!onJumpAthlete) {
    return (
      <span
        className={`truncate text-[var(--text-primary)] font-semibold ${className}`}
        title={name}
      >
        {name}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`truncate text-[var(--text-accent)] font-semibold hover:underline transition-colors ${className}`}
      title={name}
      onClick={() => onJumpAthlete(name)}
    >
      {name}
    </button>
  );
}

export function Section({
  title,
  icon,
  countLabel,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  countLabel?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-theme-soft pt-3.5 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <span className="flex items-center gap-2 text-ui-label font-semibold text-[var(--text-primary)] min-w-0">
          {icon}
          <span className="truncate">{title}</span>
          {countLabel ? (
            <span className="text-ui-caption font-mono tabular-nums text-theme-muted shrink-0">
              {countLabel}
            </span>
          ) : null}
        </span>
        {open ? (
          <ChevronUp size={16} className="shrink-0 text-theme-secondary" />
        ) : (
          <ChevronDown size={16} className="shrink-0 text-theme-secondary" />
        )}
      </button>
      {open ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

/** Small "Updating…" indicator shown in the panel header while a fresh result is pending. */
export function UpdatingBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      className="ml-auto flex items-center gap-1.5 text-ui-micro text-theme-muted"
      aria-live="polite"
    >
      <ArrowLeftRight size={11} className="animate-spin" />
      Updating…
    </span>
  );
}

/** Amber error line shown when the worker request fails; renders nothing otherwise. */
export function ArbitrageErrorNotice({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="text-ui-caption text-amber-400/90 leading-relaxed mb-3">
      Couldn&apos;t compute cross-course data — {error}
    </p>
  );
}

export function ShowAllToggle({
  shown,
  total,
  expanded,
  onToggle,
}: {
  shown: number;
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (total <= shown) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 text-ui-caption text-[var(--text-accent)] hover:underline"
    >
      {expanded ? 'Show fewer' : `Show all ${total}`}
    </button>
  );
}
