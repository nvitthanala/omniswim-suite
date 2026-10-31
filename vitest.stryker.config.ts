import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// The test set Stryker runs for `npm run test:mutation` (see stryker.config.mjs).
// It is the normal suite minus files that never reach a scoring function: the
// backend routes and stores, SwimCloud capture and extension tests, backup and
// schema guards. Those take about 40% of the suite's run time, and a mutant that
// survives runs every test that covers it, so they would double a mutation run
// for no signal. Everything that scores, ranks, optimises or builds a lineup
// stays in.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // The base config runs tests/ only. The legacy move (2026-10-25) put many
      // scoring tests under legacy/tests because they import a legacy package;
      // they still guard packages/core, so mutation runs keep them.
      include: ['legacy/tests/**/*.test.ts'],
      exclude: [
        ...configDefaults.exclude,
        'tests/swimcloud*',
        'tests/swimCloud*',
        'tests/backup*',
        'tests/restoreLastBackup*',
        'tests/workspaceSave*',
        'tests/optimizeWorkerClient*',
        'tests/serverRefusesNewerSchema*',
        'tests/schemaVersionGuard*',
        'tests/parsing*',
        'tests/apiErrorShape*',
        'tests/backendDiagnostics*',
        'tests/authHardening*',
        'tests/hostOriginGuard*',
        'tests/dataLossGuard*',
        'tests/parsePdfGuard*',
        'tests/*Routes.test.ts',
        'legacy/tests/swimcloud*',
        'legacy/tests/swimCloud*',
        'legacy/tests/backup*',
        'legacy/tests/restoreLastBackup*',
        'legacy/tests/workspaceSave*',
        'legacy/tests/optimizeWorkerClient*',
        'legacy/tests/serverRefusesNewerSchema*',
        'legacy/tests/schemaVersionGuard*',
        'legacy/tests/parsing*',
        'legacy/tests/apiErrorShape*',
        'legacy/tests/backendDiagnostics*',
        'legacy/tests/authHardening*',
        'legacy/tests/hostOriginGuard*',
        'legacy/tests/dataLossGuard*',
        'legacy/tests/parsePdfGuard*',
        'legacy/tests/*Routes.test.ts',
      ],
    },
  })
);
