/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every link in the app goes somewhere the app can render.
 *
 * ## Why a test reads source text here
 *
 * The routes live in JSX (`<Route path="/manager" …>` in `apps/shell/src/App.tsx`)
 * and the navigation targets live in plain arrays and attributes scattered
 * across three packages. Nothing at runtime holds both lists, so nothing can
 * compare them — a route deleted from `App.tsx` leaves every link to it intact
 * and silently redirecting to `/`, because the catch-all `<Route path="*">`
 * swallows it. That is a dead button that looks like a working one, which is
 * the navigability failure a coach actually hits.
 *
 * Reading the source is the only way to check this statically, and this repo
 * already does it for the extension bundles in
 * `swimCloudExtensionBuildFreshness.test.ts`. The alternative is rendering the
 * whole router, which would test React rather than the link list.
 *
 * ## What this does not claim
 *
 * It checks that a target *resolves to a route*, not that the page behind it
 * works. A route rendering a broken component still passes here.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const APP_TSX = path.join(ROOT, 'apps', 'shell', 'src', 'App.tsx');
const SEARCH_DIRS = [path.join(ROOT, 'apps'), path.join(ROOT, 'packages')];

/** Every `<Route path="…">` the shell declares, catch-all included. */
function declaredRoutes(): string[] {
  const source = fs.readFileSync(APP_TSX, 'utf-8');
  return [...source.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1] as string);
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Internal navigation targets: JSX `to=`/`href=`, object-literal `to:`, and
 * `navigate('…')`.
 *
 * The object-literal form is not optional to cover. `AppletNav.tsx` declares
 * its three applets as `{ to: '/metrics', … }`, so a check that only read JSX
 * attributes would miss the entire applet switcher — the most-used navigation
 * in the app.
 */
function navigationTargets(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const pattern = /(?:to="|to: '|to: "|href="|navigate\(')(\/[a-zA-Z0-9/:_-]*)/g;
  for (const dir of SEARCH_DIRS) {
    if (!fs.existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      const source = fs.readFileSync(file, 'utf-8');
      for (const match of source.matchAll(pattern)) {
        const target = match[1] as string;
        // SwimCloud's own URLs appear in parser doc comments and fixtures.
        // They are not app routes and nothing here navigates to them.
        if (target.startsWith('/results/') || target.startsWith('/times/')) continue;
        found.set(target, [...(found.get(target) ?? []), path.relative(ROOT, file)]);
      }
    }
  }
  return found;
}

/** Does `target` match a declared route, allowing `:param` segments? */
function resolves(target: string, routes: readonly string[]): boolean {
  const targetParts = target.split('/').filter(Boolean);
  return routes.some((route) => {
    if (route === '*') return false; // The catch-all is what hides the bug.
    const routeParts = route.split('/').filter(Boolean);
    if (routeParts.length !== targetParts.length) return false;
    return routeParts.every((part, i) => part.startsWith(':') || part === targetParts[i]);
  });
}

describe('every internal navigation target resolves to a route', () => {
  const routes = declaredRoutes();
  const targets = navigationTargets();

  it('finds the shell routes at all', () => {
    // Guards the whole file from going vacuously green if App.tsx is moved or
    // the Route syntax changes: with no routes parsed, every check below would
    // either fail loudly or have nothing to compare.
    expect(routes).toContain('/manager');
    expect(routes).toContain('*');
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  it('finds the applet switcher, which declares its targets as object properties', () => {
    // AppletNav.tsx writes `{ to: '/metrics' }`, not `to="/metrics"`. An
    // earlier sweep of this exact question missed it and wrongly concluded
    // nothing linked to Metrics.
    expect(targets.has('/metrics')).toBe(true);
    expect(targets.get('/metrics')?.some((f) => f.includes('AppletNav'))).toBe(true);
  });

  it('leaves no link pointing at a route that does not exist', () => {
    const dead = [...targets.entries()]
      .filter(([target]) => !resolves(target, routes))
      .map(([target, files]) => `${target} (in ${files.join(', ')})`);
    expect(dead).toStrictEqual([]);
  });

  it('routes every applet the switcher offers', () => {
    // Named separately because these three are the app's primary navigation.
    // A dead one here is not a stray link, it is a whole applet unreachable.
    for (const applet of ['/manager', '/matrix', '/metrics']) {
      expect(targets.has(applet), `${applet} is linked from nowhere`).toBe(true);
      expect(resolves(applet, routes), `${applet} has no route`).toBe(true);
    }
  });
});
