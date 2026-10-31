import type { Lineup, LineupEntry } from '../model/lineup';
import { entryKey } from '../model/lineup';
import type { Results, ResultRow } from '../model/results';
import type { SwimmerId } from '../model/primitives';
import type { ReportFacts, SeedFact } from './facts';

export type RoleLabel = string;
export type CsvIssueKind = 'name_missing' | 'result_missing' | 'seed_facts_missing';
export interface CsvIssue {
  readonly kind: CsvIssueKind;
  readonly entryKey: string;
  readonly swimmerId?: SwimmerId;
  readonly message: string;
}

type CsvCell = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'number'; readonly value: number };
type EntryRow = { readonly entry: LineupEntry; readonly swimmerId: SwimmerId; readonly leg: number | null };
type NamedResult = { readonly row: ResultRow };

const columns = [
  'Team', 'Team ID', 'Gender', 'Event', 'Entry Type', 'Relay', 'Leg', 'Full Name',
  'SwimCloud ID', 'Class', 'Seed', 'Seed (hundredths)', 'Seed Basis', 'Role', 'Place',
  'Points (swimmer share)',
] as const;

function csvRows(lineup: Lineup): EntryRow[] {
  const rows: EntryRow[] = [];
  for (const entry of lineup.entries) {
    if (entry.kind === 'individual') rows.push({ entry, swimmerId: entry.swimmerId, leg: null });
    else entry.legs.forEach((leg, index) => rows.push({ entry, swimmerId: leg.swimmerId, leg: index + 1 }));
  }
  return rows;
}

function seedText(fact: SeedFact | undefined): string {
  if (fact === undefined || fact.kind === 'none') return '';
  // Keep Seed as text for U-d's Excel round-trip check; Excel may reinterpret 1:52.34 as a clock.
  return fact.kind === 'time' ? formatTime(fact.hundredths) : formatHundredths(fact.hundredths);
}

function seedBasis(fact: SeedFact | undefined): string {
  if (fact === undefined) return '';
  if (fact.kind === 'none') return 'no time';
  if (fact.kind === 'score') return 'recorded';
  return fact.estimated ? 'estimated' : 'recorded';
}

function formatHundredths(value: number): string {
  const whole = Math.floor(value / 100);
  const hundredths = String(value % 100).padStart(2, '0');
  return `${whole}.${hundredths}`;
}

function formatTime(value: number): string {
  const totalSeconds = Math.floor(value / 100);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hundredths = String(value % 100).padStart(2, '0');
  return minutes === 0
    ? `${seconds}.${hundredths}`
    : `${minutes}:${String(seconds).padStart(2, '0')}.${hundredths}`;
}

function entryCells(
  row: EntryRow,
  lineup: Lineup,
  facts: ReportFacts,
  roles: ReadonlyMap<SwimmerId, RoleLabel>,
  results: ReadonlyMap<string, NamedResult>,
  issues: CsvIssue[],
): CsvCell[] {
  const { entry, swimmerId } = row;
  const key = entryKey(entry);
  const fact = facts.seeds[key];
  const swimmerName = lineup.display?.swimmers[swimmerId]?.name;
  const result = results.get(key);
  if (fact === undefined) issues.push({ kind: 'seed_facts_missing', entryKey: key, message: `Seed facts are missing for ${key}` });
  if (swimmerName === undefined || swimmerName.trim() === '') {
    issues.push({ kind: 'name_missing', entryKey: key, swimmerId, message: `${swimmerId}: swimmer name missing; SwimCloud display data is unavailable` });
  }
  if (result === undefined) issues.push({ kind: 'result_missing', entryKey: key, swimmerId, message: `${key}: result row is missing` });

  const cells: CsvCell[] = [
    text(lineup.display?.teams[entry.teamId]?.name ?? entry.teamId),
    text(entry.teamId),
    text(entry.gender),
    text(entry.eventKey),
    text(entry.kind),
    text(entry.kind === 'relay' ? entry.letter : ''),
    row.leg === null ? text('') : number(row.leg),
    text(swimmerName ?? ''),
    text(swimmerId),
    text(facts.classYears[swimmerId] ?? ''),
    text(seedText(fact)),
    fact === undefined || fact.kind === 'none' ? text('') : number(fact.hundredths),
    text(seedBasis(fact)),
    text(roles.get(swimmerId) ?? ''),
    result?.row.place === null || result === undefined ? text('') : number(result.row.place),
    result === undefined ? text('') : number(entry.kind === 'relay' ? result.row.points / 4 : result.row.points),
  ];
  return cells;
}

function text(value: string): CsvCell {
  return { kind: 'text', value };
}

function number(value: number): CsvCell {
  return { kind: 'number', value };
}

function encodeCell(cell: CsvCell): string {
  const value = cell.kind === 'number' ? String(cell.value) : guardFormula(cell.value);
  return quoteCell(value);
}

function guardFormula(value: string): string {
  const first = value[0];
  return first === '=' || first === '+' || first === '-' || first === '@' || first === '\t' || first === '\r'
    ? `'${value}`
    : value;
}

function quoteCell(value: string): string {
  const mustQuote = /[",\r\n]/.test(value) || value.startsWith(' ') || value.endsWith(' ');
  return mustQuote ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Encode one row per individual entry or relay leg as UTF-8-ready CSV text. */
export function entryCsv(
  lineup: Lineup,
  results: Results,
  facts: ReportFacts,
  roles: ReadonlyMap<SwimmerId, RoleLabel>,
): { content: string; count: number; issues: readonly CsvIssue[] } {
  const resultRows = new Map<string, NamedResult>();
  for (const event of results.events) {
    for (const row of event.rows) resultRows.set(row.entryKey, { row });
  }
  const issues: CsvIssue[] = [];
  const entries = csvRows(lineup);
  const rows = entries.map(row => entryCells(row, lineup, facts, roles, resultRows, issues));
  if (issues.length > 0) return { content: '', count: 0, issues };
  const header = columns.map(value => encodeCell(text(value))).join(',');
  const body = rows.map(row => row.map(encodeCell).join(','));
  return { content: `\uFEFF${[header, ...body].join('\r\n')}\r\n`, count: rows.length, issues };
}
