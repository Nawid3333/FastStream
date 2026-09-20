import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';
import {EnvUtils} from '../../chrome/player/utils/EnvUtils.mjs';

// EnvUtils.isChrome, isFirefox and isSafari were removed when this project became Firefox
// only. Two callers survived in chrome/player/modules/analyzer, a folder ESLint does not
// look at, and a call to a method that is not there fails only when that code runs: the
// background audio analyzer threw "EnvUtils.isSafari is not a function" in a shipped
// release. Nothing else would notice, so this reads every source file and checks that each
// EnvUtils method it calls exists.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../chrome');

/**
 * Lists the .mjs and .js files under a directory.
 * @param {string} dir - The directory to walk.
 * @return {string[]} Full paths.
 */
function sourceFiles(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return /\.(mjs|js)$/.test(entry.name) ? [full] : [];
  });
}

describe('EnvUtils', () => {
  it('has every method the source calls on it', () => {
    const missing = [];
    let calls = 0;
    for (const file of sourceFiles(root)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [, method] of text.matchAll(/\bEnvUtils\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        calls++;
        if (typeof EnvUtils[method] !== 'function') {
          missing.push(`${path.relative(root, file)}: EnvUtils.${method}()`);
        }
      }
    }
    // The scan has to be finding something, or an empty list proves nothing.
    expect(calls).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  it('no longer asks which browser it is', () => {
    for (const method of ['isChrome', 'isFirefox', 'isSafari']) {
      expect(EnvUtils[method]).toBeUndefined();
    }
  });
});
