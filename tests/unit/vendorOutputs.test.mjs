import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// What tools/sync-vendor.mjs writes is made from the pinned library on every build, so it
// must not also be committed: a committed copy goes stale beside the library it came from.
// The colour picker's stylesheet was upstream's re-minified copy of Coloris 0.21.x (2023)
// while the script followed the pinned 0.25.0, and nothing said which release it was.

const root = path.resolve(import.meta.dirname, '../..');
const source = fs.readFileSync(path.join(root, 'tools/sync-vendor.mjs'), 'utf8');
// Plain entries, and the mp4box chunks' template (one path per chunk, all under one folder).
const outputs = [...source.matchAll(/^\s+to: ['`]([^'`$]+)/gm)].map((match) => match[1]);

describe('sync-vendor outputs', () => {
  it('include the colour picker\'s stylesheet, from the pinned Coloris', () => {
    expect(source).toMatch(/from: 'node_modules\/Coloris\/dist\/coloris\.css',\s+to: 'chrome\/player\/assets\/coloris\/css\/coloris\.css'/);
    const html = fs.readFileSync(path.join(root, 'chrome/player/index.html'), 'utf8');
    expect(html).toContain('href="./assets/coloris/css/coloris.css"');
  });

  it('are gitignored and not committed', () => {
    expect(outputs.length).toBeGreaterThanOrEqual(15);
    const ignored = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
    const isIgnored = (file) => ignored.some((line) => line === file || (line.endsWith('/') && file.startsWith(line)));
    expect(outputs.filter((file) => !isIgnored(file))).toEqual([]);
    const tracked = execFileSync('git', ['ls-files', '--', ...outputs], {cwd: root, encoding: 'utf8'}).trim();
    expect(tracked).toBe('');
  });
});
