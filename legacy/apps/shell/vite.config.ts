import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tsconfigPathAliases } from '../../../scripts/lib/tsconfigAliases.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../../..');

export default defineConfig({
  root: __dirname,
  publicDir: path.join(monorepoRoot, 'public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom', 'recharts'],
    alias: [
      { find: 'recharts', replacement: path.join(monorepoRoot, 'node_modules/recharts') },
      // Not a tsconfig path: `@omniswim/ui/*` maps to src/*, which has no styles.css.
      // It must precede the derived entries so it wins.
      { find: '@omniswim/ui/styles.css', replacement: path.join(monorepoRoot, 'legacy/packages/ui/src/index.css') },
      // Every `@omniswim/*` source alias comes from tsconfig.base.json `paths`, so the
      // bundler and the type checker cannot disagree. See scripts/lib/tsconfigAliases.ts.
      ...tsconfigPathAliases(path.join(monorepoRoot, 'tsconfig.base.json')),
    ],
  },
  optimizeDeps: {
    include: ['recharts', 'react', 'react-dom'],
  },
  build: {
    outDir: path.join(monorepoRoot, 'dist'),
    emptyOutDir: true,
    // Vite 8 bundles with Rolldown. `rollupOptions.output.manualChunks` still runs there but is
    // deprecated and groups modules differently, so the layout below uses `codeSplitting.groups`.
    // A group wins in declaration order (same priority), as the old if-chain did.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /node_modules[\\/](react-dom|react|react-router-dom)[\\/]/ },
            { name: 'vendor-charts', test: /node_modules[\\/]recharts/ },
            { name: 'vendor-motion', test: /node_modules[\\/]motion/ },
            // Shared workspace code must be its own chunk; otherwise it gets
            // split across applet chunks and creates a circular dependency.
            { name: 'shared-suite', test: /packages[\\/](core|ui)/ },
            { name: 'applet-manager', test: /packages[\\/]manager/ },
            { name: 'applet-matrix', test: /packages[\\/]matrix/ },
            { name: 'applet-metrics', test: /packages[\\/]metrics/ },
          ],
        },
      },
    },
  },
  server: {
    fs: {
      allow: [monorepoRoot],
    },
    headers: {
      'Cache-Control': 'no-store',
    },
  },
});
