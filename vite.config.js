import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Relative base so the build works inside the Capacitor WebView and on any sub-path host.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
  worker: {
    format: 'es',
  },
});
