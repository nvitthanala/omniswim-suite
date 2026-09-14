import { describe, it, expect } from 'vitest';
import {
  exportEntriesCsv,
  exportEntriesHytek,
  validateEntriesForExport,
} from '../packages/core/src/lib/entryExport';
import { Gender, type PlannedSwimEntry, type Workspace } from '../packages/core/src/types';

function entry(overrides: Partial<PlannedSwimEntry> = {}): PlannedSwimEntry {
  return {
    id: 'e1',
    name: 'Alpha, Ace',
    team: 'Home University',
    gender: Gender.MEN,
    event: '100 Freestyle',
    time: '48.50',
    source: 'manual',
    active: true,
    ...overrides,
  };
}

function workspace(entries: PlannedSwimEntry[]): Workspace {
  return {
    id: 'ws',
    name: 'Export test',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    meetEntryPlans: entries,
    activeEntryIds: [],
  } as unknown as Workspace;
}

describe('validateEntriesForExport', () => {
  it('reports no issues for a clean entry', () => {
    expect(validateEntriesForExport([entry()])).toEqual([]);
  });

  it('flags a gender that is neither Men nor Women, by entry', () => {
    const bad = entry({ gender: 'Unknown' as unknown as Gender });
    const issues = validateEntriesForExport([bad]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: 'unrecognized_gender', entryId: 'e1' });
  });

  it('flags a blank name, team, and event independently, not just the first found', () => {
    const bad = entry({ name: '', team: '  ', event: '' });
    const issues = validateEntriesForExport([bad]);
    const types = issues.map(i => i.type).sort();
    expect(types).toEqual(['missing_event', 'missing_name', 'missing_team']);
  });

  it('does not flag a blank time — "NT" is a real, legitimate placeholder', () => {
    const noTime = entry({ time: '' });
    expect(validateEntriesForExport([noTime])).toEqual([]);
  });
});

describe('exportEntriesCsv gender column', () => {
  it('exports Women as F and Men as M', () => {
    const csv = exportEntriesCsv(
      workspace([entry({ gender: Gender.WOMEN, name: 'Beta, Bea' }), entry({ id: 'e2', gender: Gender.MEN })])
    );
    const rows = csv.content.split('\r\n').slice(1);
    expect(rows[0]).toContain(',F,');
    expect(rows[1]).toContain(',M,');
  });

  it('exports an unrecognized gender as "?", never a guessed M — the actual bug this closes', () => {
    const csv = exportEntriesCsv(workspace([entry({ gender: 'Unknown' as unknown as Gender })]));
    const row = csv.content.split('\r\n')[1];
    expect(row).toContain(',?,');
    expect(row).not.toContain(',M,');
  });
});

describe('exportEntriesHytek gender column', () => {
  it('exports an unrecognized gender as "?", never a guessed M', () => {
    const hytek = exportEntriesHytek(workspace([entry({ gender: 'Unknown' as unknown as Gender })]));
    const dataLine = hytek.content.split('\r\n').find(l => l.startsWith('D1 '));
    expect(dataLine).toContain('\t?\t');
  });
});
