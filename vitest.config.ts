import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    // `npm run test:coverage`. Report only: there is no threshold, so a low number never fails a run.
    // The report goes under node_modules/.cache, which git and eslint already ignore. Not test-results/:
    // Playwright empties that folder at the start of every run and would delete a report in progress.
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/node_modules/**', '**/dist/**'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'node_modules/.cache/coverage',
      // Print the summary even when a test fails, so the report-only CI step still reports.
      reportOnFailure: true,
    },
  },
  resolve: {
    alias: {
      '@omniswim/core': path.join(root, 'packages/core/src'),
    },
  },
});
