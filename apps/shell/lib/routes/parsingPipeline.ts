/**
 * The Python subprocess pipelines behind the PDF/psych-sheet parsing routes:
 * spawning `runPythonScript`, the unified and legacy meet-PDF pipelines, and
 * the psych-sheet auto-format pipeline. Kept in a sibling file to
 * `parsingRoutes.ts` purely to keep each function under the repo's
 * line-count ceiling (H2, code-health refactor, 2026-09-25) — no behavior
 * change from the code that used to live inline in `server.ts`'s
 * `startServer`. Each function takes its script paths as plain arguments
 * (not a closure over a shared factory) so no single function's line count
 * grows with the number of pipelines defined here.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import { Gender, SwimmerResult } from '../../../../packages/core/src/types.ts';
import { normalizeSwimmerResultRelayFields } from '../../../../packages/core/src/lib/relaySplits.ts';
import { expandTeamAbbrev } from '../../../../packages/core/src/data/teamAliases.ts';
import {
  normalizePsychAthleteRows,
  psychParseFormatsToTry,
  pickBestPsychParseCandidate,
  scorePsychParseQuality,
  type PsychAthleteRow,
} from '../../../../packages/core/src/lib/psychParseQuality.ts';

export interface ParsingPipelineDeps {
  projectRoot: string;
  dataDir: string;
  pdfParserScript: string;
  parseMeetScript: string;
  pointCalculatorScript: string;
  teamRankingsScript: string;
}

export async function runPythonScript(
  { projectRoot: PROJECT_ROOT, dataDir: DATA_DIR }: Pick<ParsingPipelineDeps, 'projectRoot' | 'dataDir'>,
  scriptPath: string,
  args: string[],
  stdin?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const venvPython =
      process.platform === 'win32'
        ? path.join(PROJECT_ROOT, 'venv', 'Scripts', 'python.exe')
        : path.join(PROJECT_ROOT, 'venv', 'bin', 'python');
    const pythonCmd = fs.existsSync(venvPython) ? venvPython : process.platform === 'win32' ? 'python' : 'python3';

    const proc = spawn(pythonCmd, [scriptPath, ...args], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        OMNI_PROJECT_ROOT: PROJECT_ROOT,
        OMNI_DATA_DIR: DATA_DIR,
        PYTHONPATH: [
          path.join(PROJECT_ROOT, 'backend'),
          process.env.PYTHONPATH,
        ]
          .filter(Boolean)
          .join(path.delimiter),
      },
    });

    let output = '';
    let errorOutput = '';
    let resolved = false;

    proc.stdout.on('data', d => {
      output += d.toString();
    });
    proc.stderr.on('data', d => {
      errorOutput += d.toString();
    });
    proc.on('error', err => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    proc.on('close', code => {
      if (resolved) return;
      resolved = true;
      if (code !== 0) reject(new Error(`Python exit ${code}: ${errorOutput || output.slice(0, 500)}`));
      else if (!output.trim() && errorOutput.trim()) {
        reject(new Error(errorOutput.trim().slice(0, 500)));
      } else if (!output.trim()) {
        reject(new Error('Python script returned empty output'));
      } else resolve(output);
    });

    if (stdin) {
      proc.stdin.write(stdin, 'utf-8', () => proc.stdin.end());
    }
  });
}

export function mapAthleteRows(athletes: Record<string, unknown>[]): SwimmerResult[] {
  return athletes.map((a: Record<string, unknown>) => {
      const rankMatch = a.rank != null ? String(a.rank).match(/(\d+)/) : null;
      const parsedRank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
      const teamClock = (a.relay_team_time || a.finals_time || a.prelims_time) as string;
      const isRelay = Boolean(a.is_relay) || /\brelay\b/i.test(String(a.event || ''));
      return normalizeSwimmerResultRelayFields({
        id: uuidv4(),
        rank: parsedRank > 0 ? parsedRank : 0,
        name: String(a.name),
        classYear: (a.year as string) || 'UNKNOWN',
        team: String(a.team),
        time: teamClock || 'NT',
        prelimsTime: a.prelims_time as string,
        finalsTime: a.finals_time as string,
        roundSwam: a.round_swam as string,
        points: a.calculated_points === 'N/A' ? 'N/A' : Number(a.calculated_points) || 0,
        event: String(a.event),
        gender: a.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
        isRelay,
        isExhibition: a.is_exhibition as boolean,
        isTimeTrial: a.is_time_trial as boolean,
        relayNames: (a.relay_names as { name: string; year: string }[]) || [],
        relayLegIndex: a.relay_leg_index as number,
        relayLegStroke: a.relay_leg_stroke as SwimmerResult['relayLegStroke'],
        relayLegSplit: a.relay_leg_split as string,
        relayLegSplitDetail: a.relay_leg_split_detail as SwimmerResult['relayLegSplitDetail'],
        relayTeamSplits: a.relay_team_splits as SwimmerResult['relayTeamSplits'],
        relayTeamTime: isRelay ? teamClock : (a.relay_team_time as string),
        pdfPoints: a.pdf_points != null ? Number(a.pdf_points) : undefined,
      });
    });
}

export function mapPsychRows(rows: Record<string, unknown>[]): SwimmerResult[] {
  return rows.map((a: Record<string, unknown>) => {
    const rankMatch = a.rank != null ? String(a.rank).match(/(\d+)/) : null;
    const parsedRank = rankMatch ? parseInt(rankMatch[1], 10) : 0;
    const seedTime = String(a.time ?? a.finals_time ?? a.prelims_time ?? 'NT');
    const rawTeam = String(a.team);
    const expandedTeam = expandTeamAbbrev(rawTeam) ?? rawTeam;
    return {
      id: uuidv4(),
      rank: parsedRank > 0 ? parsedRank : 0,
      name: String(a.name),
      classYear: (a.year as string) || 'UNKNOWN',
      team: expandedTeam,
      time: seedTime,
      points: 0,
      event: String(a.event),
      gender: a.gender === 'Women' ? Gender.WOMEN : Gender.MEN,
      isRelay: false,
      isExhibition: Boolean(a.is_exhibition),
      isTimeTrial: Boolean(a.is_time_trial),
      roundSwam: 'Psych Sheet',
      isPsychSheet: true,
    };
  });
}

async function runPdfParserRaw(
  deps: ParsingPipelineDeps,
  tempFile: string,
  format: string
): Promise<Record<string, unknown>[]> {
  const output = await runPythonScript(deps, deps.pdfParserScript, [tempFile, format]);
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error(
      'PDF parser returned no output. Check that Python/pdfplumber is installed (see server console).'
    );
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    throw new Error(`PDF parser returned invalid JSON: ${trimmed.slice(0, 200)}`);
  }
  if (!Array.isArray(parsedJson)) {
    const errObj = parsedJson as { error?: unknown };
    if (errObj?.error) throw new Error(String(errObj.error));
    throw new Error('PDF parser returned unexpected JSON shape');
  }
  return parsedJson as Record<string, unknown>[];
}

/**
 * Parse psych sheet via pdf_parser (same engine as meet PDF).
 * Auto mode tries divided → regular → auto and picks the highest-quality parse.
 */
export async function parsePsychPdfFile(
  deps: ParsingPipelineDeps,
  tempFile: string,
  format: string
): Promise<SwimmerResult[]> {
  const tried = new Set<string>();
  const candidates: { format: string; normalized: PsychAthleteRow[] }[] = [];
  let maxRawCount = 0;

  for (const attempt of psychParseFormatsToTry(format || 'auto')) {
    if (tried.has(attempt)) continue;
    tried.add(attempt);
    const raw = await runPdfParserRaw(deps, tempFile, attempt);
    maxRawCount = Math.max(maxRawCount, raw.length);
    candidates.push({ format: attempt, normalized: normalizePsychAthleteRows(raw) });
  }

  const best = pickBestPsychParseCandidate(candidates);
  if (!best || best.normalized.length === 0) {
    if (maxRawCount > 0) {
      throw new Error(
        `Parsed ${maxRawCount} PDF rows but found no individual psych seed times. Relays are skipped; try Regular or Divided format.`
      );
    }
    throw new Error('No swimmer rows found in psych PDF — try Regular vs Divided format.');
  }

  if ((format || 'auto') === 'auto' && candidates.length > 1) {
    const ranked = candidates
      .map(c => ({ format: c.format, rows: c.normalized.length, score: scorePsychParseQuality(c.normalized) }))
      .sort((a, b) => b.score - a.score);
    console.log('Psych PDF format auto-detect:', ranked, '→', best.format);
  }

  return mapPsychRows(best.normalized);
}

/** Unified pipeline: one Python process returns athletes + conference + team scores. */
export async function parseMeetUnified(deps: ParsingPipelineDeps, tempFile: string, format: string) {
  const output = await runPythonScript(deps, deps.parseMeetScript, [tempFile, format]);
  const parsed = JSON.parse(output.trim());
  if (parsed.error) throw new Error(parsed.error);
  const athletes = Array.isArray(parsed.athletes) ? parsed.athletes : [];
  return {
    results: mapAthleteRows(athletes),
    conference: typeof parsed.conference === 'string' ? parsed.conference : undefined,
    officialTeamScores: parsed.officialTeamScores ?? undefined,
  };
}

/** Legacy fallback: three separate subprocesses (kept until unified path is fully verified). */
export async function parseMeetLegacy(deps: ParsingPipelineDeps, tempFile: string, format: string) {
  const parserOutput = await runPythonScript(deps, deps.pdfParserScript, [tempFile, format]);
  try {
    const parsedJson = JSON.parse(parserOutput.trim());
    if (!Array.isArray(parsedJson) && parsedJson.error) {
      throw new Error(parsedJson.error);
    }
  } catch (err) {
    if (err instanceof Error && err.message && !err.message.startsWith('Unexpected')) throw err;
  }
  const calcOutput = await runPythonScript(deps, deps.pointCalculatorScript, [], parserOutput);
  const athletes = JSON.parse(calcOutput);
  if (!Array.isArray(athletes)) throw new Error('Points calculation failed');
  const conference =
    athletes.length > 0 && typeof athletes[0].conference === 'string'
      ? athletes[0].conference
      : undefined;
  let officialTeamScores;
  try {
    const rankingsOutput = await runPythonScript(deps, deps.teamRankingsScript, [tempFile]);
    const rankingsJson = JSON.parse(rankingsOutput.trim());
    if (!rankingsJson.error) {
      officialTeamScores = {
        eventThrough: rankingsJson.eventThrough,
        men: rankingsJson.men ?? {},
        women: rankingsJson.women ?? {},
      };
    }
  } catch {
    /* optional */
  }
  return { results: mapAthleteRows(athletes), conference, officialTeamScores };
}
