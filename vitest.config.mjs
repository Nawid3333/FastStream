import path from 'node:path';
import {defineConfig} from 'vitest/config';

// Libraries tools/sync-vendor.mjs copies out of node_modules unchanged (patched by pnpm at
// install). The copies are generated, and CI runs the unit tests before it makes them, so a
// test of code that imports one (the save's MP4 writers) gets the npm build itself.
const root = import.meta.dirname;
const VENDORED = new Map([
  ['chrome/player/modules/hls.mjs', 'node_modules/hls.js/dist/hls.mjs'],
  ['chrome/player/modules/mp4box/mp4box.all.mjs', 'node_modules/mp4box/dist/mp4box.all.mjs'],
  // Line endings aside (normaliseText).
  ['chrome/player/modules/remux/mediabunny.mjs', 'node_modules/mediabunny/dist/bundles/mediabunny.mjs'],
].map(([copy, build]) => [path.resolve(root, copy), path.resolve(root, build)]));

export default defineConfig({
  plugins: [{
    name: 'vendored-libraries',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) {
        return null;
      }
      return VENDORED.get(path.resolve(path.dirname(importer), source)) ?? null;
    },
  }],
  test: {
    // These suites cover pure logic only, so no DOM is needed. Anything that
    // touches window/navigator at module scope (FSBlob, most of player/ui)
    // belongs in the WebdriverIO end-to-end suite instead.
    environment: 'node',
    include: ['tests/unit/**/*.test.mjs'],
    reporters: ['default'],
    coverage: {
      // No repo-wide threshold: most of chrome/player and chrome/background
      // is DOM/browser-API-dependent and deliberately covered by the e2e
      // suites instead (see the comment above), so a blanket percentage
      // here would just be noise. This is for `pnpm run test:coverage` as
      // a local, on-demand look at how thoroughly the pure-logic modules
      // this suite actually imports are exercised.
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
