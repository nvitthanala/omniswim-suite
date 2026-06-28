/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Full-stack DOM regression: ChartShell → ChartFrame → LineChart with explicit
 * props must mount .recharts-wrapper without ResponsiveContainer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Window } from 'happy-dom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

globalThis.React = React;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ChartShell } = await import('../packages/ui/src/components/ChartShell.tsx');
const { ChartFrame } = await import('../packages/ui/src/components/ChartFrame.tsx');

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

  const originalGetBoundingClientRect = globals.HTMLElement.prototype.getBoundingClientRect;
  globals.HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const el = this;
    if (
      el.classList?.contains('chart-shell') ||
      el.classList?.contains('chart-shell__viewport')
    ) {
      return {
        width: 600,
        height: 256,
        top: 0,
        left: 0,
        right: 600,
        bottom: 256,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      };
    }
    return originalGetBoundingClientRect.call(el);
  };

  return window;
}

function injectChartShellCss() {
  const cssPath = join(repoRoot, 'packages/ui/src/index.css');
  const raw = readFileSync(cssPath, 'utf8');
  const chartRules = raw
    .split('\n')
    .filter(line => line.includes('chart-shell'))
    .join('\n');
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; }
    html, body { width: 640px; height: 320px; margin: 0; }
    ${chartRules}
    .chart-shell--md { height: 256px; min-height: 256px; }
  `;
  document.head.appendChild(style);
}

function buildLineChart(props = {}) {
  return React.createElement(
    LineChart,
    {
      data: fixtureData,
      margin: { top: 8, right: 12, left: 4, bottom: 20 },
      isAnimationActive: false,
      ...props,
    },
    React.createElement(CartesianGrid, { strokeDasharray: '3 3' }),
    React.createElement(XAxis, { dataKey: 'name' }),
    React.createElement(YAxis, { width: 48 }),
    React.createElement(Line, {
      type: 'monotone',
      dataKey: 'teamA',
      stroke: '#3b82f6',
      strokeWidth: 2,
      isAnimationActive: false,
    }),
    React.createElement(Line, {
      type: 'monotone',
      dataKey: 'teamB',
      stroke: '#ef4444',
      strokeWidth: 2,
      isAnimationActive: false,
    })
  );
}

function ChartFixture() {
  return React.createElement(
    ChartShell,
    { size: 'md', className: 'p-2' },
    ({ width, height }) =>
      React.createElement(
        ChartFrame,
        { width, height },
        buildLineChart({
          width: Math.floor(width),
          height: Math.floor(height),
          responsive: false,
        })
      )
  );
}

async function flushEffects(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function assertChartRendered(label) {
  const responsiveContainer = document.querySelector('.recharts-responsive-container');
  if (responsiveContainer) {
    throw new Error(`${label}: ResponsiveContainer must not mount (causes -1 sizing warnings)`);
  }

  const wrapper = document.querySelector('.recharts-wrapper');
  if (!wrapper) {
    throw new Error(`${label}: expected .recharts-wrapper to mount`);
  }

  const surface = document.querySelector('.recharts-surface, svg.recharts-surface, svg');
  if (!surface) {
    throw new Error(`${label}: expected SVG surface inside Recharts wrapper`);
  }

  const svgWidth = Number(surface.getAttribute('width') || surface.getBoundingClientRect().width);
  const svgHeight = Number(surface.getAttribute('height') || surface.getBoundingClientRect().height);
  if (!Number.isFinite(svgWidth) || !Number.isFinite(svgHeight) || svgWidth < 100 || svgHeight < 100) {
    throw new Error(
      `${label}: expected SVG size > 100px, got ${svgWidth}x${svgHeight}`
    );
  }

  const gridLines = document.querySelectorAll(
    '.recharts-cartesian-grid line, .recharts-cartesian-grid path, .recharts-cartesian-grid-horizontal line'
  );
  const linePaths = document.querySelectorAll('.recharts-line path, .recharts-line-curve, path.recharts-curve');
  if (gridLines.length < 1 && linePaths.length < 1) {
    throw new Error(
      `${label}: expected grid or line paths, found grid=${gridLines.length} lines=${linePaths.length}`
    );
  }
}

const window = installDom();
injectChartShellCss();

const container = document.createElement('div');
container.style.width = '640px';
container.style.height = '320px';
document.body.appendChild(container);
const root = createRoot(container);

root.render(React.createElement(ChartFixture));
await flushEffects();

const shell = document.querySelector('.chart-shell');
if (!shell) {
  throw new Error('expected .chart-shell to mount');
}
if (shell.getAttribute('data-chart-ready') !== 'true') {
  throw new Error(
    `expected data-chart-ready=true, got ${shell.getAttribute('data-chart-ready')} (w=${shell.getAttribute('data-chart-w')} h=${shell.getAttribute('data-chart-h')})`
  );
}
if (shell.getAttribute('data-chart-live-ready') !== 'true') {
  throw new Error(
    `expected data-chart-live-ready=true, got ${shell.getAttribute('data-chart-live-ready')}`
  );
}

assertChartRendered('ChartShell → ChartFrame → LineChart');
root.unmount();
document.body.innerHTML = '';

const failContainer = document.createElement('div');
failContainer.style.width = '640px';
document.body.appendChild(failContainer);
const failRoot = createRoot(failContainer);

failRoot.render(buildLineChart());
await flushEffects();

const failSurface = document.querySelector('svg.recharts-surface, svg');
const failWidth = failSurface ? Number(failSurface.getAttribute('width') || 0) : 0;
const failHeight = failSurface ? Number(failSurface.getAttribute('height') || 0) : 0;
if (failSurface && failWidth > 100 && failHeight > 100) {
  throw new Error(
    `expected chart without width/height to stay blank or tiny, got ${failWidth}x${failHeight}`
  );
}

failRoot.unmount();
window.close();

console.log('chart render full-stack DOM regression passed');
