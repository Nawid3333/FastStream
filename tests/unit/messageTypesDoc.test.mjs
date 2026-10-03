import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// types/messages.d.ts documents the messages between the player and the background. Nothing
// in the code names these interfaces, so tsc cannot notice when a message gains a field:
// FSMpvOpen lacked the contentType, startTime and subtitles the player sends.

const root = path.resolve(import.meta.dirname, '../..');
const types = fs.readFileSync(path.join(root, 'types/messages.d.ts'), 'utf8');

/**
 * @param {string} name - An interface in types/messages.d.ts.
 * @return {string[]} Its fields, optional or not.
 */
function interfaceFields(name) {
  const block = new RegExp(`interface ${name} extends FSMessageBase \\{([\\s\\S]*?)\\n\\}`).exec(types);
  if (!block) throw new Error(`no interface ${name}`);
  return [...block[1].matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1]);
}

describe('types/messages.d.ts', () => {
  it('FSMpvOpen has every field the player\'s MPV_OPEN message carries', () => {
    const source = fs.readFileSync(path.join(root, 'chrome/player/ui/SaveManager.mjs'), 'utf8');
    const message = /sendMessage\(\{\s*type: MessageTypes\.MPV_OPEN,([\s\S]*?)\}, \(response\)/.exec(source);
    expect(message).not.toBeNull();
    const sent = [...message[1].matchAll(/^\s+(\w+):/gm)].map((match) => match[1]);
    expect(sent.length).toBeGreaterThanOrEqual(5);
    const fields = interfaceFields('FSMpvOpen');
    expect(sent.filter((field) => !fields.includes(field))).toEqual([]);
  });
});
