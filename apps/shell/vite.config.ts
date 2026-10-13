import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tsconfigPathAliases } from '../../scripts/lib/tsconfigAliases';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(__dirname, '../..');

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
      { find: '@omniswim/ui/styles.css', replacement: path.join(monorepoRoot, 'packages/ui/src/index.css') },
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
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/react-router-dom')) return 'vendor-react';
          if (id.includes('node_modules/recharts')) return 'vendor-charts';
          if (id.includes('node_modules/motion')) return 'vendor-motion';
          // Shared workspace code must be its own chunk; otherwise it gets
          // split across applet chunks and creates a circular dependency.
          if (id.includes('packages/core') || id.includes('packages/ui')) return 'shared-suite';
          if (id.includes('packages/manager')) return 'applet-manager';
          if (id.includes('packages/matrix')) return 'applet-matrix';
          if (id.includes('packages/metrics')) return 'applet-metrics';
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
