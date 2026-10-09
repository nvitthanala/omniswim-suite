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
      if (code !== 0) {
        // stdout rides along: the CLIs print their tagged error JSON there.
        reject(
          Object.assign(new Error(`Python exit ${code}: ${errorOutput || output.slice(0, 500)}`), { stdout: output })
        );
      }
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

/** Failures the Python pipeline tags with a `code`. Both are final: the route must not retry the legacy pipeline. */
export type MeetPipelineErrorCode = 'rankings_extraction_failed' | 'scoring_settings_missing';

const MEET_PIPELINE_ERROR_CODES: readonly string[] = ['rankings_extraction_failed', 'scoring_settings_missing'];

/**
 * A Python-side failure that retrying cannot fix and that must reach the user
 * with its own text. `rankings_extraction_failed`: the meet's Team Rankings page
 * was found but not read, so there is no event cutoff. `scoring_settings_missing`:
 * no scoring settings exist, and there is no default table.
 */
export class MeetPipelineError extends Error {
  readonly code: MeetPipelineErrorCode;
  constructor(code: MeetPipelineErrorCode, message: string) {
    super(message);
    this.name = 'MeetPipelineError';
    this.code = code;
  }
}

/**
 * Read a tagged failure from either a parsed error object or a `runPythonScript`
 * rejection (which carries the process stdout, where the Python CLIs print their
 * error JSON). Returns null for an untagged failure.
 */
export function structuredPipelineError(source: unknown): MeetPipelineError | null {
  let payload: unknown = source;
  if (source instanceof Error) {
    const stdout = (source as { stdout?: unknown }).stdout;
    if (typeof stdout !== 'string') return null;
    try {
      payload = JSON.parse(stdout.trim());
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== 'object') return null;
  const { code, error } = payload as { code?: unknown; error?: unknown };
  if (typeof code !== 'string' || !MEET_PIPELINE_ERROR_CODES.includes(code)) return null;
  return new MeetPipelineError(code as MeetPipelineErrorCode, typeof error === 'string' && error ? error : code);
}

/**
 * Thrown when the Python pipeline hands back rows that cannot be mapped to a
 * `SwimmerResult` without inventing a value. Each entry names the row (by its
 * zero-based position in the payload, plus name and event when readable) and
 * what is wrong with it. Nothing is defaulted: the whole parse fails so a
 * coach never sees a plausible-looking row that was filled in.
 */
export class ParsedRowError extends Error {
  readonly problems: readonly string[];
  readonly totalProblems: number;
  constructor(kind: 'meet' | 'psych', problems: string[]) {
    const shown = problems.slice(0, 10);
    const more = problems.length > shown.length ? ` (+${problems.length - shown.length} more)` : '';
    super(`Parsed ${kind} PDF has ${problems.length} unusable row(s)${more}: ${shown.join('; ')}`);
    this.name = 'ParsedRowError';
    this.problems = shown;
    this.totalProblems = problems.length;
  }
}

function rowLabel(index: number, a: Record<string, unknown>): string {
  const name = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : '?';
  const event = typeof a.event === 'string' && a.event.trim() ? a.event.trim() : '?';
  return `row ${index} (${name}, ${event})`;
}

function requiredText(a: Record<string, unknown>, key: string): string | null {
  const v = a[key];
  return typeof v === 'string' && v.trim() ? v : null;
}

/**
 * The place. An absent rank (`null`, `undefined`, `''`) is a real state: the
 * parser reports no place for exhibition swims, timed finals and rows printed
 * without one, and `0` is the app-wide "unplaced" sentinel for it. A rank that
 * is present but not a positive integer (`"DQ"`, `"abc"`, `"0"`, `"-3"`) is a
 * parse defect and fails instead of collapsing to that sentinel.
 */
export function parseRank(raw: unknown): { ok: true; rank: number } | { ok: false; reason: string } {
  if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return { ok: true, rank: 0 };
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw > 0) return { ok: true, rank: raw };
  } else if (typeof raw === 'string') {
    const m = raw.trim().match(/^\*?(\d+)$/);
    const n = m ? parseInt(m[1], 10) : 0;
    if (n > 0) return { ok: true, rank: n };
  }
  return { ok: false, reason: `rank ${JSON.stringify(raw)} is not a positive integer` };
}

/**
 * TypeScript twin of `parse_pdf_points` in `backend/point_calculator.py`.
 * Accepts `null`/`undefined`/`''` (no printed value, returns `undefined`) and a
 * finite non-negative number. Everything else (booleans, any string including
 * numeric and whitespace-wrapped ones, NaN, negatives) is malformed.
 */
export function parsePdfPointsValue(
  raw: unknown
): { ok: true; value: number | undefined } | { ok: false; reason: string } {
  if (raw == null || raw === '') return { ok: true, value: undefined };
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return { ok: true, value: raw };
  return { ok: false, reason: `pdf_points ${JSON.stringify(raw)} is not a finite non-negative number` };
}

function parseGender(raw: unknown): Gender | null {
  if (raw === 'Women') return Gender.WOMEN;
  if (raw === 'Men') return Gender.MEN;
  return null;
}

export function mapAthleteRows(athletes: Record<string, unknown>[]): SwimmerResult[] {
  const problems: string[] = [];
  const mapped = athletes.map((a: Record<string, unknown>, index: number) => {
    const bad = (reason: string) => problems.push(`${rowLabel(index, a)}: ${reason}`);
    const name = requiredText(a, 'name');
    const team = requiredText(a, 'team');
    const event = requiredText(a, 'event');
    if (name == null) bad('missing name');
    if (team == null) bad('missing team');
    if (event == null) bad('missing event');
    const rank = parseRank(a.rank);
    if (!rank.ok) bad(rank.reason);
    const gender = parseGender(a.gender);
    if (gender == null) bad(`gender ${JSON.stringify(a.gender)} is missing or not Men/Women`);
    const cp = a.calculated_points;
    let points: number | string = 0;
    if (cp === 'N/A') points = 'N/A';
    else if (typeof cp === 'number' && Number.isFinite(cp)) points = cp;
    else bad(`calculated_points ${JSON.stringify(cp)} is not a finite number or "N/A"`);
    const pdfPoints = parsePdfPointsValue(a.pdf_points);
    if (!pdfPoints.ok) bad(pdfPoints.reason);

    const teamClock = (a.relay_team_time || a.finals_time || a.prelims_time) as string;
    const isRelay = Boolean(a.is_relay) || /\brelay\b/i.test(String(a.event || ''));
    return normalizeSwimmerResultRelayFields({
      id: uuidv4(),
      rank: rank.ok ? rank.rank : 0,
      name: name ?? '',
      classYear: (a.year as string) || 'UNKNOWN',
      team: team ?? '',
      time: teamClock || 'NT',
      prelimsTime: a.prelims_time as string,
      finalsTime: a.finals_time as string,
      roundSwam: a.round_swam as string,
      points,
      event: event ?? '',
      gender: gender ?? undefined,
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
      pdfPoints: pdfPoints.ok ? pdfPoints.value : undefined,
    });
  });
  if (problems.length > 0) throw new ParsedRowError('meet', problems);
  return mapped;
}

export function mapPsychRows(rows: Record<string, unknown>[]): SwimmerResult[] {
  const problems: string[] = [];
  const mapped = rows.map((a: Record<string, unknown>, index: number) => {
    const bad = (reason: string) => problems.push(`${rowLabel(index, a)}: ${reason}`);
    const name = requiredText(a, 'name');
    const team = requiredText(a, 'team');
    const event = requiredText(a, 'event');
    if (name == null) bad('missing name');
    if (team == null) bad('missing team');
    if (event == null) bad('missing event');
    const rank = parseRank(a.rank);
    if (!rank.ok) bad(rank.reason);
    const gender = parseGender(a.gender);
    if (gender == null) bad(`gender ${JSON.stringify(a.gender)} is missing or not Men/Women`);
    const seedTime = String(a.time ?? a.finals_time ?? a.prelims_time ?? 'NT');
    const rawTeam = team ?? '';
    const expandedTeam = expandTeamAbbrev(rawTeam) ?? rawTeam;
    return {
      id: uuidv4(),
      rank: rank.ok ? rank.rank : 0,
      name: name ?? '',
      classYear: (a.year as string) || 'UNKNOWN',
      team: expandedTeam,
      time: seedTime,
      points: 0,
      event: event ?? '',
      gender: gender ?? undefined,
      isRelay: false,
      isExhibition: Boolean(a.is_exhibition),
      isTimeTrial: Boolean(a.is_time_trial),
      roundSwam: 'Psych Sheet',
      isPsychSheet: true,
    };
  });
  if (problems.length > 0) throw new ParsedRowError('psych', problems);
  return mapped;
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
  let output: string;
  try {
    output = await runPythonScript(deps, deps.parseMeetScript, [tempFile, format]);
  } catch (err) {
    throw structuredPipelineError(err) ?? err;
  }
  const parsed = JSON.parse(output.trim());
  if (parsed.error) throw structuredPipelineError(parsed) ?? new Error(parsed.error);
  const athletes = Array.isArray(parsed.athletes) ? parsed.athletes : [];
  return {
    results: mapAthleteRows(athletes),
    conference: typeof parsed.conference === 'string' ? parsed.conference : undefined,
    officialTeamScores: parsed.officialTeamScores ?? undefined,
  };
}

type LegacyRankings = { eventThrough: number | null; men: Record<string, number>; women: Record<string, number> };

/**
 * The legacy pipeline's rankings step. Rankings are optional only when the PDF
 * has no "Team Rankings - Through Event N" page (`markerFound === false`). If
 * the page exists, or the PDF could not be inspected, a failed read throws:
 * scoring without the meet's event cutoff would count its post-program events.
 */
async function legacyTeamRankings(
  deps: ParsingPipelineDeps,
  tempFile: string
): Promise<LegacyRankings | undefined> {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse((await runPythonScript(deps, deps.teamRankingsScript, [tempFile])).trim());
  } catch (err) {
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    let fromStdout: Record<string, unknown> | null = null;
    try {
      fromStdout = typeof stdout === 'string' ? JSON.parse(stdout.trim()) : null;
    } catch {
      fromStdout = null;
    }
    json = fromStdout ?? { error: String(err), markerFound: null };
  }
  const markerFound = json.markerFound;
  const fail = (why: string) =>
    new MeetPipelineError(
      'rankings_extraction_failed',
      `Team Rankings page was detected or could not be ruled out, but it was not read (${why}). Refusing to score without the meet's event cutoff.`
    );
  if (json.error) {
    if (markerFound === false) return undefined;
    throw fail(String(json.error));
  }
  const men = (json.men ?? {}) as Record<string, number>;
  const women = (json.women ?? {}) as Record<string, number>;
  const eventThrough = typeof json.eventThrough === 'number' ? json.eventThrough : null;
  if (Object.keys(men).length === 0 && Object.keys(women).length === 0) {
    if (eventThrough != null || markerFound !== false) throw fail('no usable team score block');
    return undefined;
  }
  return { eventThrough, men, women };
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
  // Rankings first: they carry the event cutoff scoring needs, and a rankings
  // page that cannot be read must stop the parse (see legacyTeamRankings).
  const rankings = await legacyTeamRankings(deps, tempFile);
  const calcArgs = rankings?.eventThrough != null ? [String(rankings.eventThrough)] : [];
  const calcOutput = await runPythonScript(deps, deps.pointCalculatorScript, calcArgs, parserOutput);
  const athletes = JSON.parse(calcOutput);
  if (!Array.isArray(athletes)) {
    const failure = athletes as { error?: unknown } | null;
    if (failure && typeof failure === 'object' && failure.error) {
      throw structuredPipelineError(failure) ?? new Error(String(failure.error));
    }
    throw new Error('Points calculation failed');
  }
  const conference =
    athletes.length > 0 && typeof athletes[0].conference === 'string'
      ? athletes[0].conference
      : undefined;
  const officialTeamScores = rankings
    ? { eventThrough: rankings.eventThrough ?? undefined, men: rankings.men, women: rankings.women }
    : undefined;
  return { results: mapAthleteRows(athletes), conference, officialTeamScores };
}
