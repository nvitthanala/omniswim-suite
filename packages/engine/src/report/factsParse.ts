import { ReportParseError } from './parse';
import type { ClassYearCode, ReportFacts, SeedFact } from './facts';

type RecordValue = Record<string, unknown>;
function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) throw new ReportParseError(path, 'expected object');
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ReportParseError(path, 'expected finite number');
  return value;
}
function parseSeed(value: unknown, path: string): SeedFact {
  const source = record(value, path);
  if (source.kind === 'time') {
    if (typeof source.estimated !== 'boolean') throw new ReportParseError(`${path}.estimated`, 'expected boolean');
    return { kind: 'time', hundredths: finite(source.hundredths, `${path}.hundredths`), estimated: source.estimated };
  }
  if (source.kind === 'score') return { kind: 'score', hundredths: finite(source.hundredths, `${path}.hundredths`) };
  if (source.kind === 'none' && (source.reason === 'no_time' || source.reason === 'not_convertible')) {
    return { kind: 'none', reason: source.reason };
  }
  throw new ReportParseError(path, 'invalid seed fact');
}
function parseClassYear(value: unknown, path: string): ClassYearCode {
  if (value === null || value === 'FR' || value === 'SO' || value === 'JR' || value === 'SR' || value === 'GR') return value;
  throw new ReportParseError(path, 'invalid class year');
}

/** Validate saved source facts without coercing malformed values. */
export function parseReportFacts(json: unknown): ReportFacts {
  const source = record(json, '$');
  if (source.payloadVersion !== 1) throw new ReportParseError('$.payloadVersion', 'expected 1');
  const rawSeeds = record(source.seeds, '$.seeds');
  const seeds: Record<string, SeedFact> = {};
  for (const [key, value] of Object.entries(rawSeeds)) seeds[key] = parseSeed(value, `$.seeds.${key}`);

  const rawClassYears = record(source.classYears, '$.classYears');
  const classYears: Record<string, ClassYearCode> = {};
  for (const [key, value] of Object.entries(rawClassYears)) classYears[key] = parseClassYear(value, `$.classYears.${key}`);
  return { payloadVersion: 1, seeds, classYears };
}
