import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {MessageTypes} from '../../chrome/player/enums/MessageTypes.mjs';

// content.js is a classic script and cannot import the MessageTypes enum, so it carries a
// copy of the types it uses. A type used there but missing from the copy is undefined, and
// `request.type === MessageTypes.X` then never matches: the message is silently dropped.
// A value that drifts from the enum does the same. This keeps the copy honest.

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../../chrome/content.js'), 'utf8');

/** @return {Object<string, string>} The copy's entries. */
function contentCopy() {
  const block = /const MessageTypes = \{([\s\S]*?)\};/.exec(source);
  if (!block) throw new Error('content.js has no MessageTypes block');
  return Object.fromEntries(Array.from(block[1].matchAll(/^\s*([A-Z_]+):\s*'([^']*)',?\s*$/gm),
      (match) => [match[1], match[2]]));
}

describe('content.js MessageTypes copy', () => {
  it('matches the MessageTypes enum', () => {
    const copy = contentCopy();
    // A pattern that stopped matching would make the checks below pass on nothing.
    expect(Object.keys(copy).length).toBeGreaterThanOrEqual(20);
    const drifted = Object.entries(copy).filter(([name, value]) => MessageTypes[name] !== value);
    expect(drifted).toEqual([]);
  });

  it('defines every type content.js uses', () => {
    const copy = contentCopy();
    const used = new Set(Array.from(source.matchAll(/\bMessageTypes\.([A-Z_]+)\b/g), (match) => match[1]));
    expect(used.size).toBeGreaterThanOrEqual(20);
    expect([...used].filter((name) => !(name in copy))).toEqual([]);
  });
});
