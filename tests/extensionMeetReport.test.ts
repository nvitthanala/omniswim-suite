import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Lineup, ReportFacts, Results } from '@omniswim/engine';
import { swimmerPoints } from '@omniswim/engine';
import { MeetReport, printReport } from '../apps/extension/src/dashboard/MeetReport';

const entry = { kind: 'individual' as const, teamId: 'a', swimmerId: 's', eventKey: '50 Free', gender: 'Men' as const, seedSwimId: null };
const lineup: Lineup = { payloadVersion: 1, meetKey: 'm', entries: [entry], display: { swimmers: { s: { name: 'Swimmer' } }, teams: { a: { name: 'Team A' } }, entryTimes: {} } };
const results: Results = { payloadVersion: 1, teams: [{ teamId: 'a', points: 1, rank: 1 }, { teamId: 'b', points: 0, rank: 2 }], events: [{ eventKey: '50 Free', gender: 'Men', rows: [{ entryKey: 'i|a|s|50 Free|Men', teamId: 'a', swimmerId: 's', place: 1, points: 1, scored: true }] }], violations: [], rosterUnknown: [] };
const facts: ReportFacts = { payloadVersion: 1, seeds: { 'i|a|s|50 Free|Men': { kind: 'time', hundredths: 5234, estimated: false } }, classYears: { s: null } };
const props = { lineup, results, facts, schedule: null, ownTeamId: 'a', rivalTeamId: 'b', teamNames: { a: 'Team A', b: 'Team B' } };
const render = (f: ReportFacts | null) => renderToStaticMarkup(React.createElement(MeetReport, { ...props, facts: f }));

describe('MeetReport', () => {
  it('shows standings role words and swimmer totals from the engine', () => {
    const html = render(facts);
    expect(html).toContain('Team A (you)'); expect(html).toContain('Team B (rival)');
    expect(html).toContain(String(swimmerPoints(results, lineup)[0]?.total));
  });
  it('says seeds are unavailable when facts are absent', () => { expect(render(null)).toContain('Seeds are unavailable for this snapshot'); });
  it('calls the injected print function and shows the print control', () => {
    const print = vi.fn(); printReport(print); expect(print).toHaveBeenCalledOnce(); expect(render(facts)).toContain('Print report');
  });
  it('defines print media rules and light token overrides', () => {
    const css = readFileSync('apps/extension/src/dashboard/dashboard.css', 'utf8');
    expect(css).toMatch(/@media print\s*\{/); expect(css).toContain('--osx-bg: #FAFAFA'); expect(css).toContain('--osx-fg: rgba(0,0,0,0.87)');
  });
});
