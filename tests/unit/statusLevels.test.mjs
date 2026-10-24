import fs from 'node:fs';
import path from 'node:path';

import {describe, expect, it, vi} from 'vitest';

// The status line throws for a key it has no level for ("Unknown status level"), and the
// message never shows: the quality notice of the dropped-frames watch was such a key once,
// which its own tests did not see (they stand in for the status line). Every key the
// player's code gives it is one StatusManager registers.

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));

const {StatusManager, StatusTypes} = await import('../../chrome/player/ui/StatusManager.mjs');

const PLAYER = path.resolve(import.meta.dirname, '../../chrome/player');

/** @return {Array<string>} Every .mjs file under the player. */
function sources(dir = PLAYER) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'assets' ? [] : sources(file);
    return entry.name.endsWith('.mjs') ? [file] : [];
  });
}

describe('status levels', () => {
  it('has a level for every key the player sets a status message under', () => {
    const known = new StatusManager().statusMessages;
    const used = [];
    for (const file of sources()) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/setStatusMessage\(\s*(StatusTypes\.(\w+)|'([^']*)')/g)) {
        const key = match[2] ? StatusTypes[match[2]] : match[3];
        used.push({file: path.relative(PLAYER, file), key: key ?? match[1]});
      }
    }
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter(({key}) => !known.has(key))).toEqual([]);
  });
});
