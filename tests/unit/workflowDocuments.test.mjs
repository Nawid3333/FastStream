import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// js-yaml 5 has no default export, only named ones; this form reads 4 and 5 alike.
import * as yaml from 'js-yaml';
import {describe, expect, it} from 'vitest';

// A change of documents only starts no CI run and no dependency review (the owner, 2026-11-16):
// ci.yml's `paths-ignore`. A pattern there that took in a file the extension ships, the build
// reads or a test reads would let a change to it reach main untested - and, with no CI run,
// unreleased. This keeps the list to documents, and its copies the same.

const root = path.resolve(import.meta.dirname, '../..');
const workflow = (/** @type {string} */ name) =>
  /** @type {any} */ (yaml.load(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8')));
const ci = workflow('ci.yml');
const documents = /** @type {string[]} */ (ci.on.push['paths-ignore']);

/**
 * A paths-ignore pattern as GitHub reads these: '**' any path, '*' a name without '/'.
 * @param {string} pattern
 * @return {RegExp}
 */
function glob(pattern) {
  const source = pattern.split('**').map((part) =>
    part.split('*').map((text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*');
  return new RegExp(`^${source}$`);
}

const tracked = execFileSync('git', ['ls-files'], {cwd: root, encoding: 'utf8'}).split('\n').filter(Boolean);
const matched = tracked.filter((file) => documents.some((pattern) => glob(pattern).test(file)));

/**
 * The text of every script that builds, checks or tests: what could read a document.
 * @return {Array<[string, string]>} Path and text.
 */
function scripts() {
  return tracked.filter((file) => file === 'build.mjs' || file === 'package.json' ||
      (/^(tools|tests)\//.test(file) && /\.(mjs|cjs|js|sh|json)$/.test(file)) ||
      /^\.github\/workflows\/.*\.ya?ml$/.test(file))
      .map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
}

describe('ci.yml skips a change of documents only', () => {
  it('ignores the same documents on a push, a pull request and in the dependency review', () => {
    expect(documents.length).toBeGreaterThan(0);
    expect(ci.on.pull_request['paths-ignore']).toEqual(documents);
    expect(workflow('dependency-review.yml').on.pull_request['paths-ignore']).toEqual(documents);
  });

  it('reads the patterns as GitHub does', () => {
    expect(glob('docs/**').test('docs/notes/player.md')).toBe(true);
    expect(glob('README.md').test('native-host/README.md')).toBe(false);
    expect(glob('.github/ISSUE_TEMPLATE/**').test('.github/ISSUE_TEMPLATE/bug_report.md')).toBe(true);
  });

  it('takes in documents only: nothing the extension ships, nor the license the build copies', () => {
    expect(matched.length).toBeGreaterThan(0);
    for (const file of matched) {
      expect(file, file).not.toMatch(/^(chrome|native-host|patches|tests|tools|types)\//);
      expect(file, file).not.toMatch(/^\.github\/workflows\//);
      expect(file, file).not.toBe('LICENSE.md');
      expect(file, file).not.toBe('package.json');
    }
  });

  it('takes in no file a build, check or test reads', () => {
    // A document is named in messages and comments; a script that reads one gives it as an
    // argument (readFileSync('...md'), cat ...md) on the same line.
    const reads = /readFile|createReadStream|\bcat |\bsed |\bjq |\bgrep |\bawk |< /;
    const found = [];
    for (const [script, text] of scripts()) {
      for (const line of text.split('\n')) {
        if (/^\s*(#|\/\/|\*)/.test(line) || !reads.test(line)) continue;
        for (const file of matched) {
          // The whole path, or a root document by its name alone ('README.md', not 'x/README.md').
          const named = file.includes('/') ? line.includes(file) :
            line.trimStart().startsWith(file) || [' ', '\'', '"', '`', '('].some((before) => line.includes(before + file));
          if (named) {
            found.push(`${script}: ${file}: ${line.trim().slice(0, 160)}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
