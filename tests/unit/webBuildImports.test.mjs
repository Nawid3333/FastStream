import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {describe, expect, it} from 'vitest';

// The web build (build.mjs buildWeb) leaves the extension-only files out, the background folder
// among them. The options page once imported a background module at load: in the web build the
// import failed, and the whole page with it (the e2e "keybind list never rendered").

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..');
const chrome = path.join(root, 'chrome');

/** @return {string[]} The chrome/ paths buildWeb leaves out, absolute. */
function leftOut() {
  const build = fs.readFileSync(path.join(root, 'build.mjs'), 'utf8');
  const call = /spliceAndCopy\(chromeSourceDir, webBuildDir, \[[^\]]*\], \[([^\]]*)\]/.exec(build);
  if (!call) throw new Error('buildWeb\'s spliceAndCopy call not found in build.mjs');
  return [...call[1].matchAll(/'([^']+)'/g)].map((m) => path.join(chrome, m[1]));
}

/**
 * @param {string} dir
 * @return {string[]} Its .mjs and .js files, recursively.
 */
function scripts(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scripts(full);
    return /\.m?js$/.test(entry.name) ? [full] : [];
  });
}

describe('the web build', () => {
  const out = leftOut();
  const isOut = (file) => out.some((p) => file === p || file.startsWith(p + path.sep));

  it('leaves the background folder out (what this test guards)', () => {
    expect(out).toContain(path.join(chrome, 'background'));
  });

  it('ships no module that imports, at load, a file it leaves out', () => {
    const bad = [];
    for (const file of scripts(chrome).filter((f) => !isOut(f))) {
      const text = fs.readFileSync(file, 'utf8');
      // Static imports and re-exports only: `import('...')` loads when called, and a JSDoc
      // `import('...').Type` is never loaded.
      for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm)) {
        const spec = m[1] || m[2];
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(file), spec);
        if (isOut(target)) bad.push(`${path.relative(root, file)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
