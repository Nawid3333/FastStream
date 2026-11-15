import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

// tools/same-code.mjs answers whether a typing pass changed only comments. A false "same" lets
// a code change through under that name; a false "differs" makes the check useless.

describe('same-code in a clone', () => {
  const script = path.resolve('tools/same-code.mjs');
  /** @type {string[]} */
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });

  /** A repository whose one commit holds chrome/a.mjs and chrome/b.js. */
  const clone = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'same-code-'));
    dirs.push(dir);
    const git = (...args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'});
    git('init', '-q');
    git('config', 'user.name', 'test');
    git('config', 'user.email', 'test@example.com');
    git('config', 'core.autocrlf', 'false');
    fs.mkdirSync(path.join(dir, 'chrome'));
    fs.writeFileSync(path.join(dir, 'chrome', 'a.mjs'), 'export function f(x) {\n  return x + 1;\n}\n');
    fs.writeFileSync(path.join(dir, 'chrome', 'b.js'), 'const s = "text";\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    return dir;
  };
  const write = (dir, file, text) => fs.writeFileSync(path.join(dir, file), text);
  const run = (dir, ...args) => {
    try {
      return {code: 0, out: execFileSync(process.execPath, [script, 'HEAD', ...args], {cwd: dir, encoding: 'utf8', stdio: 'pipe'})};
    } catch (error) {
      return {code: error.status, out: String(error.stdout)};
    }
  };

  it('calls comments, JSDoc casts and quote style the same code', () => {
    const dir = clone();
    write(dir, 'chrome/a.mjs', [
      '// @ts-check',
      '/** @param {number} x @return {number} */',
      'export function f(x) {',
      '  return /** @type {number} */ (x) + 1; // one more',
      '}',
      '',
    ].join('\n'));
    write(dir, 'chrome/b.js', 'const s = \'text\';\n');
    const result = run(dir);
    expect(result).toEqual({code: 0, out: '2 changed file(s): 2 with the same code, 0 differ\n'});
  });

  it('names the line where the code first differs', () => {
    const dir = clone();
    write(dir, 'chrome/a.mjs', '// note\nexport function f(x) {\n  return x + 2;\n}\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('CODE  chrome/a.mjs:3');
    expect(result.out).toContain('1 changed file(s): 0 with the same code, 1 differ');
  });

  it('notices a statement added at the end, and a changed string', () => {
    const dir = clone();
    write(dir, 'chrome/a.mjs', 'export function f(x) {\n  return x + 1;\n}\nf(1);\n');
    write(dir, 'chrome/b.js', 'const s = "text ";\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('CODE  chrome/a.mjs:4');
    expect(result.out).toContain('CODE  chrome/b.js:1');
  });

  it('sees a template\'s raw text change, which a tag gets', () => {
    const dir = clone();
    write(dir, 'chrome/b.js', 'const s = String.raw`\\n`;\n');
    execFileSync('git', ['commit', '-q', '-am', 'tag'], {cwd: dir});
    write(dir, 'chrome/b.js', 'const s = String.raw`\\x0a`;\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('CODE  chrome/b.js:1');
  });

  it('reads a file whose name is not ASCII', () => {
    const dir = clone();
    write(dir, 'chrome/é.mjs', 'export const e = 1;\n');
    execFileSync('git', ['add', '.'], {cwd: dir});
    execFileSync('git', ['commit', '-q', '-m', 'e'], {cwd: dir});
    write(dir, 'chrome/é.mjs', 'export const e = 2;\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('CODE  chrome/é.mjs:1');
  });

  it('points a removed statement at the last one left', () => {
    const dir = clone();
    write(dir, 'chrome/b.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
    execFileSync('git', ['commit', '-q', '-am', 'three'], {cwd: dir});
    write(dir, 'chrome/b.js', 'const a = 1;\nconst b = 2;\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('CODE  chrome/b.js:2');
  });

  it('counts new (untracked too) and deleted files as differing, and keeps to the paths given', () => {
    const dir = clone();
    write(dir, 'chrome/new.mjs', 'export const n = 1;\n');
    fs.rmSync(path.join(dir, 'chrome', 'b.js'));
    fs.mkdirSync(path.join(dir, 'tools'));
    write(dir, 'tools/other.mjs', 'export const o = 1;\n');
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.out).toContain('NEW   chrome/new.mjs');
    expect(result.out).toContain('GONE  chrome/b.js');
    expect(result.out).not.toContain('tools/other.mjs');
    expect(run(dir, 'tools').out).toContain('NEW   tools/other.mjs');
  });

  it('wants a base commit', () => {
    const dir = clone();
    let status = 0;
    try {
      execFileSync(process.execPath, [script], {cwd: dir, stdio: 'pipe'});
    } catch (error) {
      status = error.status;
    }
    expect(status).toBe(2);
  });
});
