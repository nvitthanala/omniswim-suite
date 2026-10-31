/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Timing bench for `suggestScoringRosters` (plans/2026-10-25/D2-ENGINE-API.md, 3.14) with the Node HiGHS solver.
 *
 * Run: `npx tsx scripts/bench/rosterSuggestTiming.ts [--runs N] [--synthetic-teams N] [--config A|B|C|D]`
 *
 * Input is only recorded SwimCloud simulator data: `tests/fixtures/swimcloud/simulator/config-C.json` (default; the
 * largest: three teams, 152 entries, two teams with more than 18 entered swimmers, so the ILP runs) with its three
 * team files, built through the test helper `buildSnapshot` and the real adapter `adaptSimulatorSnapshot`. No swim,
 * time, or rule value is written here. The rules are the shipped `nsisc` v4 preset.
 *
 * Two modes, reported separately:
 *   - "real fixture": the three recorded teams as they are.
 *   - "synthetic scale from config-C": every recorded team is copied under new team, swimmer, swim and split ids until
 *     the meet has N teams (default 10). The copies carry the recorded times unchanged. They only scale the team count.
 *
 * For each target (opponent team, gender) the bench calls `suggestScoringRosters` once and records every LP the call
 * solves: wall time of `highs.solve`, LP rows and columns, and the HiGHS status. It then calls the function once for
 * all targets, which is what the page panel does.
 */
import loadHighs from 'highs';
import { builtinRulePreset, requireComplete, suggestScoringRosters } from '@omniswim/engine';
import type { Gender, Lineup, LpSolve, MeetModel, ScorerTag } from '@omniswim/engine';
import { adaptSimulatorSnapshot } from '@omniswim/swimcloud/browser';
import { buildSnapshot } from '../../tests/helpers/simulatorFixtures';
import { scaleTeams } from './lib/scaleTeams';

interface Target { readonly teamId: string; readonly gender: Gender }
interface SolveStat { readonly ms: number; readonly rows: number; readonly cols: number; readonly status: string }
interface TargetStat { readonly label: string; readonly callMs: number; readonly solves: readonly SolveStat[]; readonly outcome: string }

const argValue = (flag: string, fallback: number): number => {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} needs a positive integer`);
  return n;
};
const RUNS = argValue('--runs', 3);
const SYNTH_TEAMS = argValue('--synthetic-teams', 10);
const CONFIG = (process.argv.includes('--config') ? process.argv[process.argv.indexOf('--config') + 1] : 'C') as 'A' | 'B' | 'C' | 'D';
if (!['A', 'B', 'C', 'D'].includes(CONFIG)) throw new Error('--config must be A, B, C or D');

const highs = await loadHighs({});
let sink: SolveStat[] = [];
/** The extension worker's mapping (apps/extension/src/worker/optimizer.ts), plus a per-solve record. */
const solve: LpSolve = (lp, options) => {
  const start = performance.now();
  const r = highs.solve(lp, options as Parameters<typeof highs.solve>[1]);
  const ms = performance.now() - start;
  sink.push({ ms, rows: r.Rows.length, cols: Object.keys(r.Columns).length, status: r.Status });
  const columns: Record<string, number> = {};
  if (r.Status === 'Optimal') for (const [name, col] of Object.entries(r.Columns)) columns[name] = col.Primal as number;
  return Promise.resolve({ status: r.Status, objective: r.ObjectiveValue, columns });
};

interface Scenario {
  readonly title: string;
  readonly model: MeetModel;
  readonly lineup: Lineup;
  readonly ownTeamId: string;
  readonly teamNames: ReadonlyMap<string, string>;
}

function load(): { real: Scenario; synth: Scenario } {
  const { snapshot } = buildSnapshot(CONFIG);
  const adapted = adaptSimulatorSnapshot(snapshot, { meetKey: `bench-config-${CONFIG}`, snapshotId: 'bench' });
  if (adapted.kind !== 'ready') throw new Error(`config-${CONFIG} did not adapt: ${adapted.kind}`);
  const { model, lineup } = adapted.adapted;
  const ownTeamId = String(model.teams.find((t) => String(t.teamId) === '58')?.teamId ?? model.teams[0]!.teamId);
  const baseNames = new Map(model.teams.map((t) => [String(t.teamId), model.display?.teams[t.teamId]?.name ?? String(t.teamId)]));
  const real: Scenario = { title: `real fixture: simulator config-${CONFIG} (Henderson State, Delta State, Ouachita Baptist; Men)`, model, lineup, ownTeamId, teamNames: baseNames };
  const s = scaleTeams(model, lineup, SYNTH_TEAMS);
  const synth: Scenario = { title: `synthetic scale from config-${CONFIG}: ${SYNTH_TEAMS} teams (recorded teams copied under new ids)`, model: s.model, lineup: s.lineup, ownTeamId, teamNames: s.names };
  return { real, synth };
}

const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const f = (n: number): string => n.toFixed(1).padStart(8);

async function runScenario(sc: Scenario, run: number): Promise<void> {
  const rules = requireComplete(builtinRulePreset('nsisc', 4)!);
  const sourcing = { includeConvertedSwims: false, lcmToScy: null } as const;
  // Every side that is not a target needs a scoring roster, or the preflight cannot score the meet. The coach's own
  // swimmers are scorers (the extension's rule). For a single-target call the other opponents are tagged as scorers
  // too, which counts every one of their entered swimmers: the same reference field the all-target call uses.
  const tagsFor = (t: readonly Target[]): ScorerTag[] => {
    const free = new Set(t.map((x) => x.teamId + '|' + x.gender));
    return sc.model.swimmers.filter((s) => !free.has(String(s.teamId) + '|' + s.gender))
      .map((s) => ({ teamId: s.teamId, swimmerId: s.swimmerId, role: 'scorer' as const }));
  };
  const seen = new Map<string, Target>();
  for (const e of sc.lineup.entries) if (String(e.teamId) !== sc.ownTeamId) seen.set(`${e.teamId}|${e.gender}`, { teamId: String(e.teamId), gender: e.gender });
  const targets = [...seen.values()].sort((a, b) => a.teamId.localeCompare(b.teamId) || a.gender.localeCompare(b.gender));
  const req = (t: readonly Target[]) => ({ model: sc.model, lineup: sc.lineup, rules, sourcing, coachTags: tagsFor(t), ownTeamId: sc.ownTeamId as never, targets: t as never });

  const stats: TargetStat[] = [];
  for (const t of targets) {
    sink = [];
    const start = performance.now();
    const out = await suggestScoringRosters(req([t]), solve);
    const callMs = performance.now() - start;
    const r = out[0]!;
    stats.push({ label: `${t.teamId} ${t.gender} ${sc.teamNames.get(t.teamId) ?? ''}`.trim(), callMs, solves: sink,
      outcome: r.kind === 'suggested' ? `suggested/${r.method}` : `absent/${r.reason}` });
  }
  sink = [];
  const bStart = performance.now();
  await suggestScoringRosters(req(targets), solve);
  const batchMs = performance.now() - bStart;
  const batchSolves = sink;

  const swimmersByTeam = new Map<string, number>();
  for (const s of sc.model.swimmers) swimmersByTeam.set(String(s.teamId), (swimmersByTeam.get(String(s.teamId)) ?? 0) + 1);
  console.log(`\n=== run ${run}/${RUNS}: ${sc.title}`);
  console.log(`teams ${sc.model.teams.length}, swimmers ${sc.model.swimmers.length}, swims ${sc.model.swims.length}, lineup entries ${sc.lineup.entries.length}, own team ${sc.ownTeamId}, targets ${targets.length}`);
  console.log('target                                          call ms  solves  solve ms    rows    cols  status / outcome');
  const lpMs: number[] = [];
  for (const s of stats) {
    const solveMs = s.solves.reduce((a, x) => a + x.ms, 0);
    for (const x of s.solves) lpMs.push(x.ms);
    const rows = Math.max(0, ...s.solves.map((x) => x.rows));
    const cols = Math.max(0, ...s.solves.map((x) => x.cols));
    const status = [...new Set(s.solves.map((x) => x.status))].join(',') || 'no LP';
    console.log(`${s.label.slice(0, 44).padEnd(44)} ${f(s.callMs)} ${String(s.solves.length).padStart(7)} ${f(solveMs)} ${String(rows).padStart(7)} ${String(cols).padStart(7)}  ${status} / ${s.outcome}`);
  }
  const call = stats.map((s) => s.callMs);
  console.log(`per-target call ms: total ${f(call.reduce((a, b) => a + b, 0))}  median ${f(median(call))}  max ${f(Math.max(...call))}`);
  console.log(`per-LP solve ms (${lpMs.length} LPs): median ${f(median(lpMs))}  max ${f(Math.max(...lpMs))}`);
  console.log(`one call for all ${targets.length} targets (the page panel path): ${f(batchMs)} ms, ${batchSolves.length} LPs, LP solve ms ${f(batchSolves.reduce((a, x) => a + x.ms, 0))}`);
  console.log(`  slowest target call over 1000 ms: ${Math.max(...call) > 1000 ? 'YES' : 'no'}; batch over 1000 ms: ${batchMs > 1000 ? 'YES' : 'no'}`);
}

const { real, synth } = load();
for (let run = 1; run <= RUNS; run++) await runScenario(real, run);
for (let run = 1; run <= RUNS; run++) await runScenario(synth, run);
