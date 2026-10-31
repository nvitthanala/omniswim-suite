import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Lineup, ReportFacts, Results } from '@omniswim/engine';
import { downloadEntryCsv, EntryCsvButton } from '../apps/extension/src/dashboard/EntryCsvButton';

const entry = { kind: 'individual' as const, teamId: 'a', swimmerId: 's', eventKey: '50 Free', gender: 'Men' as const, seedSwimId: null };
const lineup: Lineup = { payloadVersion: 1, meetKey: 'm', entries: [entry], display: { swimmers: { s: { name: 'José' } }, teams: { a: { name: 'A' } }, entryTimes: {} } };
const results: Results = { payloadVersion: 1, teams: [{ teamId: 'a', points: 1, rank: 1 }], events: [{ eventKey: '50 Free', gender: 'Men', rows: [{ entryKey: 'i|a|s|50 Free|Men', teamId: 'a', swimmerId: 's', place: 1, points: 1, scored: true }] }], violations: [], rosterUnknown: [] };
const facts: ReportFacts = { payloadVersion: 1, seeds: { 'i|a|s|50 Free|Men': { kind: 'time', hundredths: 5234, estimated: false } }, classYears: { s: null } };
const render = (f: ReportFacts | null, download = vi.fn()) => renderToStaticMarkup(React.createElement(EntryCsvButton, { lineup, results, facts: f, roles: new Map(), fileName: 'entries.csv', download }));

describe('EntryCsvButton', () => {
  it('refuses a snapshot without facts and explains why', () => { const html = render(null); expect(html).toContain('disabled'); expect(html).toContain('This snapshot has no seed facts'); });
  it('lists issues without offering a download', () => { const noName = { ...lineup, display: undefined }; const html = renderToStaticMarkup(React.createElement(EntryCsvButton, { lineup: noName, results, facts, roles: new Map(), fileName: 'entries.csv' })); expect(html).toContain('swimmer name missing'); expect(html).not.toContain('Download entry CSV'); });
  it('provides BOM-prefixed CSV content through an injectable downloader', async () => {
    const { entryCsv } = await import('@omniswim/engine');
    const csv = entryCsv(lineup, results, facts, new Map());
    expect(csv.content.startsWith('\uFEFF')).toBe(true);
    const download = vi.fn(); downloadEntryCsv(csv.content, 'entries.csv', download);
    expect(download).toHaveBeenCalledWith(expect.stringMatching(/^\uFEFF/), 'entries.csv', 'text/csv;charset=utf-8');
    expect(render(facts)).toContain('Download entry CSV');
    expect(typeof csv.content).toBe('string');
  });
});
