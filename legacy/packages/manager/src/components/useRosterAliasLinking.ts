/**
 * The alias-suggestion half of `RosterImportWizard`'s preview step: which
 * previewed swimmers need a match, which roster names they may be, and the
 * link / dismiss / undo actions.
 */
import { useMemo } from 'react';
import { Gender, Workspace } from '@omniswim/core/types';
import {
  previewHistoryImportActions,
  rosterNamesForTeam,
} from '@omniswim/core/lib/historyImportRoster';
import {
  addAliasLink,
  buildAliasResolver,
  suggestAliasCandidates,
  type AliasNameEntry,
  type AliasSuggestion,
} from '@omniswim/core/lib/athleteAliases';
import type { RosterImportDeps } from './useRosterImportState';

/** Roster names (results + recruits) for a team/gender — the "existing" side of alias suggestions. */
function rosterNameEntriesForTeam(workspace: Workspace, team: string, gender: Gender): AliasNameEntry[] {
  return rosterNamesForTeam(workspace, team, gender).map(name => ({ name, team, gender }));
}

export function useRosterAliasLinking(
  { s, workspace, gender, toast }: RosterImportDeps,
  onUpdate: (patch: Partial<Workspace>) => void | Promise<void>
) {
  const { team, preview, lastAliasLink } = s;

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
    const incomingNames: AliasNameEntry[] = swimmerActions.map(a => ({
      name: a.name,
      team: a.team,
      gender: a.gender,
    }));
    if (incomingNames.length === 0) return [];
    const resolver = buildAliasResolver(workspace.athleteAliases ?? []);
    return suggestAliasCandidates(existingNames, incomingNames, { resolver });
  // Deliberate: depends on the individual workspace fields this reads, not the
  // whole object, so an unrelated workspace edit does not re-run the scan.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the individual workspace fields the scan reads, so an unrelated workspace edit does not re-run it
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
    s.setLastAliasLink({ inverse: result.inverse, description: result.description });
    toast.push('success', result.description);
  };

  const handleDismissAlias = (key: string) => {
    s.setDismissedAliasKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  const handleUndoAliasLink = () => {
    if (!lastAliasLink) return;
    void onUpdate(lastAliasLink.inverse);
    toast.push('success', `Undid: ${lastAliasLink.description}`);
    s.setLastAliasLink(null);
  };

  return {
    swimmerActions,
    aliasSuggestions,
    handleLinkAlias,
    handleDismissAlias,
    handleUndoAliasLink,
  };
}
