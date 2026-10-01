import fs from 'node:fs';
import {describe, expect, it} from 'vitest';

// content.js runs in every page, which can go away while a message to the background is
// on its way. A chrome.runtime.sendMessage with no callback returns a promise, which then
// rejects ("Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved"), and
// unhandled it reached the page's console as an error and failed content-cleanup's Back
// case on Windows. Every message there either has a callback (Firefox then reports the
// failure through chrome.runtime.lastError) or goes through notifyBackground, which
// catches it. The promise/catch-or-return lint rule only sees .then() chains, not a
// promise left on its own, so this checks the source.

const source = fs.readFileSync(new URL('../../chrome/content.js', import.meta.url), 'utf8');

/**
 * The calls of a function in a source text: their arguments at the top level, and what
 * follows each call.
 * @param {string} text - The source.
 * @param {string} callee - What is called, e.g. 'chrome.runtime.sendMessage('.
 * @return {Array<{line: number, args: string[], after: string}>}
 */
function calls(text, callee) {
  const found = [];
  for (let at = text.indexOf(callee); at !== -1; at = text.indexOf(callee, at + 1)) {
    const args = [];
    let depth = 0;
    let arg = '';
    let i = at + callee.length;
    for (; i < text.length; i++) {
      const c = text[i];
      if (c === '\'' || c === '"' || c === '`') {
        const end = text.indexOf(c, i + 1);
        arg += text.slice(i, end + 1);
        i = end;
        continue;
      }
      if (depth === 0 && c === ')') break;
      if (depth === 0 && c === ',') {
        args.push(arg.trim());
        arg = '';
        continue;
      }
      if ('([{'.includes(c)) depth++;
      if (')]}'.includes(c)) depth--;
      arg += c;
    }
    if (arg.trim()) args.push(arg.trim());
    found.push({line: text.slice(0, at).split('\n').length, args, after: text.slice(i + 1, i + 9)});
  }
  return found;
}

describe('content.js messages to the background', () => {
  const sends = calls(source, 'chrome.runtime.sendMessage(');

  it('are found', () => {
    expect(sends.length).toBeGreaterThan(3);
  });

  it('each have a callback, or go through notifyBackground, which catches', () => {
    const bare = sends.filter(({args, after}) => args.length < 2 && !after.startsWith('.catch('));
    expect(bare.map(({line}) => `content.js:${line}`)).toEqual([]);
  });

  it('notifyBackground catches, and is used', () => {
    const caught = sends.filter(({after}) => after.startsWith('.catch('));
    expect(caught).toHaveLength(1);
    expect(source).toMatch(/function notifyBackground\(message\) \{\s+chrome\.runtime\.sendMessage\(message\)\.catch\(/);
    expect(calls(source, 'notifyBackground(').length).toBeGreaterThan(1);
  });
});
