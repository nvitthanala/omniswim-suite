/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The parsed-swims preview table plus its footer (alias suggestions, undo,
 * diff summary and the merge/replace import action) for
 * AthleteHistoryImportPanel — split out of the panel's own function body.
 *
 * PERFORMANCE_NOTES #4: each row keeps its `content-visibility: auto` +
 * `contain-intrinsic-size` style exactly as it was inline in the panel — do
 * not drop it, and do not cap the row count. All rows still render; only
 * offscreen ones skip layout/paint.
 */
import type { HistoricalSwim } from '@omniswim/core/types';
import { Undo2 } from 'lucide-react';
import { Button } from '@omniswim/ui';
import type { SwimCloudReplacePreview } from '@omniswim/core/lib/historyImportRoster';
import type { AliasSuggestion } from '@omniswim/core/lib/athleteAliases';
import type { SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import type { ImportDiffStatus } from './athleteHistoryImportView';
import { SwimRowTags } from './AthleteHistoryImportPanelParts';
import AliasSuggestionsPanel from './AliasSuggestionsPanel';
import SwimCloudImportModePicker from './SwimCloudImportModePicker';
import SwimCloudReplacePreviewPanel from './SwimCloudReplacePreviewPanel';

type RowMeta = { diffStatus: ImportDiffStatus; deltaSec?: number; cutTooltip?: string };

type Props = {
  preview: HistoricalSwim[];
  rowMeta: RowMeta[];
  aliasSuggestions: AliasSuggestion[];
  importDisabled?: boolean;
  dismissedAliasKeys: Set<string>;
  onLinkAlias: (suggestion: AliasSuggestion) => void;
  onDismissAlias: (key: string) => void;
  lastAliasLink: { description: string } | null;
  onUndoAliasLink: () => void;
  diffSummary: { newCount: number; improvedCount: number; unchangedCount: number };
  team: string;
  importMode: SwimCloudImportMode;
  onSetImportMode: (mode: SwimCloudImportMode) => void;
  replacePreview: SwimCloudReplacePreview | null;
  onConfirmImport: () => void;
};

export default function AthleteHistoryPreviewSection({
  preview,
  rowMeta,
  aliasSuggestions,
  importDisabled,
  dismissedAliasKeys,
  onLinkAlias,
  onDismissAlias,
  lastAliasLink,
  onUndoAliasLink,
  diffSummary,
  team,
  importMode,
  onSetImportMode,
  replacePreview,
  onConfirmImport,
}: Props) {
  if (preview.length === 0) return null;

  return (
    <div className="border border-theme-soft rounded-xl overflow-hidden">
      <div className="max-h-56 overflow-y-auto custom-scrollbar">
        <table className="w-full text-ui-body">
          <thead className="sticky top-0 surface-muted-bg border-b border-theme-soft">
            <tr className="text-ui-caption text-theme-muted">
              <th className="text-left py-2.5 px-3 font-medium">Event</th>
              <th className="text-left py-2.5 px-3 font-medium">Time</th>
              <th className="text-left py-2.5 px-3 font-medium hidden sm:table-cell">Meet</th>
              <th className="text-right py-2.5 px-3 font-medium">Tags</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((s, i) => (
              <tr
                key={i}
                className="border-b border-theme-soft/50 last:border-0 theme-hover-row transition-colors"
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 37px' }}
              >
                <td className="py-2 px-3 text-[var(--text-primary)] break-words">{s.event}</td>
                <td className="py-2 px-3 font-mono tabular-nums whitespace-nowrap">{s.time}</td>
                <td
                  className="py-2 px-3 text-theme-secondary hidden sm:table-cell truncate max-w-[10rem]"
                  title={s.meetLabel}
                >
                  {s.meetLabel ?? '—'}
                </td>
                <td className="py-2 px-3">
                  <SwimRowTags
                    swim={s}
                    diffStatus={rowMeta[i]?.diffStatus ?? 'same'}
                    deltaSec={rowMeta[i]?.deltaSec}
                    cutTooltip={rowMeta[i]?.cutTooltip}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="p-3 border-t border-theme-soft surface-muted-bg">
        {aliasSuggestions.length > 0 && !importDisabled ? (
          <AliasSuggestionsPanel
            suggestions={aliasSuggestions}
            dismissed={dismissedAliasKeys}
            onLink={onLinkAlias}
            onDismiss={onDismissAlias}
          />
        ) : null}
        {lastAliasLink ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={onUndoAliasLink}
            title={lastAliasLink.description}
            className="mb-2 w-full truncate rounded-lg border border-theme-soft text-left text-theme-muted hover:text-theme-secondary"
            leadingIcon={<Undo2 size={12} className="shrink-0" />}
          >
            <span className="truncate">Undo: {lastAliasLink.description}</span>
          </Button>
        ) : null}
        <p className="text-ui-caption text-theme-secondary mb-2">
          {diffSummary.newCount} new · {diffSummary.improvedCount} improved · {diffSummary.unchangedCount} unchanged
        </p>
        {importDisabled ? (
          <p className="text-ui-caption text-theme-secondary leading-relaxed">
            Enable <strong className="text-[var(--text-primary)]">What-if</strong> to import onto the roster.
          </p>
        ) : !team.trim() ? (
          <p className="text-ui-caption text-amber-400/90">Select a team above before importing.</p>
        ) : (
          <>
            <div className="border border-theme-soft rounded-lg p-3 space-y-3 mb-3">
              <SwimCloudImportModePicker mode={importMode} onChange={onSetImportMode} />
              {replacePreview ? <SwimCloudReplacePreviewPanel preview={replacePreview} /> : null}
            </div>
            <Button
              variant="ghost"
              size="md"
              onClick={onConfirmImport}
              className="p-0 text-[var(--text-accent)] hover:underline font-semibold"
            >
              {importMode === 'replace'
                ? `Review replace… (${preview.length} swims)`
                : `Import & add to roster (${preview.length} swims)`}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
