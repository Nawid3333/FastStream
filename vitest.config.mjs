import {defineConfig} from 'vitest/config';

export default defineConfig({
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
