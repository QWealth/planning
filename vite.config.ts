import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  /*
    Shim Node's `global` for the browser.

    Copied deliberately from marketing_compliance_review/vite.config.ts, where it
    cost most of a day. aws-amplify pulls in `buffer`, which reads `global` at
    module scope. The production build tolerates it; the dev server does not define
    it, so the dev bundle throws "ReferenceError: global is not defined" while
    loading Amplify, before React mounts. The page renders blank with nothing in the
    console but Vite's own connection messages and every asset returning 200 - so
    `npm run build` and the deployed site look perfectly healthy right up until
    somebody runs `npm run dev`.

    BOTH defines are required. The top-level `define` is applied by Vite's own
    transform, which only touches first-party source. Dependencies are pre-bundled
    separately by esbuild into node_modules/.vite/deps, and `buffer` lives there, so
    the reference that actually throws sits in a chunk `define` never sees.

    After editing either one, delete node_modules/.vite - the optimiser caches on a
    hash of the config and will happily keep serving the unshimmed chunk.
  */
  define: {
    global: 'globalThis',
  },
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  server: {
    // `npm run dev` talks to a local `uvicorn app.main:app --port 8000`, so the
    // browser sees /api on its own origin exactly as it does through CloudFront.
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    // dist/, because cdk/lib/frontend_stack.py uploads dist/ in preference to the
    // web/ placeholder. Renaming this silently ships the placeholder instead.
    outDir: 'dist',
    sourcemap: true,
  },
});
