import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    // The main process must NOT require '@app/shared' at runtime: the compiled
    // dist pulls in React UI (react/jsx-runtime), which doesn't exist in the
    // packaged app. Main only ever needs the tiny matching helper, so the
    // package name is aliased straight to that source file and bundled
    // (excluded from externalization). Importing anything else from
    // '@app/shared' in main will fail the build loudly — by design.
    plugins: [externalizeDepsPlugin({ exclude: ['@app/shared'] })],
    resolve: {
      alias: {
        '@app/shared': resolve('../packages/shared/src/matching.ts'),
      },
    },
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
