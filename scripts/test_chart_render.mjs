/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM regression: SizedChart + LineChart must mount .recharts-wrapper and SVG
 * paths. Catches the blank-chart failure mode where ChartShell border renders
 * but Recharts never bootstraps.
 */
import { Window } from 'happy-dom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

// tsx classic JSX fallback for direct .tsx imports in scripts
globalThis.React = React;

const { SizedChart } = await import('../packages/ui/src/components/SizedChart.tsx');

const fixtureData = [
  { name: 'E1', teamA: 10, teamB: 8 },
  { name: 'E2', teamA: 24, teamB: 20 },
  { name: 'E3', teamA: 36, teamB: 32 },
];

function installDom() {
  const window = new Window({ url: 'http://localhost/' });
  const globals = globalThis;
  globals.window = window;
  globals.document = window.document;
  globals.HTMLElement = window.HTMLElement;
  globals.SVGElement = window.SVGElement;
  globals.Node = window.Node;
  globals.getComputedStyle = window.getComputedStyle.bind(window);
  globals.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  globals.cancelAnimationFrame = (id) => clearTimeout(id);
  return window;
}

function ChartFixture() {
  return React.createElement(
    SizedChart,
    { width: 320, height: 240 },
    React.createElement(
      LineChart,
      { data: fixtureData, margin: { top: 8, right: 12, left: 4, bottom: 20 } },
      React.createElement(CartesianGrid, { strokeDasharray: '3 3' }),
      React.createElement(XAxis, { dataKey: 'name' }),
      React.createElement(YAxis, { width: 48 }),
      React.createElement(Line, { type: 'monotone', dataKey: 'teamA', stroke: '#3b82f6', strokeWidth: 2 }),
      React.createElement(Line, { type: 'monotone', dataKey: 'teamB', stroke: '#ef4444', strokeWidth: 2 })
    )
  );
}

async function flushEffects() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const window = installDom();
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

root.render(React.createElement(ChartFixture));
await flushEffects();

const wrapper = document.querySelector('.recharts-wrapper');
if (!wrapper) {
  throw new Error('expected .recharts-wrapper to mount inside SizedChart');
}

const surface = document.querySelector('.recharts-surface, svg.recharts-surface, svg');
if (!surface) {
  throw new Error('expected SVG surface inside Recharts wrapper');
}

const svgWidth = Number(surface.getAttribute('width') || surface.getBoundingClientRect().width);
const svgHeight = Number(surface.getAttribute('height') || surface.getBoundingClientRect().height);
if (!Number.isFinite(svgWidth) || !Number.isFinite(svgHeight) || svgWidth < 100 || svgHeight < 100) {
  throw new Error(
    `expected SVG size > 100px, got ${svgWidth}x${svgHeight} (wrapper rect ${Math.round(wrapper.getBoundingClientRect().width)}x${Math.round(wrapper.getBoundingClientRect().height)})`
  );
}

const linePaths = document.querySelectorAll('.recharts-line path, .recharts-line-curve, path.recharts-curve');
if (linePaths.length < 1) {
  throw new Error(`expected at least one line path, found ${linePaths.length}`);
}

root.unmount();
window.close();

console.log('chart render DOM regression passed');
