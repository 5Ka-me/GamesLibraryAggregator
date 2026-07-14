import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        // Consume the shared package's TS source directly. Vite compiles it as
        // ESM, avoiding all CJS-interop issues that arise when a linked
        // workspace package is imported via its compiled dist (both in dev's
        // dep pre-bundling and in the production Rollup pass).
        '@app/shared': resolve('../packages/shared/src/index.ts'),
      },
    },
    server: {
      fs: {
        // The renderer imports shared source from ../packages/shared (outside
        // the launcher dir), so let the dev server read the repo root.
        allow: [resolve('..')],
      },
    },
    plugins: [react()],
  },
});
