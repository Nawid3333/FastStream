import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, it} from 'vitest';

import {addedLines, checkAdded, findings, isPublicIdentity, parseWords} from '../../tools/privacy-check.mjs';

// The repository is public: these rules decide what may go into it. A rule that misses lets
// something personal out; one that flags too much stops every commit, and gets switched off.

const rules = (text, words = []) => findings(text, words).map((found) => found.rule);

// The samples are put together here, never written out: written out, this file would be what
// the guard stops, before a commit and in CI's scan of every tracked file.
const MAIL = ['someone', 'gmail.com'].join('@');
const FOLDER = ['C:', 'Users', 'someone'].join('\\');
const CLAUDE = ['claude', 'ai'].join('.');

describe('findings', () => {
  it('flags a user folder path, in either slash and any case, but not a placeholder folder', () => {
    expect(rules(`cd ${FOLDER}\\Downloads`)).toEqual(['a user folder path']);
    expect(rules(`file:///${FOLDER.toLowerCase().replaceAll('\\', '/')}/x.mp4`)).toEqual(['a user folder path']);
    expect(rules('C:\\Users\\<name>\\AppData, C:/Users/x/secret.txt, C:\\Users\\%USERNAME%')).toEqual([]);
    expect(rules('file:///C:/Users/victim/private.mp4 and C:\\Users\\José')).toEqual([]);
  });

  it('flags a private claude.ai link, not claude.ai itself', () => {
    expect(rules(`https://${CLAUDE}/code/artifact/830a4dd8`)).toEqual(['a private claude.ai link']);
    expect(rules(`see https://${CLAUDE}/share/abc`)).toEqual(['a private claude.ai link']);
    expect(rules('made with https://claude.ai')).toEqual([]);
  });

  it('flags an e-mail address, not a noreply or public one', () => {
    expect(rules(`mail me: ${MAIL}`)).toEqual(['an e-mail address']);
    expect(rules('Co-Authored-By: Claude <noreply@anthropic.com>')).toEqual([]);
    expect(rules('102778966+Nawid3333@users.noreply.github.com, noreply@github.com')).toEqual([]);
    expect(rules('uBlock0@raymondhill.net release@mozilla.com Andrews54757@gmail.com')).toEqual([]);
  });

  it('takes no package version, file or URL user name for an address', () => {
    expect(rules('patches/hls.js@1.7.3.patch, Coloris@0.25.0.patch, n@Nawid3333.e2e.mjs')).toEqual([]);
    expect(rules('\'https://pass@player.vimeo.com/video/1\'')).toEqual([]);
    expect(rules('name@test.invalid vpn-sim@faststream.test player.vimeo.com@evil.example a@example.com')).toEqual([]);
  });

  it('flags a private word anywhere in a line, in any case', () => {
    expect(findings('a path under V:\\My Private Folder\\x', ['my private folder'])).toEqual([
      {line: 1, rule: 'a private word', text: 'my private folder'},
    ]);
    expect(rules('nothing here', ['Folder'])).toEqual([]);
  });

  it('numbers the lines it flags', () => {
    expect(findings(`one\ntwo ${MAIL}\nthree`, []).map((found) => found.line)).toEqual([2]);
  });
});

describe('parseWords', () => {
  it('trims each word and drops blank lines and comments', () => {
    expect(parseWords('# a comment\r\n  Some Name \n\nother\n')).toEqual(['Some Name', 'other']);
  });
});

describe('isPublicIdentity', () => {
  it('takes a GitHub noreply address whose name is its login, and Claude', () => {
    expect(isPublicIdentity('Nawid3333 <102778966+Nawid3333@users.noreply.github.com>')).toBe(true);
    expect(isPublicIdentity('github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com> 1700000000 +0000')).toBe(true);
    expect(isPublicIdentity('Claude <noreply@anthropic.com>')).toBe(true);
  });

  it('refuses a real name, a real address, a mismatched login and a noreply address without its id', () => {
    expect(isPublicIdentity('Some Person <102778966+Nawid3333@users.noreply.github.com>')).toBe(false);
    expect(isPublicIdentity(`Nawid3333 <${MAIL}>`)).toBe(false);
    expect(isPublicIdentity('Nawid3333 <Nawid3333@users.noreply.github.com>')).toBe(false);
    expect(isPublicIdentity('Someone <noreply@anthropic.com>')).toBe(false);
  });
});

describe('addedLines and checkAdded', () => {
  const diff = [
    'diff --git a/docs/a.md b/docs/a.md',
    '--- a/docs/a.md',
    '+++ b/docs/a.md',
    '@@ -3,0 +4,2 @@',
    '+fine',
    `+mail ${MAIL}`,
  ].join('\n');

  it('places each added line in its file', () => {
    expect(addedLines(diff)).toEqual([{file: 'docs/a.md', line: 4, text: 'fine'}, {file: 'docs/a.md', line: 5, text: `mail ${MAIL}`}]);
  });

  it('quotes what it found only when asked: an Actions log is public', () => {
    expect(checkAdded(addedLines(diff), [], [], true)).toEqual([`docs/a.md:5: an e-mail address: ${MAIL}`]);
    expect(checkAdded(addedLines(diff), [], [], false)).toEqual(['docs/a.md:5: an e-mail address']);
    expect(checkAdded([], ['docs/my-secret.md'], ['secret'], false)).toEqual(['the file name (not shown): a private word']);
  });
});

describe('the commit guard in a clone', () => {
  const script = path.resolve('tools/privacy-check.mjs');
  /** @type {string[]} */
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true});
  });

  /** A clone with this script, a public identity and a private word list. */
  const clone = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'privacy-'));
    dirs.push(dir);
    const git = (...args) => execFileSync('git', args, {cwd: dir, encoding: 'utf8'});
    git('init', '-q');
    git('config', 'user.name', 'Nawid3333');
    git('config', 'user.email', '102778966+Nawid3333@users.noreply.github.com');
    fs.mkdirSync(path.join(dir, 'tools'));
    fs.copyFileSync(script, path.join(dir, 'tools', 'privacy-check.mjs'));
    fs.writeFileSync(path.join(dir, '.git', 'info', 'private-words'), 'Secret Show\n');
    return {dir, git};
  };
  const staged = (dir) => {
    try {
      execFileSync(process.execPath, ['tools/privacy-check.mjs', 'staged'], {cwd: dir, encoding: 'utf8', stdio: 'pipe'});
      return {code: 0, err: ''};
    } catch (error) {
      return {code: error.status, err: String(error.stderr)};
    }
  };

  it('lets a clean commit through and refuses one with a private word, quoting it locally', () => {
    const {dir, git} = clone();
    fs.writeFileSync(path.join(dir, 'a.md'), 'nothing personal\n');
    git('add', 'a.md');
    expect(staged(dir)).toEqual({code: 0, err: ''});
    fs.writeFileSync(path.join(dir, 'a.md'), 'nothing personal\nwatched secret show again\n');
    git('add', 'a.md');
    const result = staged(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('a.md:2: a private word: secret show');
  });

  it('refuses an identity that names someone', () => {
    const {dir, git} = clone();
    git('config', 'user.email', MAIL);
    fs.writeFileSync(path.join(dir, 'a.md'), 'x\n');
    git('add', 'a.md');
    const result = staged(dir);
    expect(result.code).toBe(1);
    expect(result.err).toContain('the author is not a public identity');
  });
});
