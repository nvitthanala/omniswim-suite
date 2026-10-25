/**
 * Dev/build-info route — reports the checked-out commit and the chart
 * build epoch the client's stale-bundle guard compares against.
 *
 * Extracted from `server.ts`'s `startServer` (H2, code-health refactor,
 * 2026-09-25) with no behavior change.
 */
import type { Express } from 'express';
import { execSync } from 'child_process';

export interface DevRoutesDeps {
  projectRoot: string;
  chartBuildEpoch: number;
}

export function registerDevRoutes(app: Express, deps: DevRoutesDeps): void {
  const { projectRoot: PROJECT_ROOT, chartBuildEpoch: CHART_BUILD_EPOCH } = deps;

  app.get('/api/dev/build-info', (_req, res) => {
    let commit = 'unknown';
    try {
      commit = execSync('git rev-parse --short HEAD', {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      /* not a git checkout */
    }
    res.json({
      commit,
      chartBuildEpoch: CHART_BUILD_EPOCH,
      chartArchitecture: 'ChartShell-ChartFrame-static',
    });
  });
}
