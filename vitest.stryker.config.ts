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
      ],
    },
  })
);
