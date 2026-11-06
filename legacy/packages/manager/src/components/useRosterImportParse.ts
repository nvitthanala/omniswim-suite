/**
 * The paste/CSV half of `RosterImportWizard`: parse the pasted text into the
 * preview step, and load a CSV file into the paste box.
 */
import React from 'react';
import { parseSwimCloudPasteDetailed } from '@omniswim/core/lib/athleteHistory';
import { parseCsvHistory } from '@omniswim/core/lib/csvImport';
import { divisionForTeamOrNull } from '@omniswim/core/data/teamDivisions';
import { splitUnreadStampWarnings } from './athleteHistoryImportView';
import type { RosterImportDeps } from './useRosterImportState';

export function useRosterImportParse({ s, gender, toast }: RosterImportDeps) {
  const { team, mode, paste } = s;

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
      s.setPreview(result.swims);
      s.setWarnings(result.warnings);
      s.setUnreadStampSummary(null);
      s.setFormat('csv');
      s.setStep('preview');
      s.setDismissedAliasKeys(new Set());
      s.setImportMode('merge');
      s.setLastAliasLink(null);
      s.setImprovements([]);
      s.setImprovementsComputed(false);
      return;
    }
    const result = parseSwimCloudPasteDetailed(paste, {
      team: team.trim(),
      gender,
      division: divisionForTeamOrNull(team.trim()) ?? undefined,
    });
    // Pull the per-row "Unrecognized SwimCloud stamp" sentences out of the
    // flat warnings list and collapse them into one line below — a paste
    // with a dozen unreadable stamps otherwise buries every other warning.
    const { otherWarnings, unreadStampSummary: summary } = splitUnreadStampWarnings(result.warnings);
    s.setPreview(result.swims);
    s.setWarnings(otherWarnings);
    s.setUnreadStampSummary(summary);
    s.setFormat(result.format);
    s.setStep('preview');
    s.setDismissedAliasKeys(new Set());
    s.setImportMode('merge');
    s.setLastAliasLink(null);
    s.setImprovements([]);
    s.setImprovementsComputed(false);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      s.setPaste(text);
      s.setMode('csv');
    } catch (err) {
      toast.push('error', `Could not read file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      e.target.value = '';
    }
  };

  return { handleParse, handleFile };
}
