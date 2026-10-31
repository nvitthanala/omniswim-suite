/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Team/swimmer-name fields, the paste textarea and the Parse/Screenshot
 * buttons for AthleteHistoryImportPanel — split out of the panel's own
 * function body.
 */
import { Upload } from 'lucide-react';
import { Button, TeamSelect } from '@omniswim/ui';

type Props = {
  teamOptions: string[];
  team: string;
  busy: boolean;
  onTeamChange?: (team: string) => void;
  swimmerName: string;
  onSwimmerNameChange: (name: string) => void;
  paste: string;
  onPasteChange: (paste: string) => void;
  onParseText: () => void;
  onParseImage: (file: File) => void;
};

export default function AthleteHistoryImportForm({
  teamOptions,
  team,
  busy,
  onTeamChange,
  swimmerName,
  onSwimmerNameChange,
  paste,
  onPasteChange,
  onParseText,
  onParseImage,
}: Props) {
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
        {onTeamChange && teamOptions.length > 0 ? (
          <label className="flex flex-col gap-1.5 min-w-0">
            <span className="text-ui-caption text-theme-muted">Team</span>
            <TeamSelect
              teams={teamOptions}
              value={team && teamOptions.includes(team) ? team : ''}
              disabled={busy}
              onChange={e => onTeamChange(e.target.value)}
              className="glass-input w-full rounded-lg px-3 py-2.5 text-ui-body appearance-none"
              placeholderDisabled
            />
          </label>
        ) : (
          // No picker here: the Manager team bar is the one place a team is chosen.
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="text-ui-caption text-theme-muted">Importing for team</span>
            <p className="rounded-lg border border-theme-soft surface-muted-bg px-3 py-2.5 text-ui-body text-[var(--text-primary)] truncate">
              {team || 'No team chosen'}
            </p>
          </div>
        )}
        <label className="flex flex-col gap-1.5 min-w-0">
          <span className="text-ui-caption text-theme-muted">Swimmer name (optional)</span>
          <input
            type="text"
            value={swimmerName}
            disabled={busy}
            onChange={e => onSwimmerNameChange(e.target.value)}
            placeholder="Auto-detected from paste"
            className="glass-input w-full rounded-lg px-3 py-2.5 font-sans text-ui-body"
          />
        </label>
      </div>

      {!team ? (
        <p className="text-ui-caption text-warning-soft mb-3">
          Choose a team in the team bar above before importing.
        </p>
      ) : null}

      <label className="flex flex-col gap-1.5 mb-3">
        <span className="text-ui-caption text-theme-muted">Paste table</span>
        <textarea
          value={paste}
          disabled={busy}
          onChange={e => onPasteChange(e.target.value)}
          placeholder="Paste Personal Bests table from SwimCloud…"
          className="w-full min-h-[8rem] resize-y glass-input rounded-lg px-3 py-2.5 font-mono text-ui-body"
        />
      </label>

      <div className="flex flex-wrap gap-2 mb-4">
        <Button variant="outline" size="md" disabled={busy || !paste.trim()} onClick={onParseText}>
          Parse text
        </Button>
        <label className="text-ui-label px-4 py-2 border border-theme-soft rounded-lg cursor-pointer flex items-center gap-2 hover:bg-[var(--hover-overlay)]">
          <Upload size={14} />
          Screenshot
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={busy}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) onParseImage(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </>
  );
}
