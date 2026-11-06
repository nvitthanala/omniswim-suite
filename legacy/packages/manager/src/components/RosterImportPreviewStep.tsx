/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * The "preview" step of RosterImportWizard — format/warning badges, the
 * merge/replace picker, improvements summary, per-swimmer action chips,
 * alias suggestions and the parsed-swims table. Split out of the wizard's
 * own function body so this region's branching lives here.
 */
import type { HistoricalSwim } from '@omniswim/core/types';
import { Badge, Button } from '@omniswim/ui';
import { Undo2 } from 'lucide-react';
import type {
  ImportSwimmerAction,
  ImportSwimmerPreview,
  SwimCloudReplacePreview,
} from '@omniswim/core/lib/historyImportRoster';
import type { AliasSuggestion } from '@omniswim/core/lib/athleteAliases';
import type { SwimCloudSwimmerImprovements } from '../lib/swimCloudImprovementDiff';
import type { SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import AliasSuggestionsPanel from './AliasSuggestionsPanel';
import SwimCloudImprovementsSummary from './SwimCloudImprovementsSummary';
import SwimCloudImportModePicker from './SwimCloudImportModePicker';
import SwimCloudReplacePreviewPanel from './SwimCloudReplacePreviewPanel';

function actionLabel(action: ImportSwimmerAction): string {
  switch (action) {
    case 'new_recruit':
      return 'New recruit';
    case 'add_to_lineup':
      return 'Add to lineup';
    case 'already_recruit':
      return 'Already recruit';
    case 'history_matched':
    default:
      return 'History only (matched)';
  }
}

type Props = {
  format: string;
  preview: HistoricalSwim[];
  warnings: string[];
  unreadStampSummary: string | null;
  team: string;
  importMode: SwimCloudImportMode;
  onSetImportMode: (mode: SwimCloudImportMode) => void;
  replacePreview: SwimCloudReplacePreview | null;
  improvementsComputed: boolean;
  improvements: readonly SwimCloudSwimmerImprovements[];
  showImprovements: boolean;
  onToggleImprovements: () => void;
  swimmerActions: ImportSwimmerPreview[];
  aliasSuggestions: AliasSuggestion[];
  dismissedAliasKeys: Set<string>;
  onLinkAlias: (suggestion: AliasSuggestion) => void;
  onDismissAlias: (key: string) => void;
  lastAliasLink: { inverse: unknown; description: string } | null;
  onUndoAliasLink: () => void;
};

export default function RosterImportPreviewStep({
  format,
  preview,
  warnings,
  unreadStampSummary,
  team,
  importMode,
  onSetImportMode,
  replacePreview,
  improvementsComputed,
  improvements,
  showImprovements,
  onToggleImprovements,
  swimmerActions,
  aliasSuggestions,
  dismissedAliasKeys,
  onLinkAlias,
  onDismissAlias,
  lastAliasLink,
  onUndoAliasLink,
}: Props) {
  return (
    <>
      <div className="flex flex-wrap gap-2 text-ui-caption">
        <Badge tone="info" className="px-2 py-0.5 font-normal normal-case tracking-normal">
          {format}
        </Badge>
        <span className="text-theme-muted">{preview.length} swims parsed</span>
        {warnings.map((w, i) => (
          // Index-qualified: `warnings` is plain string[], and two
          // genuinely different warnings can print identical text
          // (e.g. the same "points column ignored" message recurs
          // once per event in a multi-event meet-results import) —
          // `key={w}` alone broke on exactly that case.
          <Badge key={`${i}-${w}`} tone="warning" className="px-2 py-0.5 font-normal normal-case tracking-normal">
            {w}
          </Badge>
        ))}
      </div>
      {unreadStampSummary ? (
        <p className="text-ui-caption text-theme-secondary break-words">{unreadStampSummary}</p>
      ) : null}
      {team.trim() ? (
        <div className="border border-theme-soft rounded-lg p-3 space-y-3">
          <SwimCloudImportModePicker mode={importMode} onChange={onSetImportMode} />
          {replacePreview ? <SwimCloudReplacePreviewPanel preview={replacePreview} /> : null}
        </div>
      ) : null}
      {improvementsComputed ? (
        <SwimCloudImprovementsSummary improvements={improvements} expanded={showImprovements} onToggle={onToggleImprovements} />
      ) : null}
      {swimmerActions.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {swimmerActions.map(s => (
            <span key={`${s.name}|${s.action}`} className="text-ui-micro px-1.5 py-0.5 rounded-full border border-theme-soft">
              {s.name}: {actionLabel(s.action)}
            </span>
          ))}
        </div>
      ) : null}
      {aliasSuggestions.length > 0 ? (
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
          className="w-full truncate rounded-lg border border-theme-soft text-left text-theme-muted hover:text-theme-secondary"
          leadingIcon={<Undo2 size={12} className="shrink-0" />}
        >
          <span className="truncate">Undo: {lastAliasLink.description}</span>
        </Button>
      ) : null}
      <div className="border border-theme-soft rounded-lg max-h-64 overflow-y-auto custom-scrollbar">
        <table className="w-full text-ui-caption">
          <thead className="sticky top-0 bg-[var(--surface-strong)]">
            <tr className="text-left text-theme-muted">
              <th className="p-2">Name</th>
              <th className="p-2">Event</th>
              <th className="p-2">Time</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((s, i) => (
              <tr key={i} className="border-t border-theme-soft theme-hover-row transition-colors">
                <td className="p-2">{s.name}</td>
                <td className="p-2">{s.event}</td>
                <td className="p-2 font-mono tabular-nums">{s.time}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
