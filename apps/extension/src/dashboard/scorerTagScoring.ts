import { closeThresholdFromPercent, cutTagForSwim, foldEventCutTags, formatHundredths, requireComplete, scoreMeet } from '@omniswim/engine';
import type { CutTag, MeetSwim, ScorerTag } from '@omniswim/engine';
import type { RulePreset } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import type { SimSnapshot } from '../shared/bridgeSchema';
import { swimmerLabel, teamLabel } from '../shared/names';

export interface ScorerTagScoringState {
  readonly scored: boolean;
  readonly scoringTeamSize?: number;
  readonly warnings: readonly string[];
}

export interface PanelCutTagRow {
  readonly teamId: string;
  readonly teamName: string;
  readonly swimmerId: string;
  readonly swimmerName: string;
  readonly eventKey: string;
  readonly real: string;
  readonly estimated: string;
  readonly estimatedIsEstimate: boolean;
  readonly estimatedProvenance?: string;
}

function describeTag(tag: CutTag | undefined): string {
  if (!tag) return 'No cut tag';
  if (tag.kind === 'achieved') return `${tag.tier} achieved`;
  if (tag.kind === 'estimated-achieved') return `${tag.tier} achieved`;
  if (tag.kind === 'none') return 'No cut achieved';
  if (tag.kind === 'unknown') return `Unknown: ${tag.detail}`;
  // R11: a close tag always shows the time gap. The gap is whole hundredths, so two decimals are exact.
  if (tag.kind === 'close') return `Close to ${tag.nearest.tier}: ${(tag.nearest.gapHundredths / 100).toFixed(2)} s off ${tag.nearest.standard.text}`;
  if (tag.kind === 'converted') return 'Converted time; no cut achieved';
  return tag.kind === 'not-applicable' ? 'Not applicable: diving' : 'Unknown';
}

/** Build display-only real and converted tag rows from the engine's meet model. */
export function panelCutTags(snapshot: SimSnapshot, meetKey: string, closeThresholdPct: number): readonly PanelCutTagRow[] {
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (adapted.kind !== 'ready') return [];
  return panelCutTagsForModel(adapted.adapted.model, adapted.adapted.divisionSeasonNote, closeThresholdPct);
}

export function panelCutTagsForModel(model: import('@omniswim/engine').MeetModel, divisionSeasonNote: string | undefined, closeThresholdPct: number): readonly PanelCutTagRow[] {
  const threshold = closeThresholdFromPercent(closeThresholdPct);
  const byKey = new Map<string, { swims: MeetSwim[]; swimmerId: string; teamId: string; eventKey: string }>();
  for (const swim of model.swims) {
    const swimmer = model.swimmers.find((s) => s.swimmerId === swim.swimmerId);
    if (!swimmer) continue;
    const key = `${swim.swimmerId}\u0000${swim.eventKey}`;
    const group = byKey.get(key) ?? { swims: [], swimmerId: swim.swimmerId, teamId: swimmer.teamId, eventKey: swim.eventKey };
    group.swims.push(swim); byKey.set(key, group);
  }
  return [...byKey.values()].map((group) => {
    const swimmer = model.swimmers.find((s) => s.swimmerId === group.swimmerId)!;
    const team = model.teams.find((t) => t.teamId === group.teamId)!;
    const tagged = group.swims.map((swim) => ({ swim, tag: cutTagForSwim(swim, swimmer, team, threshold) }));
    const realFolded = foldEventCutTags(tagged.filter(({ swim }) => swim.recordedCourse === 'SCY' && swim.scy.kind === 'recorded-scy').map(({ tag }) => tag));
    const estimateInputs = tagged.filter(({ swim }) => swim.recordedCourse === 'LCM');
    const estimateFolded = foldEventCutTags(estimateInputs.map(({ tag }) => tag));
    const real = realFolded[0];
    const estimated = estimateFolded.find((tag) => tag.kind === 'estimated-achieved');
    const converted = estimateFolded.find((tag) => tag.kind === 'converted');
    const estimateUnknown = estimateFolded.find((tag) => tag.kind === 'unknown');
    const displayName = swimmerLabel(group.swimmerId, model.display?.swimmers[group.swimmerId]?.name);
    const teamName = teamLabel(group.teamId, model.display?.teams[group.teamId]?.name);
    const estimateText = estimated?.kind === 'estimated-achieved' ? `${formatHundredths(estimated.convertedHundredths)} · ${describeTag(estimated)}`
      : converted ? 'No cut achieved (converted LCM time)' : estimateUnknown?.kind === 'unknown' ? `Unknown: ${estimateUnknown.detail}` : 'No converted LCM swim';
    const provenance = estimated?.kind === 'estimated-achieved' && estimated.basis.method === 'lcm_scy_tool_derived'
      ? `Tool-derived: ${estimated.basis.provenance.kind === 'tool-derived' ? estimated.basis.provenance.tool.name : 'source unavailable'}` : undefined;
    const realText = divisionSeasonNote && real?.kind === 'unknown' && real.reason === 'division_unknown'
      ? `Unknown: ${divisionSeasonNote}` : real ? describeTag(real) : 'No recorded SCY swim';
    return { teamId: group.teamId, teamName, swimmerId: group.swimmerId, swimmerName: displayName, eventKey: group.eventKey,
      real: realText, estimated: estimateText, estimatedIsEstimate: estimated?.kind === 'estimated-achieved', ...(provenance ? { estimatedProvenance: provenance } : {}) };
  });
}

/** Runs the normal engine scoring path with saved coach tags and formats its roster warnings. */
export function scoreScorerTags(snapshot: SimSnapshot, meetKey: string, hasOwnTeam: boolean, tags: readonly ScorerTag[], preset?: RulePreset): ScorerTagScoringState {
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey, snapshotId: 'live-snapshot' });
  if (adapted.kind !== 'ready') return { scored: false, warnings: [] };
  if (!preset) return { scored: false, warnings: [] };
  const sizeSetting = preset.scorers.scoringTeamSize;
  const scoringTeamSize = sizeSetting.state === 'set' && typeof sizeSetting.value === 'number' ? sizeSetting.value : undefined;
  if (!hasOwnTeam) return { scored: false, ...(scoringTeamSize === undefined ? {} : { scoringTeamSize }), warnings: [] };
  try {
    const results = scoreMeet(adapted.adapted.model, adapted.adapted.lineup, tags, requireComplete(preset), { includeConvertedSwims: false, lcmToScy: null });
    const warnings: string[] = [];
    for (const violation of results.violations) {
      if (violation.kind === 'scoring_team_size') warnings.push(`${violation.teamId} ${violation.gender}: ${violation.spots.numerator}/${violation.spots.denominator} scorer spots exceeds ${violation.limit}`);
      if (violation.kind === 'scorer_without_entry') warnings.push(`${violation.swimmerId} is tagged scorer but has no entry`);
      if (violation.kind === 'relay_leg' && violation.reason === 'off_scoring_roster') warnings.push(`Relay ${violation.entryKey}, leg ${violation.leg} is outside the scoring roster`);
    }
    return { scored: true, ...(scoringTeamSize === undefined ? {} : { scoringTeamSize }), warnings };
  } catch (cause) {
    return { scored: false, ...(scoringTeamSize === undefined ? {} : { scoringTeamSize }), warnings: [cause instanceof Error ? cause.message : String(cause)] };
  }
}
