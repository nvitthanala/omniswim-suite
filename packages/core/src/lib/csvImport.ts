/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * CSV → HistoricalSwim parser for the Manager roster/history importer.
 * Accepts a header row and maps common column aliases. No external deps.
 */
import { Gender, type HistoricalSwim } from '../types';

export type CsvImportResult = {
  swims: HistoricalSwim[];
  warnings: string[];
  rowCount: number;
};

const HEADER_ALIASES: Record<string, keyof HistoricalSwim> = {
  name: 'name',
  swimmer: 'name',
  athlete: 'name',
  team: 'team',
  school: 'team',
  event: 'event',
  events: 'event',
  time: 'time',
  best: 'time',
  besttime: 'time',
  seed: 'time',
  date: 'date',
  meet: 'meetLabel',
  meetlabel: 'meetLabel',
  class: 'classYear',
  classyear: 'classYear',
  year: 'classYear',
  course: 'timeType',
  timetype: 'timeType',
  gender: 'gender',
  sex: 'gender',
};

/** Split a single CSV line honoring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',' || ch === '\t') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z]/g, '');
}

function coerceGender(value: string | undefined, fallback: Gender): Gender {
  if (!value) return fallback;
  const v = value.trim().toLowerCase();
  if (v.startsWith('w') || v.startsWith('f')) return Gender.WOMEN;
  if (v.startsWith('m')) return Gender.MEN;
  return fallback;
}

function coerceTimeType(value: string | undefined): HistoricalSwim['timeType'] | undefined {
  if (!value) return undefined;
  const v = value.trim().toUpperCase();
  if (v === 'SCY' || v === 'LCM' || v === 'SCM') return v;
  if (v.includes('YARD') || v === 'Y') return 'SCY';
  if (v.includes('LONG') || v === 'L') return 'LCM';
  return undefined;
}

export function parseCsvHistory(
  csv: string,
  opts: { team?: string; gender?: Gender }
): CsvImportResult {
  const warnings: string[] = [];
  const lines = csv
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) {
    return { swims: [], warnings: ['Empty CSV'], rowCount: 0 };
  }

  const headerCells = splitCsvLine(lines[0]).map(normalizeHeader);
  const hasHeader = headerCells.some(h => h in HEADER_ALIASES);
  if (!hasHeader) {
    warnings.push('No recognizable header row found; expected columns like name, event, time.');
    return { swims: [], warnings, rowCount: lines.length };
  }

  const colMap: Partial<Record<keyof HistoricalSwim, number>> = {};
  headerCells.forEach((h, i) => {
    const field = HEADER_ALIASES[h];
    if (field && colMap[field] === undefined) colMap[field] = i;
  });

  for (const required of ['name', 'event', 'time'] as const) {
    if (colMap[required] === undefined) {
      warnings.push(`Missing required column: ${required}`);
    }
  }
  if (colMap.name === undefined || colMap.event === undefined || colMap.time === undefined) {
    return { swims: [], warnings, rowCount: lines.length - 1 };
  }

  const fallbackGender = opts.gender ?? Gender.MEN;
  const swims: HistoricalSwim[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const get = (field: keyof HistoricalSwim) => {
      const idx = colMap[field];
      return idx !== undefined ? cells[idx]?.trim() ?? '' : '';
    };
    const name = get('name');
    const event = get('event');
    const time = get('time');
    if (!name || !event || !time) {
      skipped++;
      continue;
    }
    swims.push({
      name,
      event,
      time,
      team: get('team') || opts.team || 'Unknown',
      gender: coerceGender(get('gender'), fallbackGender),
      timeType: coerceTimeType(get('timeType')),
      date: get('date') || undefined,
      meetLabel: get('meetLabel') || undefined,
      classYear: get('classYear') || undefined,
      source: 'csv',
    });
  }

  if (skipped > 0) warnings.push(`Skipped ${skipped} row(s) missing name/event/time.`);
  return { swims, warnings, rowCount: lines.length - 1 };
}
