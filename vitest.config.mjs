import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // These suites cover pure logic only, so no DOM is needed. Anything that
    // touches window/navigator at module scope (FSBlob, most of player/ui)
    // belongs in the WebdriverIO end-to-end suite instead.
    environment: 'node',
    include: ['tests/unit/**/*.test.mjs'],
    reporters: ['default'],
  },
});
