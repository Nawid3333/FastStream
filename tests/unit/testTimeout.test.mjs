import {describe, expect, it} from 'vitest';

import {testTimeout} from '../e2e/testTimeout.mjs';

// The e2e suites' cap on one test: E2E_TEST_TIMEOUT_MS lifts it for a long local run, and
// anything else leaves each suite's own (tests/e2e/testTimeout.mjs).
describe('testTimeout', () => {
  it('keeps the suite\'s cap without E2E_TEST_TIMEOUT_MS', () => {
    expect(testTimeout(120000, {})).toBe(120000);
  });

  it('takes E2E_TEST_TIMEOUT_MS', () => {
    expect(testTimeout(120000, {E2E_TEST_TIMEOUT_MS: '900000'})).toBe(900000);
  });

  it('keeps the suite\'s cap for a value that is no time', () => {
    for (const value of ['', '0', '-5', '1.5', 'ten minutes']) {
      expect(testTimeout(120000, {E2E_TEST_TIMEOUT_MS: value})).toBe(120000);
    }
  });
});
