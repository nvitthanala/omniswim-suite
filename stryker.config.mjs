// Mutation testing for the scoring path. Run by hand: `npm run test:mutation`.
// Run one file at a time so a crash in one file does not lose the others:
//   npm run test:mutation -- --mutate packages/core/src/lib/relayScoring.ts
// Restrict to a line range with `--mutate packages/core/src/lib/relayScoring.ts:40-120`.
// Results: docs/reference/MUTATION_RESULTS_2026-10-14.md. No CI wiring (plan item T6).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.stryker.config.ts' },
  coverageAnalysis: 'perTest',
  mutate: [
    'packages/core/src/lib/scoringRules.ts',
    'packages/core/src/lib/individualScoring.ts',
    'packages/core/src/lib/relayScoring.ts',
    'packages/core/src/lib/calculatePoints.ts',
    'packages/core/src/lib/meetPool.ts',
    'packages/core/src/lib/relaySimulation.ts',
    'packages/core/src/lib/ncaaScoringRules.ts',
    'packages/core/src/lib/scorerRoster.ts',
    'packages/core/src/lib/arbitrage/relayLegSwaps.ts',
  ],
  reporters: ['clear-text', 'progress-append-only', 'json'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  concurrency: 12,
  timeoutMS: 30000,
  timeoutFactor: 2,
  tempDirName: '.stryker-tmp',
  // Keep the sandbox copy small. None of these feed a test.
  // MUTATION_BASELINE=1 also leaves out tests/mutation/, so a run measures the suite
  // as it stood before the targeted mutation tests were added.
  ignorePatterns: [
    'venv',
    '/dist',
    'test-results',
    ...(process.env.MUTATION_BASELINE === '1' ? ['tests/mutation'] : []),
  ],
  cleanTempDir: true,
  ignoreStatic: true,
  // No type checker plugin runs, so the instrumenter has no types to disable.
  disableTypeChecks: false,
};
