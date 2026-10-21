import fs from 'node:fs';
import {describe, expect, it} from 'vitest';

// The visibility actions (a play the browser blocks, picture-in-picture with no click behind
// it) rejected at every tab change with nothing to hear it (glm's review, 2026-10-22).
// InterfaceController cannot be imported in Node (its UI touches the DOM at module scope),
// so its source is read.
const source = fs.readFileSync(new URL('../../chrome/player/ui/InterfaceController.mjs', import.meta.url), 'utf8');

describe('InterfaceController, the visibility action', () => {
  it('runs only through visibilityChanged, which hears its failure', () => {
    const calls = [...source.matchAll(/this\.handleVisibilityChange\([^)]*\)/g)].map((match) => match[0]);
    expect(calls).toEqual(['this.handleVisibilityChange(isVisible)']);
    expect(source).toMatch(/visibilityChanged\(isVisible\) \{\s*this\.handleVisibilityChange\(isVisible\)\.catch\(/);
  });
});
