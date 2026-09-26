/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { ClassYear, Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  previewHistoryImportActions,
  previewSwimCloudReplace,
  SwimCloudReplaceRefusedError,
} from '@omniswim/core/lib/historyImportRoster';
import { backupWorkspaces } from '@omniswim/core/api/workspaces';
import {
  addAliasLink,
  buildAliasResolver,
  suggestAliasCandidates,
  type AliasNameEntry,
  type AliasSuggestion,
} from '@omniswim/core/lib/athleteAliases';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { convertTimeToSeconds } from '@omniswim/core/lib/utils';
import { computedCutTooltip } from '@omniswim/core/lib/cutlineTags';
import { useToast } from '@omniswim/ui';
import SwimCloudReplaceConfirmModal from './SwimCloudReplaceConfirmModal';
import { performSwimCloudImport, type SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import {
  buildHistoryBestIndex,
  diffMatchKey,
  rosterNameEntriesForTeam,
  splitUnreadStampWarnings,
  type ImportDiffStatus,
  type RowMeta,
} from './athleteHistoryImportView';
import AthleteHistoryImportHeader from './AthleteHistoryImportHeader';
import AthleteHistoryImportForm from './AthleteHistoryImportForm';
import AthleteHistoryImportMessages from './AthleteHistoryImportMessages';
import AthleteHistoryClassYearsGrid from './AthleteHistoryClassYearsGrid';
import AthleteHistorySwimmerActionBadges from './AthleteHistorySwimmerActionBadges';
import AthleteHistoryPreviewSection from './AthleteHistoryPreviewSection';

type Props = {
  workspace: Workspace;
  gender: Gender;
  team: string;
  /** Teams available for the import target selector. */
  teams?: string[];
  onUpdate: (patch: Partial<Workspace>) => void;
  onTeamChange?: (team: string) => void;
  /** When true, parse/preview still works but merge into workspace is blocked. */
  importDisabled?: boolean;
  /** Notifies parent of the class years picked in the preview (normalized-name keyed). */
  onClassYearsChange?: (overrides: Record<string, ClassYear>) => void;
};

export default function AthleteHistoryImportPanel({
  workspace,
  gender,
  team,
  teams = [],
  onUpdate,
  onTeamChange,
  importDisabled,
  onClassYearsChange,
}: Props) {
  const toast = useToast();
  const [paste, setPaste] = useState('');
  const [swimmerName, setSwimmerName] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [formatLabel, setFormatLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [showInfo, setShowInfo] = useState(false);
  const [classYears, setClassYears] = useState<Record<string, ClassYear>>({});
  /** Defaults to 'merge' — see SwimCloudImportModePicker. */
  const [importMode, setImportMode] = useState<SwimCloudImportMode>('merge');
  const [showReplaceConfirm, setShowReplaceConfirm] = useState(false);
  const [replaceBusy, setReplaceBusy] = useState(false);
  const [dismissedAliasKeys, setDismissedAliasKeys] = useState<Set<string>>(new Set());
  const [lastAliasLink, setLastAliasLink] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  const [, startPreviewTransition] = useTransition();
  const infoRef = useRef<HTMLDivElement>(null);
  const teamOptions = teams.length > 0 ? teams : team ? [team] : [];

  const swimmerActions = useMemo(
    () => previewHistoryImportActions(workspace, preview, { team, gender }),
    [workspace, preview, team, gender]
  );

  const replacePreview = useMemo(
    () =>
      importMode === 'replace' && team.trim() && preview.length > 0
        ? previewSwimCloudReplace(workspace, preview, { team, gender })
        : null,
    [importMode, workspace, preview, team, gender]
  );

  // Suggestions compare unmatched incoming swimmers (previewHistoryImportActions
  // couldn't confidently match them to the roster) against every roster name for
  // this team/gender. Depends on workspace.athleteAliases so a just-added link
  // removes its own suggestion (resolver.areLinked short-circuits it) and the
  // list stays current after a Link click re-renders with the patched workspace.
  const aliasSuggestions = useMemo<AliasSuggestion[]>(() => {
    if (!team.trim() || swimmerActions.length === 0) return [];
    const existingNames = rosterNameEntriesForTeam(workspace, team, gender);
    if (existingNames.length === 0) return [];
    // All rows (not just new_recruit): an athlete already on the recruit list
    // under a long-form name still needs a link offer against the roster name.
    const incomingNames: AliasNameEntry[] = swimmerActions.map(s => ({
      name: s.name,
      team: s.team,
      gender: s.gender,
    }));
    if (incomingNames.length === 0) return [];
    const resolver = buildAliasResolver(workspace.athleteAliases ?? []);
    return suggestAliasCandidates(existingNames, incomingNames, { resolver });
  // Deliberate: depends on the individual workspace fields this reads, not the
  // whole object, so an unrelated workspace edit does not re-run the scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.recruits,
    workspace.athleteAliases,
    swimmerActions,
    team,
    gender,
  ]);

  const rowMeta = useMemo<RowMeta[]>(() => {
    const resolver = buildAliasResolver(workspace.athleteAliases ?? []);
    const bestIndex = buildHistoryBestIndex(workspace.athleteHistory ?? [], resolver);
    return preview.map(s => {
      const resolvedName = resolver.resolveAthleteName(s.name, s.team, s.gender);
      const key = diffMatchKey(resolvedName, s.team, s.event, s.timeType);
      const existingSec = bestIndex.get(key);
      const sec = convertTimeToSeconds(s.time);
      let diffStatus: ImportDiffStatus;
      let deltaSec: number | undefined;
      if (existingSec == null) {
        diffStatus = 'new';
      } else if (Number.isFinite(sec) && sec < existingSec - 1e-9) {
        diffStatus = 'improved';
        deltaSec = existingSec - sec;
      } else {
        diffStatus = 'same';
      }

      let cutTooltip: string | undefined;
      if (s.computedCut === 'A' || s.computedCut === 'B') {
        const division = divisionForTeamOrNull(s.team);
        if (division) {
          // Quote the table in the swim's own course: an NAIA SCM badge was
          // judged against the NAIA metre standard, not the yards one.
          cutTooltip = computedCutTooltip(s, division) ?? undefined;
        } else {
          cutTooltip = "This team's division is unknown, so the cut standard shown may not be the right table.";
        }
      }

      return { diffStatus, deltaSec, cutTooltip };
    });
  }, [preview, workspace.athleteHistory, workspace.athleteAliases]);

  const diffSummary = useMemo(() => {
    let newCount = 0;
    let improvedCount = 0;
    let unchangedCount = 0;
    for (const m of rowMeta) {
      if (m.diffStatus === 'new') newCount += 1;
      else if (m.diffStatus === 'improved') improvedCount += 1;
      else unchangedCount += 1;
    }
    return { newCount, improvedCount, unchangedCount };
  }, [rowMeta]);

  const { otherWarnings, unreadStampSummary } = useMemo(
    () => splitUnreadStampWarnings(warnings),
    [warnings]
  );

  const previewNames = useMemo(() => {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const s of preview) {
      const key = s.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(s.name);
    }
    return names;
  }, [preview]);

  const setClassYear = (name: string, year: ClassYear) => {
    setClassYears(prev => {
      const next = { ...prev, [name]: year };
      onClassYearsChange?.(next);
      return next;
    });
  };

  const handleLinkAlias = (suggestion: AliasSuggestion) => {
    const result = addAliasLink(workspace, {
      canonicalName: suggestion.existing.name,
      aliasName: suggestion.incoming.name,
      gender: suggestion.incoming.gender,
      team: suggestion.existing.team ?? suggestion.incoming.team,
      source: 'import',
    });
    onUpdate(result.patch);
    setLastAliasLink({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  const handleDismissAlias = (key: string) => {
    setDismissedAliasKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const handleUndoAliasLink = () => {
    if (!lastAliasLink) return;
    onUpdate(lastAliasLink.inverse);
    toast.push('success', `Undid: ${lastAliasLink.description}`);
    setLastAliasLink(null);
  };

  useEffect(() => {
    if (!showInfo) return;
    const onDoc = (e: MouseEvent) => {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setShowInfo(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showInfo]);

  const parseLocal = () => {
    setError('');
    if (!team.trim()) {
      setError('Select a team before parsing.');
      return;
    }
    const division = divisionForTeamOrNull(team) ?? undefined;
    const result = parseSwimCloudPasteDetailed(paste, {
      team,
      gender,
      swimmerName: swimmerName.trim() || undefined,
      division,
    });
    // The parse is synchronous, but committing a large preview (~850 rows) plus its
    // derived table/badges is the expensive part. Mark those state updates as a
    // transition so the paste box and buttons stay responsive while React renders it.
    startPreviewTransition(() => {
      if (result.detectedName && !swimmerName.trim()) {
        setSwimmerName(result.detectedName);
      }
      setPreview(result.swims);
      setWarnings(result.warnings);
      setFormatLabel(result.format);
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      setImportMode('merge');
    });
  };

  const _parseText = () => parseLocal();

  const parseImage = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const s = String(reader.result ?? '');
          resolve(s.split(',')[1] ?? '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/parse-athlete-history', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64, team, gender }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setPreview([]);
        return;
      }
      setPreview(data.swims ?? []);
      setWarnings(data.warnings ?? []);
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      setImportMode('merge');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  /** Returns whether the import committed, so a confirm dialog knows whether it can close. */
  const runImport = async (importOpts: { mode: SwimCloudImportMode }): Promise<boolean> => {
    let backedUp = true;
    try {
      const result = await performSwimCloudImport(
        workspace,
        preview,
        {
          team,
          gender,
          sourceType: 'paste',
          sourceLabel: `Import ${preview.length} swims${swimmerName ? ` (${swimmerName})` : ''}`,
          classYearOverrides: Object.keys(classYears).length > 0 ? classYears : undefined,
          mode: importOpts.mode,
        },
        {
          backup: async () => {
            try {
              await backupWorkspaces();
            } catch (err) {
              backedUp = false;
              throw err;
            }
          },
        }
      );
      if (result.noop) return true;
      onUpdate(result.patch);
      toast.push('success', formatHistoryImportSummary(result.summary));
      setPreview([]);
      setPaste('');
      setWarnings([]);
      setFormatLabel('');
      setClassYears({});
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      setImportMode('merge');
      return true;
    } catch (err) {
      if (err instanceof SwimCloudReplaceRefusedError) {
        toast.push('error', err.message);
        return false;
      }
      if (!backedUp) {
        toast.push(
          'error',
          `Could not back up the workspace, so the replace was not run: ${err instanceof Error ? err.message : String(err)}`
        );
        return false;
      }
      toast.push('error', `Import failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };

  const confirmImport = () => {
    if (!preview.length || !team.trim()) return;
    if (importMode === 'replace') {
      setShowReplaceConfirm(true);
      return;
    }
    void runImport({ mode: 'merge' });
  };

  const handleConfirmReplace = async () => {
    setReplaceBusy(true);
    const committed = await runImport({ mode: 'replace' });
    setReplaceBusy(false);
    // Left open on failure so the coach can see why and retry.
    if (committed) setShowReplaceConfirm(false);
  };

  return (
    <div className="surface-card rounded-xl p-4 sm:p-5 shrink-0 min-w-0">
      <AthleteHistoryImportHeader infoRef={infoRef} showInfo={showInfo} onToggleInfo={() => setShowInfo(v => !v)} />

      <AthleteHistoryImportForm
        teamOptions={teamOptions}
        team={team}
        busy={busy}
        onTeamChange={onTeamChange}
        swimmerName={swimmerName}
        onSwimmerNameChange={setSwimmerName}
        paste={paste}
        onPasteChange={setPaste}
        onParseText={parseLocal}
        onParseImage={parseImage}
      />

      <AthleteHistoryImportMessages
        formatLabel={formatLabel}
        previewCount={preview.length}
        otherWarnings={otherWarnings}
        unreadStampSummary={unreadStampSummary}
        error={error}
      />

      <AthleteHistoryClassYearsGrid
        previewNames={previewNames}
        importDisabled={importDisabled}
        classYears={classYears}
        onSetClassYear={setClassYear}
      />

      <AthleteHistorySwimmerActionBadges swimmerActions={swimmerActions} />

      <AthleteHistoryPreviewSection
        preview={preview}
        rowMeta={rowMeta}
        aliasSuggestions={aliasSuggestions}
        importDisabled={importDisabled}
        dismissedAliasKeys={dismissedAliasKeys}
        onLinkAlias={handleLinkAlias}
        onDismissAlias={handleDismissAlias}
        lastAliasLink={lastAliasLink}
        onUndoAliasLink={handleUndoAliasLink}
        diffSummary={diffSummary}
        team={team}
        importMode={importMode}
        onSetImportMode={setImportMode}
        replacePreview={replacePreview}
        onConfirmImport={confirmImport}
      />
      {showReplaceConfirm && replacePreview ? (
        <SwimCloudReplaceConfirmModal
          preview={replacePreview}
          busy={replaceBusy}
          onCancel={() => setShowReplaceConfirm(false)}
          onConfirm={() => void handleConfirmReplace()}
        />
      ) : null}
    </div>
  );
}
