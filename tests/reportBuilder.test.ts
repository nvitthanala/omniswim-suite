import { describe, it, expect } from 'vitest';
import { buildMeetReportHtml } from '../packages/core/src/lib/reportBuilder';
import type { Workspace } from '../packages/core/src/types';

/**
 * This file used to build a report from an EMPTY workspace and assert only that
 * the HTML contained the workspace name and a doctype. Every row-rendering path
 * was therefore unreachable: dropping the entire results table would still have
 * passed. The cases below exercise the table body, the empty-state branch, and
 * the `esc()` escaping that the name and every cell pass through.
 */

function workspace(patch: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: 'Conference Finals',
    createdAt: Date.now(),
    menResults: [],
    womenResults: [],
    recruits: [],
    deletedSwimmers: [],
    ...patch,
  } as Workspace;
}

const swim = (name: string, event: string, time: string, id: string) => ({
  id,
  name,
  event,
  time,
  team: 'Home',
  gender: 'Men',
  rank: 1,
  classYear: 'FR',
  points: 20,
  isRelay: false,
});

describe('reportBuilder', () => {
  it('renders the workspace name, the doctype and the result counts', () => {
    const html = buildMeetReportHtml(
      workspace({
        menResults: [swim('Alice Swimmer', '100 Free', '52.10', 'r1')] as never,
        womenResults: [
          swim('Bea Swimmer', '200 Free', '1:52.00', 'r2'),
          swim('Cara Swimmer', '50 Free', '24.10', 'r3'),
        ] as never,
      })
    );

    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<h1>Conference Finals</h1>');
    // The counts are computed from the two arrays, not hardcoded.
    expect(html).toContain("1 men&apos;s + 2 women&apos;s results");
  });

  it('renders one table row per swimmer trend, carrying the best time', () => {
    const html = buildMeetReportHtml(
      workspace({
        menResults: [
          swim('Alice Swimmer', '100 Free', '52.10', 'r1'),
          // Same swimmer + event, faster: the report must show the BEST time.
          swim('Alice Swimmer', '100 Free', '51.50', 'r2'),
          swim('Bob Swimmer', '200 Free', '1:48.30', 'r3'),
        ] as never,
      })
    );

    expect(html).toContain('<td>Alice Swimmer</td>');
    expect(html).toContain('<td>Bob Swimmer</td>');
    // Best time wins and the slower one is not the value rendered for her row.
    expect(html).toMatch(/<td>Alice Swimmer<\/td><td>100 Free<\/td><td class="mono">51\.50<\/td><td>2<\/td>/);
    expect(html).toMatch(/<td>Bob Swimmer<\/td><td>200 Free<\/td><td class="mono">1:48\.30<\/td><td>1<\/td>/);
    expect(html).not.toContain('No trend data');
  });

  it('renders an explicit empty state rather than a blank table', () => {
    // Absent must stay legible: an empty tbody would render as a silent gap.
    const html = buildMeetReportHtml(workspace());
    expect(html).toContain('No trend data');
    expect(html).not.toMatch(/<tbody><\/tbody>/);
  });

  it('escapes HTML in the workspace name and in every cell', () => {
    const html = buildMeetReportHtml(
      workspace({
        name: 'Tom & Jerry <Invitational>',
        menResults: [swim('O’Hara & Sons <b>', '100 Free', '52.10', 'r1')] as never,
      })
    );

    expect(html).toContain('Tom &amp; Jerry &lt;Invitational&gt;');
    expect(html).toContain('O’Hara &amp; Sons &lt;b&gt;');
    // The raw angle brackets must not survive anywhere in the document.
    expect(html).not.toContain('<Invitational>');
    expect(html).not.toContain('Sons <b>');
  });
});
