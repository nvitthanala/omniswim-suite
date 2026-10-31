import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Progression, TeamId } from '@omniswim/engine';
import { ScoreChart } from '../apps/extension/src/dashboard/ScoreChart';

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
});

