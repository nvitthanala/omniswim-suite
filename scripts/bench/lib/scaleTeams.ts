/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Scale a recorded meet to more teams for the benches: every recorded team is copied under new team, swimmer, swim and split
 * ids. The copies carry the recorded times unchanged, so they scale the team count and add no value of their own. Moved here
 * from `rosterSuggestTiming.ts` so `autoBuildTiming.ts` reuses the same function.
 */
import type { Lineup, LineupEntry, MeetModel } from '@omniswim/engine';

const mapEntry = (e: LineupEntry, sfx: string): LineupEntry => {
  if (e.kind === 'individual') {
    return { ...e, teamId: (e.teamId + sfx) as typeof e.teamId, swimmerId: (e.swimmerId + sfx) as typeof e.swimmerId, seedSwimId: e.seedSwimId === null ? null : e.seedSwimId + sfx };
  }
  const legs = e.legs.map((l) => ({
    swimmerId: (l.swimmerId + sfx) as typeof l.swimmerId,
    basis: l.basis.kind === 'split' ? { kind: 'split' as const, splitId: l.basis.splitId + sfx }
      : l.basis.kind === 'flat-start-swim' || l.basis.kind === 'flyover-estimate' ? { kind: l.basis.kind, swimId: l.basis.swimId + sfx } : l.basis,
  })) as unknown as typeof e.legs;
  return { ...e, teamId: (e.teamId + sfx) as typeof e.teamId, legs };
};

/** Copy every recorded team under new ids (suffix `~k`) until the meet has `total` teams. Times are copied unchanged. */
export function scaleTeams(model: MeetModel, lineup: Lineup, total: number): { model: MeetModel; lineup: Lineup; names: Map<string, string> } {
  const names = new Map<string, string>(model.teams.map((t) => [t.teamId as string, model.display?.teams[t.teamId]?.name ?? t.teamId]));
  const copies = Math.ceil(total / model.teams.length) - 1;
  const teams = [...model.teams];
  const swimmers = [...model.swimmers];
  const swims = [...model.swims];
  const relaySplits = [...model.relaySplits];
  const entries = [...lineup.entries];
  for (let k = 1; k <= copies; k++) {
    const sfx = `~${k}`;
    for (const t of model.teams) {
      if (teams.length >= total) break;
      const teamId = (t.teamId + sfx) as typeof t.teamId;
      names.set(teamId, `${names.get(t.teamId)} (copy ${k})`);
      teams.push({ ...t, teamId });
      const mine = model.swimmers.filter((s) => s.teamId === t.teamId);
      const ids = new Set(mine.map((s) => s.swimmerId));
      for (const s of mine) swimmers.push({ ...s, swimmerId: (s.swimmerId + sfx) as typeof s.swimmerId, teamId });
      for (const w of model.swims) if (ids.has(w.swimmerId)) swims.push({ ...w, swimId: w.swimId + sfx, swimmerId: (w.swimmerId + sfx) as typeof w.swimmerId });
      for (const p of model.relaySplits) if (ids.has(p.swimmerId)) relaySplits.push({ ...p, splitId: p.splitId + sfx, swimmerId: (p.swimmerId + sfx) as typeof p.swimmerId });
      for (const e of lineup.entries) if (e.teamId === t.teamId) entries.push(mapEntry(e, sfx));
    }
  }
  return { model: { ...model, teams, swimmers, swims, relaySplits, display: undefined }, lineup: { ...lineup, entries, display: undefined }, names };
}
