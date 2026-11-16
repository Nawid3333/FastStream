import fs from 'node:fs';

import * as acorn from 'acorn';
import {describe, expect, it} from 'vitest';

import {errorReportURL, errorTitleText} from '../../chrome/player/utils/AlertPolyfill.mjs';

// The player's dialogs and toasts (AlertPolyfill): Firefox's own <dialog> and popover since
// sweetalert2 left (2026-10-09). What they show is opened and clicked in Firefox by
// tests/e2e/specs/dialogs.e2e.mjs; this checks what does not need a page.

const source = fs.readFileSync(new URL('../../chrome/player/utils/AlertPolyfill.mjs', import.meta.url), 'utf8');

describe('AlertPolyfill', () => {
  it('puts every text in as text, never as markup', () => {
    // The error dialog's title is the caught error's message, which can quote what the code
    // failed on (a URL, a file's text): markup in it was rendered once, an <img> loaded (#186).
    const writes = [];
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.type === 'MemberExpression' && !node.computed &&
          ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'srcdoc', 'createContextualFragment', 'write'].includes(node.property.name)) {
        writes.push(node.property.name);
      }
      if (node.type === 'Identifier' && node.name === 'DOMParser') writes.push('DOMParser');
      for (const key of Object.keys(node)) {
        if (key !== 'start' && key !== 'end') walk(node[key]);
      }
    };
    walk(acorn.parse(source, {ecmaVersion: 'latest', sourceType: 'module'}));
    expect(writes).toEqual([]);
    expect(source).toMatch(/element\.textContent = String\(text\)/);
  });

  it('reports an error to a new GitHub issue with the version, the message and the stack', () => {
    const error = new Error('Bad <b>thing</b> & more');
    error.stack = 'Error: Bad thing\n    at play (FastStreamClient.mjs:1:2)';
    const url = new URL(errorReportURL(error, '1.3.82.72'));
    expect(url.origin + url.pathname).toBe('https://github.com/Nawid3333/FastStream/issues/new');
    expect(url.searchParams.get('title')).toBe('Error report');
    expect(url.searchParams.get('body')).toBe('## Version:\n1.3.82.72\n\n## Error message:\nBad <b>thing</b> & more\n\n' +
      '## Stack trace:\n```\nError: Bad thing\n    at play (FastStreamClient.mjs:1:2)\n```');
  });

  it('clips a deep stack, so the issue\'s address stays within what GitHub takes, and names no install', () => {
    // glm's review, 2026-11-16: the stack went in whole, and GitHub refused the address (414).
    const error = new Error('Deep');
    error.stack = Array.from({length: 400}, (_, i) =>
      `    at step${i} (moz-extension://0a1b2c3d-1111-2222-3333-444455556666/player/FastStreamClient.mjs:${i}:2)`).join('\n');
    const url = errorReportURL(error, '1.0');
    expect(url.length).toBeLessThan(8000);
    expect(url).not.toContain('0a1b2c3d');
    expect(new URL(url).searchParams.get('body')).toContain('at step0 (moz-extension://.../player/FastStreamClient.mjs:0:2)');
  });

  // Claude's review of #714: a cut through an emoji, or a lone surrogate in what was thrown,
  // made encodeURIComponent throw; and 3000 characters of non-Latin text were 27 kB of address.
  it('reports any text, cut or not, in an address GitHub takes', () => {
    const emoji = new Error('bad \uD83D');
    emoji.stack = 'x'.repeat(2999) + '🎬'.repeat(2000);
    const url = errorReportURL(emoji, '1.0');
    expect(url.length).toBeLessThan(8000);
    expect(new URL(url).searchParams.get('body')).toContain('## Error message:\nbad �\n');

    const wide = new Error('中'.repeat(1000));
    wide.stack = '中文 '.repeat(3000);
    const wideUrl = errorReportURL(wide, '1.0');
    expect(wideUrl.length).toBeLessThan(8000);
    expect(new URL(wideUrl).searchParams.get('body')).toMatch(/中\.\.\.\n/);
  });

  // The dialog's title was "Error: undefined" for anything but an Error.
  it('names in the dialog\'s title what was thrown, whatever it is', () => {
    expect(errorTitleText(new Error('It broke'))).toBe('It broke');
    expect(errorTitleText('just a string')).toBe('just a string');
    expect(errorTitleText({type: 'networkError', details: 'fragLoadError'})).toBe('{"type":"networkError","details":"fragLoadError"}');
    expect(errorTitleText('x'.repeat(300))).toBe('x'.repeat(200) + '...');
    // No message: the title said "{}".
    expect(errorTitleText(new Error())).toBe('Error');
    expect(errorTitleText(new DOMException('', 'AbortError'))).toBe('AbortError');
  });

  it('reports what was thrown when it is no Error', () => {
    const url = new URL(errorReportURL('just a string', '1.0'));
    expect(url.searchParams.get('body')).toContain('## Error message:\njust a string\n');
    expect(url.searchParams.get('body')).toContain('No stack trace');
  });

  // hls.js and dash.js report errors as plain objects: the report said "[object Object]"
  // (audit, 2026-10-09).
  it('reports a plain object\'s fields, and copes with a cycle', () => {
    const url = new URL(errorReportURL({type: 'networkError', details: 'fragLoadError', fatal: true}, '1.0'));
    expect(url.searchParams.get('body')).toContain('## Error message:\n{"type":"networkError","details":"fragLoadError","fatal":true}\n');
    const cyclic = {type: 'mediaError'};
    cyclic.self = cyclic;
    expect(new URL(errorReportURL(cyclic, '1.0')).searchParams.get('body')).toContain('## Error message:\n[object Object]\n');
    for (const error of [{data: 'x'.repeat(5000)}, new Error('x'.repeat(5000))]) {
      error.stack = undefined;
      expect(new URL(errorReportURL(error, '1.0')).searchParams.get('body').length).toBeLessThan(1200);
    }
  });
});
