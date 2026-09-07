/**
 * Enhanced SwimCloud paste import with format detection and merge preview.
 */
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { X, ClipboardPaste, Download, FileSpreadsheet, Globe, Undo2 } from 'lucide-react';
import { Gender, HistoricalSwim, Workspace } from '@omniswim/core/types';
import {
  detectSwimCloudPasteFormat,
  parseSwimCloudPasteDetailed,
} from '@omniswim/core/lib/athleteHistory';
import {
  formatHistoryImportSummary,
  importHistoryToRoster,
  previewHistoryImportActions,
  rosterNamesForTeam,
  type ImportSwimmerAction,
} from '@omniswim/core/lib/historyImportRoster';
import {
  addAliasLink,
  buildAliasResolver,
  suggestAliasCandidates,
  type AliasNameEntry,
  type AliasSuggestion,
} from '@omniswim/core/lib/athleteAliases';
import { parseCsvHistory } from '@omniswim/core/lib/csvImport';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { useToast } from '@omniswim/ui';
import AliasSuggestionsPanel from './AliasSuggestionsPanel';
// Track A (plans/2026-09-06/): the browser extension's clipboard capture,
// read back here. Deliberately imported from these specific subpaths, not
// the @omniswim/swimcloud package root — see
// packages/manager/src/lib/swimCloudImportBridge.ts's file header for why
// (the root re-exports Node-only fetcher/cache code this UI package must
// never pull into its bundle).
import { readSwimCloudClipboardPayload } from '@omniswim/swimcloud/clipboardPayload';
import { classifySwimCloudUrl } from '@omniswim/swimcloud/urlClassifier';
import { parseMeetResultsHtml, parseSwimmerProfileHtml, parseTeamRosterHtml } from '@omniswim/swimcloud/parser';
import {
  swimCloudMeetResultsToHistoricalSwims,
  swimCloudPersonalBestsToHistoricalSwims,
} from '../lib/swimCloudImportBridge';
import { foldDiacritics, normalizeSwimmerName } from '@omniswim/core/lib/utils';

type ImportMode = 'paste' | 'csv';

type Props = {
  workspace: Workspace;
  gender: Gender;
  onClose: () => void;
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>;
};

function uniqueTeams(workspace: Workspace, gender: Gender): string[] {
  const field = gender === Gender.MEN ? workspace.menResults : workspace.womenResults;
  const teams = new Set<string>();
  for (const r of field ?? []) {
    if (r.team) teams.add(r.team);
  }
  return [...teams].sort();
}

/** Roster names (results + recruits) for a team/gender — the "existing" side of alias suggestions. */
function rosterNameEntriesForTeam(workspace: Workspace, team: string, gender: Gender): AliasNameEntry[] {
  return rosterNamesForTeam(workspace, team, gender).map(name => ({ name, team, gender }));
}

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

export default function RosterImportWizard({ workspace, gender, onClose, onUpdate }: Props) {
  const toast = useToast();
  const teams = useMemo(() => uniqueTeams(workspace, gender), [workspace, gender]);
  const [team, setTeam] = useState('');
  const [mode, setMode] = useState<ImportMode>('paste');
  const [paste, setPaste] = useState('');
  const [preview, setPreview] = useState<HistoricalSwim[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [format, setFormat] = useState<string>('unknown');
  const [step, setStep] = useState<'paste' | 'preview'>('paste');
  const [showReference, setShowReference] = useState(false);
  const [isImportingFromClipboard, setIsImportingFromClipboard] = useState(false);
  const [dismissedAliasKeys, setDismissedAliasKeys] = useState<Set<string>>(new Set());
  const [lastAliasLink, setLastAliasLink] = useState<{
    inverse: Partial<Workspace>;
    description: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // If gender/meet changes and current team is no longer in the list, clear it.
  useEffect(() => {
    if (team && teams.length > 0 && !teams.includes(team)) {
      setTeam('');
    }
  }, [teams, team, gender]);

  const handleParse = () => {
    if (!team.trim()) {
      toast.push('error', 'Select or enter a team name.');
      return;
    }
    if (mode === 'csv') {
      const result = parseCsvHistory(paste, { team: team.trim(), gender });
      if (result.swims.length === 0) {
        toast.push('error', result.warnings[0] || 'No rows parsed from CSV.');
        if (result.warnings.length === 0) return;
      }
      setPreview(result.swims);
      setWarnings(result.warnings);
      setFormat('csv');
      setStep('preview');
      setDismissedAliasKeys(new Set());
      setLastAliasLink(null);
      return;
    }
    const result = parseSwimCloudPasteDetailed(paste, {
      team: team.trim(),
      gender,
      division: divisionForTeamOrNull(team.trim()) ?? undefined,
    });
    setPreview(result.swims);
    setWarnings(result.warnings);
    setFormat(result.format);
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setLastAliasLink(null);
  };

  /**
   * Track A end-to-end: clipboard text (from extensions/swimcloud-companion)
   * -> validated capture payload -> classified URL -> parsed per the page
   * kind -> either HistoricalSwim[] into the same preview step every other
   * import path uses (swimmer profile, meet results) or an informational
   * summary (team roster — see handleClipboardTeamRoster's own comment for
   * why that one can't feed the preview grid at all).
   */
  const handleClipboardImport = async () => {
    if (!team.trim()) {
      toast.push('error', 'Select or enter a team name first.');
      return;
    }
    setIsImportingFromClipboard(true);
    try {
      let clipboardText: string;
      try {
        clipboardText = await navigator.clipboard.readText();
      } catch {
        toast.push(
          'error',
          'Could not read the clipboard. Your browser may need permission, or nothing has been copied yet — use the "Copy for Omniswim" button on a SwimCloud page first.'
        );
        return;
      }

      const payloadResult = readSwimCloudClipboardPayload(clipboardText);
      if (!payloadResult.ok) {
        toast.push('error', payloadResult.message);
        return;
      }

      const classification = classifySwimCloudUrl(payloadResult.payload.sourceUrl);
      if (classification.outcome !== 'fetchable') {
        toast.push('error', 'That clipboard capture is not a recognized SwimCloud page.');
        return;
      }
      const { resource } = classification;

      if (resource.kind === 'swimmer') {
        handleClipboardSwimmerProfile(payloadResult.payload.html, payloadResult.context, resource.swimmerId);
      } else if (resource.kind === 'meet' || resource.kind === 'meetEvent') {
        handleClipboardMeetResults(payloadResult.payload.html, payloadResult.context, resource.meetId);
      } else if (resource.kind === 'team' || resource.kind === 'teamRoster') {
        handleClipboardTeamRoster(payloadResult.payload.html, payloadResult.context, resource.teamId);
      } else {
        toast.push(
          'error',
          `This importer doesn't read "${resource.kind}" pages. Copy a swimmer profile, a team roster, or a meet results page instead.`
        );
      }
    } finally {
      setIsImportingFromClipboard(false);
    }
  };

  function handleClipboardSwimmerProfile(
    html: string,
    context: Parameters<typeof parseSwimmerProfileHtml>[1],
    swimmerId: string
  ) {
    const parseResult = parseSwimmerProfileHtml(html, context, { swimmerId, gender });
    if (!parseResult.ok) {
      toast.push('error', `Could not read personal bests from that page: ${parseResult.failure.message}`);
      return;
    }

    const conversion = swimCloudPersonalBestsToHistoricalSwims(parseResult.data, {
      team: team.trim(),
      gender,
    });
    if (!conversion.ok) {
      toast.push('error', conversion.message);
      return;
    }
    if (conversion.swims.length === 0) {
      toast.push(
        'error',
        `No usable times found on that page (${conversion.skipped.length} row(s) had no readable time).`
      );
      return;
    }

    setPreview([...conversion.swims]);
    setWarnings([
      ...new Set(parseResult.warnings.map(w => w.message)),
      ...(conversion.skipped.length > 0
        ? [`${conversion.skipped.length} row(s) skipped — no usable time.`]
        : []),
    ]);
    setFormat('swimcloud');
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setLastAliasLink(null);
  }

  /**
   * The bulk path — one meet-results capture gives every one of the
   * selected team's swimmers who competed at that meet, not one swimmer at
   * a time. Filtered to `team` + `gender`; relay events are never converted
   * (see swimCloudMeetResultsToHistoricalSwims's file header on why a relay
   * split isn't a valid individual time).
   */
  function handleClipboardMeetResults(
    html: string,
    context: Parameters<typeof parseMeetResultsHtml>[1],
    meetId: string
  ) {
    const parseResult = parseMeetResultsHtml(html, context, { meetId });
    if (!parseResult.ok) {
      toast.push('error', `Could not read results from that page: ${parseResult.failure.message}`);
      return;
    }

    const conversion = swimCloudMeetResultsToHistoricalSwims(parseResult.data, {
      team: team.trim(),
      gender,
    });
    if (conversion.swims.length === 0) {
      const teamName = team.trim();
      toast.push(
        'error',
        `No ${gender.toLowerCase()} swims found for "${teamName}" in this meet (${conversion.skipped.length} row(s) skipped — wrong team, wrong gender, relay, or no time). Check the team name matches exactly what SwimCloud printed.`
      );
      return;
    }

    setPreview([...conversion.swims]);
    const skippedByReason = new Map<string, number>();
    for (const row of conversion.skipped) {
      skippedByReason.set(row.reason, (skippedByReason.get(row.reason) ?? 0) + 1);
    }
    // De-duplicated: a multi-event meet routinely repeats the exact same
    // warning text once per event (e.g. "points column ignored" fires per
    // event, not once for the whole capture) — showing it N times adds
    // nothing a coach needs to see N times.
    setWarnings([
      ...new Set(parseResult.warnings.map(w => w.message)),
      ...Array.from(skippedByReason.entries()).map(
        ([reason, count]) => `${count} row(s) skipped — ${reason.replace(/-/g, ' ')}.`
      ),
    ]);
    setFormat('swimcloud');
    setStep('preview');
    setDismissedAliasKeys(new Set());
    setLastAliasLink(null);
    toast.push('success', `Imported ${conversion.swims.length} swim(s) from ${parseResult.data.meetName ?? 'this meet'}.`);
  }

  /**
   * Team-roster pages carry names/class years, never times — and every swim
   * record in this app (HistoricalSwim, Recruit) requires an event and a
   * time; there is no "bare athlete" concept to import one into (see
   * plans/2026-09-06's Phase 3 worklog). So this doesn't touch the preview
   * grid at all — it stays purely informational: how many swimmers the
   * roster lists, and which of them aren't already in this workspace, so a
   * coach knows who's worth visiting individually (or checking a meet
   * result for). Real, useful signal without pretending to have data this
   * page doesn't contain.
   */
  function handleClipboardTeamRoster(
    html: string,
    context: Parameters<typeof parseTeamRosterHtml>[1],
    teamId: string
  ) {
    const parseResult = parseTeamRosterHtml(html, context, { teamId, gender });
    if (!parseResult.ok) {
      toast.push('error', `Could not read the roster from that page: ${parseResult.failure.message}`);
      return;
    }

    const existingNames = new Set(
      rosterNamesForTeam(workspace, team.trim(), gender).map(name => foldDiacritics(normalizeSwimmerName(name)))
    );
    const newAthletes = parseResult.data.athletes.filter(
      a => !existingNames.has(foldDiacritics(normalizeSwimmerName(a.name)))
    );

    const total = parseResult.data.athletes.length;
    if (newAthletes.length === 0) {
      toast.push(
        'success',
        `Roster captured: all ${total} swimmer(s) are already in this workspace. (SwimCloud roster pages don't include times — visit a swimmer's own profile, or this team's meet results, to bring in swim data.)`
      );
      return;
    }
    const namesPreview = newAthletes.slice(0, 8).map(a => a.name).join(', ');
    const overflow = newAthletes.length > 8 ? `, +${newAthletes.length - 8} more` : '';
    toast.push(
      'success',
      `Roster captured: ${total} swimmer(s), ${newAthletes.length} not yet in this workspace: ${namesPreview}${overflow}. SwimCloud roster pages don't include times — visit each swimmer's own profile, or this team's meet results, to bring in swim data.`
    );
  }

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setPaste(text);
      setMode('csv');
    } catch (err) {
      toast.push('error', `Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  const handleMerge = async () => {
    if (preview.length === 0 || !team.trim()) return;
    const result = importHistoryToRoster(workspace, preview, {
      team: team.trim(),
      gender,
      sourceType: mode === 'csv' ? 'csv_import' : 'swimcloud_paste',
      sourceLabel: `${format} import (${team})`,
    });
    if (result.noop) return;
    await onUpdate(result.patch);
    toast.push('success', formatHistoryImportSummary(result.summary));
    onClose();
  };

  const swimmerActions = useMemo(
    () =>
      team.trim()
        ? previewHistoryImportActions(workspace, preview, { team: team.trim(), gender })
        : [],
    [workspace, preview, team, gender]
  );

  // Same alias-suggestion approach as AthleteHistoryImportPanel: unmatched
  // incoming swimmers (previewHistoryImportActions couldn't confidently match
  // them) vs every roster name for this team/gender. Depends on
  // workspace.athleteAliases so a just-added link drops its own suggestion.
  const aliasSuggestions = useMemo<AliasSuggestion[]>(() => {
    const trimmedTeam = team.trim();
    if (!trimmedTeam || swimmerActions.length === 0) return [];
    const existingNames = rosterNameEntriesForTeam(workspace, trimmedTeam, gender);
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
  }, [
    workspace.menResults,
    workspace.womenResults,
    workspace.recruits,
    workspace.athleteAliases,
    swimmerActions,
    team,
    gender,
  ]);

  const handleLinkAlias = (suggestion: AliasSuggestion) => {
    const result = addAliasLink(workspace, {
      canonicalName: suggestion.existing.name,
      aliasName: suggestion.incoming.name,
      gender: suggestion.incoming.gender,
      team: suggestion.existing.team ?? suggestion.incoming.team,
      source: 'import',
    });
    void onUpdate(result.patch);
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
    void onUpdate(lastAliasLink.inverse);
    toast.push('success', `Undid: ${lastAliasLink.description}`);
    setLastAliasLink(null);
  };

  const detectedFormat =
    mode === 'paste' && paste.trim() ? detectSwimCloudPasteFormat(paste) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--backdrop)]">
      <div
        className="surface-card border border-theme w-full max-w-2xl max-h-[90vh] flex flex-col rounded-xl"
        style={{ boxShadow: 'var(--ui-shadow-lg)' }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-theme-soft">
          <div>
            <h3 className="text-ui-label font-black uppercase tracking-widest">Import Roster / History</h3>
            <p className="text-ui-caption text-theme-muted mt-1">
              Paste SwimCloud Personal Bests or roster table text
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-2 theme-hover-row rounded-lg transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {step === 'paste' ? (
            <>
              <div className="flex items-center gap-1 border-b border-theme-soft">
                <button
                  type="button"
                  onClick={() => setMode('paste')}
                  className={`px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${mode === 'paste' ? 'border-[var(--text-accent)] text-[var(--text-primary)]' : 'border-transparent nav-tab-inactive'}`}
                >
                  <ClipboardPaste size={13} /> Paste
                </button>
                <button
                  type="button"
                  onClick={() => setMode('csv')}
                  className={`px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 border-b-2 -mb-px transition-colors ${mode === 'csv' ? 'border-[var(--text-accent)] text-[var(--text-primary)]' : 'border-transparent nav-tab-inactive'}`}
                >
                  <FileSpreadsheet size={13} /> CSV
                </button>
                <button
                  type="button"
                  onClick={() => setShowReference(s => !s)}
                  className={`ml-auto px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 transition-colors ${showReference ? 'text-[var(--text-primary)]' : 'nav-tab-inactive'}`}
                >
                  <Globe size={13} /> SwimCloud
                </button>
                <button
                  type="button"
                  onClick={() => void handleClipboardImport()}
                  disabled={isImportingFromClipboard}
                  title="Read a capture from the Omniswim SwimCloud Companion browser extension (extensions/swimcloud-companion), copied via its 'Copy for Omniswim' button on a swimmer's profile page."
                  className="px-3 py-2 text-ui-micro font-bold uppercase tracking-widest flex items-center gap-1.5 nav-tab-inactive hover:text-[var(--text-primary)] transition-colors disabled:opacity-40"
                >
                  <Download size={13} /> {isImportingFromClipboard ? 'Reading…' : 'From clipboard'}
                </button>
              </div>

              {showReference ? (
                <div className="border border-theme-soft rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-[var(--surface-strong)] text-ui-caption text-theme-muted flex items-center justify-between">
                    <span>Reference panel — open SwimCloud, then copy/paste into the importer.</span>
                    <a
                      href="https://www.swimcloud.com/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[var(--text-accent)] hover:underline"
                    >
                      Open in new tab ↗
                    </a>
                  </div>
                  <iframe
                    title="SwimCloud reference"
                    src="https://www.swimcloud.com/"
                    className="w-full h-64 bg-white"
                    sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
                  />
                </div>
              ) : null}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1">
                  <span className="label-caps">Team</span>
                  <select
                    value={team && teams.includes(team) ? team : ''}
                    onChange={e => setTeam(e.target.value)}
                    className="glass-input px-3 py-2 rounded-lg text-ui-body appearance-none"
                  >
                    <option value="" disabled>
                      Select a team…
                    </option>
                    {teams.map(t => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  {teams.length === 0 ? (
                    <span className="text-ui-caption text-theme-muted">
                      Load a meet PDF first, or type a custom team below.
                    </span>
                  ) : null}
                  <input
                    value={team}
                    onChange={e => setTeam(e.target.value)}
                    className="glass-input px-3 py-2 rounded-lg text-ui-body mt-1"
                    placeholder="Or type a team name…"
                    aria-label="Custom team name"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="label-caps">Gender</span>
                  <div className="px-3 py-2 rounded-lg border border-theme-soft text-ui-body bg-[var(--surface-muted)]">
                    {gender}
                  </div>
                </label>
              </div>
              <label className="flex flex-col gap-1">
                <span className="label-caps flex items-center gap-2">
                  {mode === 'csv' ? <FileSpreadsheet size={14} /> : <ClipboardPaste size={14} />}
                  {mode === 'csv' ? 'CSV content' : 'Paste text'}
                  {mode === 'csv' ? (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-[var(--text-accent)] normal-case hover:underline ml-1"
                    >
                      (choose file…)
                    </button>
                  ) : detectedFormat && detectedFormat !== 'unknown' ? (
                    <span className="text-[var(--text-accent)] normal-case">({detectedFormat.replace('_', ' ')})</span>
                  ) : null}
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.tsv,.txt,text/csv"
                  onChange={handleFile}
                  className="hidden"
                />
                <textarea
                  value={paste}
                  onChange={e => setPaste(e.target.value)}
                  rows={10}
                  className="glass-input px-3 py-2 rounded-lg text-ui-body font-mono text-sm resize-y"
                  placeholder={
                    mode === 'csv'
                      ? 'Paste CSV with header row: name,event,time[,team,gender,date,meet]'
                      : 'Paste Personal Bests or roster table from SwimCloud…'
                  }
                />
              </label>
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 text-ui-caption">
                <span className="badge-info px-2 py-0.5 rounded-full">{format}</span>
                <span className="text-theme-muted">{preview.length} swims parsed</span>
                {warnings.map((w, i) => (
                  // Index-qualified: `warnings` is plain string[], and two
                  // genuinely different warnings can print identical text
                  // (e.g. the same "points column ignored" message recurs
                  // once per event in a multi-event meet-results import) —
                  // `key={w}` alone broke on exactly that case.
                  <span key={`${i}-${w}`} className="badge-warning px-2 py-0.5 rounded-full">
                    {w}
                  </span>
                ))}
              </div>
              {swimmerActions.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {swimmerActions.map(s => (
                    <span
                      key={`${s.name}|${s.action}`}
                      className="text-ui-micro px-1.5 py-0.5 rounded-full border border-theme-soft"
                    >
                      {s.name}: {actionLabel(s.action)}
                    </span>
                  ))}
                </div>
              ) : null}
              {aliasSuggestions.length > 0 ? (
                <AliasSuggestionsPanel
                  suggestions={aliasSuggestions}
                  dismissed={dismissedAliasKeys}
                  onLink={handleLinkAlias}
                  onDismiss={handleDismissAlias}
                />
              ) : null}
              {lastAliasLink ? (
                <button
                  type="button"
                  onClick={handleUndoAliasLink}
                  title={lastAliasLink.description}
                  className="flex w-full items-center gap-1.5 truncate rounded-lg border border-theme-soft px-2.5 py-1.5 text-left text-ui-caption text-theme-muted transition-colors hover:text-theme-secondary"
                >
                  <Undo2 size={12} className="shrink-0" />
                  <span className="truncate">Undo: {lastAliasLink.description}</span>
                </button>
              ) : null}
              <div className="border border-theme-soft rounded-lg max-h-64 overflow-y-auto custom-scrollbar">
                <table className="w-full text-ui-caption">
                  <thead className="sticky top-0 bg-[var(--surface-strong)]">
                    <tr className="text-left text-theme-muted uppercase tracking-wider">
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
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-theme-soft">
          {step === 'preview' ? (
            <button
              type="button"
              onClick={() => setStep('paste')}
              className="px-4 py-2 text-ui-micro font-bold uppercase tracking-widest nav-tab-inactive hover:text-[var(--text-primary)]"
            >
              Back
            </button>
          ) : null}
          <button type="button" onClick={onClose} className="px-4 py-2 text-ui-micro font-bold uppercase tracking-widest nav-tab-inactive">
            Cancel
          </button>
          {step === 'paste' ? (
            <button
              type="button"
              onClick={handleParse}
              disabled={!paste.trim()}
              className="px-4 py-2 btn-primary rounded-lg text-ui-micro font-bold uppercase tracking-widest disabled:opacity-40"
            >
              Preview
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleMerge()}
              disabled={preview.length === 0}
              className="px-4 py-2 btn-primary rounded-lg text-ui-micro font-bold uppercase tracking-widest disabled:opacity-40"
            >
              Import & add to roster
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
