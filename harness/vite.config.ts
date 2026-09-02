// THROWAWAY. Delete with the rest of harness/.
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const STUB = path.resolve(__dirname, 'api-stub.ts');

export default defineConfig({
  root: __dirname,
  plugins: [
    // NOT resolve.alias. An alias is matched against the import SPECIFIER before
    // resolution, so an absolute-path `find` never matches `../services/api` and the
    // real Amplify-pulling module gets bundled with no error of any kind - the page
    // just renders blank. resolveId sees the importer, so the relative form matches.
    {
      name: 'stub-api',
      enforce: 'pre',
      resolveId(source: string) {
        return source.endsWith('/services/api') ? STUB : null;
      },
    },
    react(),
  ],
  define: { global: 'globalThis' },
});
