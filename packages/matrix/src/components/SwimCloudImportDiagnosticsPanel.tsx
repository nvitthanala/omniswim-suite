/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Replaces the "N warning(s) — see console" toast with something a coach can
 * actually read: skip reasons and parser warnings grouped by what they mean,
 * not a bare count. See `swimCloudImportDiagnostics.ts`'s own file header
 * for the finding this closes.
 *
 * `'ambiguous-round-duplicate'` skips are always shown expanded, named
 * (event, swimmer, detail) — that group is the one a coach must act on to
 * recover missing points, never folded behind a "show more" toggle the way
 * the merely-expected groups are.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { Badge, Button } from '@omniswim/ui';
import type { SwimCloudParseWarning } from '@omniswim/swimcloud/parser';
import type { SwimCloudMeetImportSkip } from '../lib/swimCloudMeetImportBridge';
import {
  groupSkipsByReason,
  groupWarningsByCode,
  skipReasonLabel,
  type SkipReasonGroup,
  type WarningCodeGroup,
} from '../lib/swimCloudImportDiagnostics';

export interface SwimCloudImportDiagnosticsPanelProps {
  readonly skipped: readonly SwimCloudMeetImportSkip[];
  /** Structured warnings (the clipboard import path has these). */
  readonly warnings?: readonly SwimCloudParseWarning[];
  /**
   * Pre-formatted warning strings (the capture-browser path only has these —
   * `apps/shell/lib/swimcloudCaptureRoutes.ts`'s `/parse` route returns
   * already-formatted messages, not `{code, message}` pairs, so they cannot
   * be grouped by code here without guessing at a code from the string).
   * Shown as a flat, still-visible list rather than folded back into
   * "see console" — never both this and `warnings` at once.
   */
  readonly rawWarnings?: readonly string[];
  readonly onDismiss: () => void;
}

function SizeTag({ n }: { n: number }) {
  return (
    <Badge tone="neutral" className="px-1.5 py-0 font-mono normal-case tracking-normal">
      {n}
    </Badge>
  );
}

function SkipGroupRow({ group }: { group: SkipReasonGroup }) {
  const [expanded, setExpanded] = useState(group.reason === 'ambiguous-round-duplicate');
  const alwaysOpen = group.reason === 'ambiguous-round-duplicate';
  return (
    <li className="border border-theme-soft rounded-lg">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => !alwaysOpen && setExpanded(e => !e)}
        aria-expanded={expanded}
        className="w-full justify-start px-3 py-2 text-left disabled:cursor-default"
        disabled={alwaysOpen}
      >
        {alwaysOpen ? null : expanded ? (
          <ChevronDown size={13} className="text-theme-secondary shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-theme-secondary shrink-0" />
        )}
        <span className="text-ui-caption text-[var(--text-primary)] flex-1">
          {skipReasonLabel(group.reason)}
        </span>
        <SizeTag n={group.count} />
      </Button>
      {expanded ? (
        <ul className="px-3 pb-2 space-y-1">
          {group.items.map((item, i) => (
            <li key={i} className="text-ui-micro text-theme-secondary">
              <span className="text-[var(--text-primary)]">{item.eventLabel}</span>
              {item.subject ? <span> · {item.subject}</span> : null}
              {item.detail ? <span className="text-theme-muted"> — {item.detail}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function WarningGroupRow({ group }: { group: WarningCodeGroup }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li className="border border-theme-soft rounded-lg">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
        className="w-full justify-start px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown size={13} className="text-theme-secondary shrink-0" />
        ) : (
          <ChevronRight size={13} className="text-theme-secondary shrink-0" />
        )}
        <span className="text-ui-caption text-[var(--text-primary)] flex-1 font-mono">{group.code}</span>
        <SizeTag n={group.count} />
      </Button>
      {expanded ? (
        <ul className="px-3 pb-2 space-y-1">
          {group.examples.map((msg, i) => (
            <li key={i} className="text-ui-micro text-theme-secondary">
              {msg}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SwimCloudImportDiagnosticsPanel({
  skipped,
  warnings,
  rawWarnings,
  onDismiss,
}: SwimCloudImportDiagnosticsPanelProps) {
  const [showStructural, setShowStructural] = useState(false);

  if (skipped.length === 0 && (warnings?.length ?? 0) === 0 && (rawWarnings?.length ?? 0) === 0) {
    return null;
  }

  const skipGroups = groupSkipsByReason(skipped);
  const warningGroups = warnings ? groupWarningsByCode(warnings) : [];
  const reviewSkips = skipGroups.filter(g => g.severity === 'review');
  const structuralSkips = skipGroups.filter(g => g.severity === 'structural');
  const reviewWarnings = warningGroups.filter(g => g.severity === 'review');
  const structuralWarnings = warningGroups.filter(g => g.severity === 'structural');
  const structuralCount =
    structuralSkips.reduce((s, g) => s + g.count, 0) + structuralWarnings.reduce((s, g) => s + g.count, 0);

  return (
    <div className="border border-theme-soft rounded-lg p-3 space-y-2" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ui-caption font-bold uppercase tracking-widest text-theme-secondary">
          Import notes
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="Dismiss import notes"
          className="p-1"
          leadingIcon={<X size={14} />}
        />
      </div>

      {reviewSkips.length === 0 && reviewWarnings.length === 0 && rawWarnings === undefined ? (
        <p className="text-ui-caption text-theme-muted">
          Nothing here needs a look — only expected structural notes below.
        </p>
      ) : null}

      {reviewSkips.length > 0 ? (
        <ul className="space-y-1.5">
          {reviewSkips.map(group => (
            <SkipGroupRow key={group.reason} group={group} />
          ))}
        </ul>
      ) : null}

      {reviewWarnings.length > 0 ? (
        <ul className="space-y-1.5">
          {reviewWarnings.map(group => (
            <WarningGroupRow key={group.code} group={group} />
          ))}
        </ul>
      ) : null}

      {rawWarnings && rawWarnings.length > 0 ? (
        <details>
          <summary className="text-ui-caption text-theme-secondary cursor-pointer">
            {rawWarnings.length} parser warning{rawWarnings.length === 1 ? '' : 's'} from this capture
          </summary>
          <ul className="mt-1.5 space-y-1 pl-3">
            {rawWarnings.map((w, i) => (
              <li key={i} className="text-ui-micro text-theme-secondary">
                {w}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {structuralCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowStructural(s => !s)}
          className="text-theme-muted hover:text-theme-secondary underline"
        >
          {showStructural ? 'Hide' : 'Show'} {structuralCount} expected structural note
          {structuralCount === 1 ? '' : 's'} (e.g. relay legs SwimCloud does not publish)
        </Button>
      ) : null}
      {showStructural && (structuralSkips.length > 0 || structuralWarnings.length > 0) ? (
        <ul className="space-y-1.5">
          {structuralSkips.map(group => (
            <SkipGroupRow key={group.reason} group={group} />
          ))}
          {structuralWarnings.map(group => (
            <WarningGroupRow key={group.code} group={group} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
