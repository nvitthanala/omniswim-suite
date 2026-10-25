/**
 * State for `RosterImportWizard`, kept in one hook so the handler hooks
 * (parse, clipboard, capture browser, commit, alias linking) share one bag
 * of values and setters instead of the wizard threading each one by hand.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import { rosterNamesForTeam } from '@omniswim/core/lib/historyImportRoster';
import type { useToast } from '@omniswim/ui';
import type { SwimCloudImportMode } from '../lib/swimCloudReplaceFlow';
import type { RosterQueue } from '../lib/rosterQueueImport';
import type { SwimCloudSwimmerImprovements } from '../lib/swimCloudImprovementDiff';

export type ImportMode = 'paste' | 'csv';

export function uniqueTeams(workspace: Workspace, gender: Gender): string[] {
  const field = gender === Gender.MEN ? workspace.menResults : workspace.womenResults;
  const teams = new Set<string>();
  for (const r of field ?? []) {
    if (r.team) teams.add(r.team);
  }
  return [...teams].sort();
}

export function useRosterImportState(workspace: Workspace, gender: Gender) {
  const teams = useMemo(() => uniqueTeams(workspace, gender), [workspace, gender]);
  const [team, setTeam] = useState('');
  /**
   * Every name already on this workspace's roster for the selected team and
   * gender. Both roster-seeding paths read it, so "N not yet in this workspace"
   * counts the same swimmers however the roster arrived — clipboard capture or
   * bulk capture import.
   */
  const existingRosterNames = useMemo(
    () => (team.trim() ? rosterNamesForTeam(workspace, team.trim(), gender) : []),
    [workspace, team, gender]
  );
  const [mode, setMode] = useState<ImportMode>('paste');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** Compact summary of unreadable-stamp rows in the last paste parse, pulled out of `warnings`. */
  const [unreadStampSummary, setUnreadStampSummary] = useState<string | null>(null);
  const [format, setFormat] = useState<string>('unknown');
  const [step, setStep] = useState<'paste' | 'preview'>('paste');
  const [showReference, setShowReference] = useState(false);
  const [isImportingFromClipboard, setIsImportingFromClipboard] = useState(false);
  const [showCaptureRosterPanel, setShowCaptureRosterPanel] = useState(false);
  const [rosterQueue, setRosterQueue] = useState<RosterQueue | null>(null);
  const [dismissedAliasKeys, setDismissedAliasKeys] = useState<Set<string>>(new Set());
  const [lastAliasLink, setLastAliasLink] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  /**
   * Swimmers this import improved on, against what the workspace already
   * stored for them (P8: "after a re-crawl, show who improved"). Set by the
   * bulk capture path and the single-swimmer clipboard path alike; cleared
   * whenever a new preview replaces the last one so a stale diff can't linger
   * on unrelated swims.
   */
  const [improvements, setImprovements] = useState<readonly SwimCloudSwimmerImprovements[]>([]);
  /**
   * True only on the two paths that actually run the diff (single-swimmer
   * clipboard capture, bulk capture-browser import) — both convert through
   * `convertAndAccountSwimmerTimes`/`buildRosterImportFromCapture` with
   * `existingHistory` supplied. Paste, CSV and the meet-results bulk path
   * never compute one, so this stays false there and the panel stays hidden
   * rather than claiming "nothing improved" about a diff nobody ran.
   */
  const [improvementsComputed, setImprovementsComputed] = useState(false);
  const [showImprovements, setShowImprovements] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Defaults to 'merge' — see SwimCloudImportModePicker. */
  const [importMode, setImportMode] = useState<SwimCloudImportMode>('merge');

  // If gender/meet changes and current team is no longer in the list, clear it.
  useEffect(() => {
    if (team && teams.length > 0 && !teams.includes(team)) {
      setTeam('');
    }
  }, [teams, team, gender]);

  return {
    teams,
    team,
    setTeam,
    existingRosterNames,
    mode,
    setMode,
    paste,
    setPaste,
    preview,
    setPreview,
    warnings,
    setWarnings,
    unreadStampSummary,
    setUnreadStampSummary,
    format,
    setFormat,
    step,
    setStep,
    showReference,
    setShowReference,
    isImportingFromClipboard,
    setIsImportingFromClipboard,
    showCaptureRosterPanel,
    setShowCaptureRosterPanel,
    rosterQueue,
    setRosterQueue,
    dismissedAliasKeys,
    setDismissedAliasKeys,
    lastAliasLink,
    setLastAliasLink,
    improvements,
    setImprovements,
    improvementsComputed,
    setImprovementsComputed,
    showImprovements,
    setShowImprovements,
    fileInputRef,
    importMode,
    setImportMode,
  };
}

export type RosterImportState = ReturnType<typeof useRosterImportState>;

/** What every handler hook for the wizard reads. */
export interface RosterImportDeps {
  s: RosterImportState;
  workspace: Workspace;
  gender: Gender;
  toast: ReturnType<typeof useToast>;
}
