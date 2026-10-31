import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Progression, TeamId } from '@omniswim/engine';
import { niceTicks, ScoreChart, shortTeamName } from '../apps/extension/src/dashboard/ScoreChart';

const progression: Progression = { order: { kind: 'simulator', reason: 'unplaced', unplaced: [{ eventKey: '100-Free', gender: 'Women', why: 'unscheduled' }] }, points: [
  { eventKey: '100-Free', gender: 'Women', scoresIn: null, totals: { own: 10, rival: 8, other: 3 } },
  { eventKey: '200-Free', gender: 'Men', scoresIn: null, totals: { own: 20, rival: 15, other: 7 } },
] };
const render = (p = progression) => renderToStaticMarkup(React.createElement(ScoreChart, { progression: p, ownTeamId: 'own' as TeamId, rivalTeamId: 'rival' as TeamId, teamNames: { own: 'Own', rival: 'Rival', other: 'Other' } }));

describe('ScoreChart', () => {
  it('renders one polyline per team with own, rival and other styling', () => {
    const html = render();
    expect((html.match(/<polyline/g) ?? [])).toHaveLength(3);
    expect(html).toContain('class="osx-score-line osx-score-line--own"');
    expect(html).toContain('class="osx-score-line osx-score-line--rival"');
    expect(html).toContain('class="osx-score-line osx-score-line--other"');
  });
  it('labels simulator order and unplaced events', () => { expect(render()).toMatch(/Simulator order.*these events have no session: 100-Free \(Women\)/); });
  it('labels session order', () => { expect(render({ ...progression, order: { kind: 'schedule' } })).toContain('Session order'); });
  it('keeps color values out of markup attributes for theme-independent CSS styling', () => {
    const html = render();
    const attributes = [...html.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map(match => match[2]).join(' ');
    expect(attributes).not.toMatch(/#(?:[\da-f]{3,8})\b|rgb\s*\(|hsl\s*\(|var\s*\(/i);
    expect(html).toBe(render());
  });
  it('lists the last point totals and provides accessible summary and table', () => {
    const html = render();
    expect(html).toContain('Own (you): 20');
    expect(html).toContain('Rival (rival): 15');
    expect(html).toContain('Other: 7');
    expect(html).toContain('aria-label="Final standings: Own (you) 20 points, Rival (rival) 15 points, Other 7 points"');
    expect(html).toContain('<table');
  });
  it('separates close end labels by at least 12 pixels', () => {
    const close = {
      ...progression,
      points: progression.points.map((point, index) => ({
        ...point,
        totals: { ...point.totals, own: index === 0 ? 10 : 20, rival: index === 0 ? 9.5 : 19.5 },
      })),
    };
    const html = render(close);
    const ownY = Number(html.match(/osx-score-end-label--own" x="[^"]+" y="([^"]+)/)?.[1]);
    const rivalY = Number(html.match(/osx-score-end-label--rival" x="[^"]+" y="([^"]+)/)?.[1]);
    expect(Math.abs(ownY - rivalY)).toBeGreaterThanOrEqual(12);
  });
  it('shows the empty message without SVG', () => { const html = render({ ...progression, points: [] }); expect(html).toContain('No scored events'); expect(html).not.toContain('<svg'); });

  describe('lines are strokes, not filled shapes', () => {
    const css = readFileSync('apps/extension/src/dashboard/dashboard.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: (m[1] ?? '').trim(), body: m[2] ?? '' }));
    it('every polyline carries the osx-score-line class and no fill attribute', () => {
      const lines = render().match(/<polyline[^>]*>/g) ?? [];
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line).toMatch(/class="osx-score-line osx-score-line--/);
        expect(line).not.toMatch(/\sfill=/);
      }
    });
    it('the osx-score-line class sets fill: none, and no rule for a line variant sets another fill', () => {
      const base = rules.find((r) => r.selector === '.osx-score-line');
      expect(base?.body).toMatch(/fill:\s*none/);
      for (const rule of rules.filter((r) => r.selector.split(',').some((sel) => /\.osx-score-line--/.test(sel)))) {
        expect(rule.body, rule.selector).not.toMatch(/fill:\s*(?!none)/);
        // A rule shared with an end label would give the line the label's fill: a filled wedge.
        expect(rule.selector, 'a line variant shares no rule with an end label').not.toMatch(/osx-score-end-label/);
      }
    });
  });

  describe('y-axis ticks', () => {
    it('steps by 1, 2 or 5 times a power of ten, from 0, with the last tick at or above the largest total', () => {
      expect(niceTicks(849)).toStrictEqual([0, 200, 400, 600, 800, 1000]);
      expect(niceTicks(20)).toStrictEqual([0, 5, 10, 15, 20]);
      expect(niceTicks(3)).toStrictEqual([0, 1, 2, 3]);
      expect(niceTicks(1)).toStrictEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
      expect(niceTicks(0)).toStrictEqual(niceTicks(1));
      for (const max of [1, 7, 19, 83, 120, 849, 1234, 5000]) {
        const ticks = niceTicks(max);
        expect(ticks[0]).toBe(0);
        expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
        const steps = new Set(ticks.slice(1).map((t, i) => Number((t - (ticks[i] ?? 0)).toPrecision(9))));
        expect(steps.size, `one step for max ${max}`).toBe(1);
        const step = [...steps][0] as number;
        expect([1, 2, 5]).toContain(Number((step / 10 ** Math.floor(Math.log10(step))).toPrecision(9)));
      }
    });
    it('draws the grid at those ticks, not at fractions of the largest total', () => {
      const big: Progression = { ...progression, points: progression.points.map((p, i) => ({ ...p, totals: { own: i === 0 ? 400 : 849, rival: i === 0 ? 300 : 777, other: i === 0 ? 100 : 575 } })) };
      const labels = [...render(big).matchAll(/<g class="osx-score-grid"><line[^>]*><\/line><text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
      expect(labels).toStrictEqual(['0', '200', '400', '600', '800', '1000']);
    });
  });

  describe('end labels', () => {
    const longNames = { own: 'Henderson State University', rival: 'Ouachita Baptist University', other: 'Delta State University' };
    const renderAt = (width: number) => renderToStaticMarkup(React.createElement(ScoreChart, { progression, ownTeamId: 'own' as TeamId, rivalTeamId: 'rival' as TeamId, teamNames: longNames, width, height: width < 500 ? 180 : 300 }));
    it('drops a trailing University or College, and cuts with an ellipsis only what still does not fit', () => {
      expect(shortTeamName('Henderson State University', 15)).toBe('Henderson State');
      expect(shortTeamName('Ouachita Baptist University', 15)).toBe('Ouachita Bapti…');
      expect(shortTeamName('Delta State College', 40)).toBe('Delta State');
      expect(shortTeamName('University', 5)).toBe('Univ…');
    });
    it('keeps the full name in a title and never writes a label longer than the room beside the plot', () => {
      for (const [width, room] of [[320, 108 - 9], [600, 150 - 9]] as const) {
        const html = renderAt(width);
        const texts = [...html.matchAll(/<text class="osx-score-end-label[^>]*><title>([^<]*)<\/title>([^<]*)<\/text>/g)];
        expect(texts).toHaveLength(3);
        for (const [, full, shown] of texts) {
          expect(Object.values(longNames)).toContain(full);
          expect((shown ?? '').length * 6.6, `${shown} fits ${room}px at ${width}`).toBeLessThanOrEqual(room);
        }
      }
    });
    it('keeps the 12 px spacing at the compact width', () => {
      const close = { ...progression, points: progression.points.map((p, i) => ({ ...p, totals: { own: i === 0 ? 10 : 20, rival: i === 0 ? 9.5 : 19.5, other: i === 0 ? 9 : 19 } })) };
      const html = renderToStaticMarkup(React.createElement(ScoreChart, { progression: close, ownTeamId: 'own' as TeamId, rivalTeamId: 'rival' as TeamId, teamNames: longNames, width: 320, height: 180 }));
      const ys = [...html.matchAll(/osx-score-end-label--\w+" x="[^"]+" y="([^"]+)"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
      expect(ys).toHaveLength(3);
      for (let i = 1; i < ys.length; i += 1) expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(12);
    });
  });

  describe('a team total a step does not state', () => {
    const gap: Progression = { ...progression, points: [
      { eventKey: '100-Free', gender: 'Women', scoresIn: null, totals: { own: 10, rival: 8, other: 3 } },
      { eventKey: '200-Free', gender: 'Men', scoresIn: null, totals: { own: 20, other: 7 } },
      { eventKey: '50-Free', gender: 'Men', scoresIn: null, totals: { own: 30, rival: 25, other: 9 } },
    ] };
    it('stops the team line at the gap and says so, instead of plotting 0', () => {
      const html = render(gap);
      const rivalLines = html.match(/<polyline[^>]*osx-score-line--rival[^>]*>/g) ?? [];
      expect(rivalLines, 'two runs: before and after the gap').toHaveLength(2);
      for (const line of rivalLines) expect(Number(line.match(/points="([^"]*)"/)?.[1]?.split(' ').length)).toBe(1);
      // The other teams are one line each, across all three steps.
      expect((html.match(/<polyline[^>]*osx-score-line--own[^>]*>/g) ?? [])).toHaveLength(1);
      expect(html.match(/<polyline[^>]*osx-score-line--own[^>]*points="([^"]*)"/)?.[1]?.split(' ')).toHaveLength(3);
      expect(html).toContain('data-testid="chart-missing"');
      expect(html).toMatch(/Data missing: Rival at step 2 \(200-Free, Men\)/);
      // The gap point is not drawn at the zero line (the bottom tick).
      const zeroY = html.match(/<g class="osx-score-grid"><line[^>]*y1="([^"]+)"[^>]*><\/line><text[^>]*>0<\/text>/)?.[1];
      expect(zeroY).toBeDefined();
      for (const line of html.match(/<polyline[^>]*>/g) ?? []) expect(line).not.toContain(`,${zeroY}`);
    });
    it('shows no note when every step states every total', () => {
      expect(render()).not.toContain('chart-missing');
    });
    it('says a final total is missing, never 0', () => {
      const endGap: Progression = { ...progression, points: progression.points.map((p, i) => (i === 1 ? { ...p, totals: { own: 20, other: 7 } } : p)) };
      const html = render(endGap);
      expect(html).toContain('Rival (rival): missing');
      expect(html).toContain('Rival (rival) total missing');
      expect(html).not.toContain('Rival (rival): 0');
      expect(html).toMatch(/<td>missing<\/td>/);
    });
    it('includes a team the first step leaves out', () => {
      const late: Progression = { ...progression, points: progression.points.map((p, i) => (i === 0 ? { ...p, totals: { own: 10, other: 3 } } : p)) };
      const html = render(late);
      expect(html).toContain('Rival (rival): 15');
      expect(html).toMatch(/Data missing: Rival at step 1/);
    });
  });

  describe('shortTeamName budget', () => {
    it('is never longer than the budget', () => {
      expect(shortTeamName('Henderson State', 0)).toBe('');
      expect(shortTeamName('Henderson State', 1)).toBe('…');
      expect(shortTeamName('Henderson State', 2)).toBe('H…');
      for (let budget = 0; budget < 20; budget += 1) expect(shortTeamName('Henderson State University', budget).length).toBeLessThanOrEqual(budget);
    });
  });
});
