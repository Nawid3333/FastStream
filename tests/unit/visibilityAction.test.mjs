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

describe('InterfaceController.handleVisibilityChange', () => {
  // VisChangeActions has no PIP (it is commented out there), so the switch's PIP case was a
  // `case undefined:` - an action that was not set entered picture-in-picture whenever the
  // page was hidden (the review of 2026-11-13). Each of the switch's cases must name an action
  // the list declares.
  const start = source.indexOf('  async handleVisibilityChange(isVisible) {');
  const end = source.indexOf('\n  }\n', start);
  const method = source.slice(start, end);
  const actions = fs.readFileSync(new URL('../../chrome/player/options/defaults/VisChangeActions.mjs', import.meta.url), 'utf8');
  // The declared ones, as `KEY: 'value',` lines; a commented-out one (// PIP: 'pip') is none.
  const declared = [...actions.matchAll(/^ {2}([A-Z_]+): '[a-z]+',$/gm)].map((match) => match[1]);

  it('has a case only for an action the list declares', () => {
    expect(start).toBeGreaterThan(-1);
    expect(declared).toEqual(['NOTHING', 'PLAY_PAUSE', 'MINI_PLAYER']);
    const cases = [...method.matchAll(/^\s*case ([^:]+):/gm)].map((match) => match[1].trim());
    expect(cases.length).toBeGreaterThan(0);
    for (const label of cases) {
      expect(label, label).toMatch(/^VisChangeActions\.[A-Z_]+$/);
      expect(declared, label).toContain(label.slice('VisChangeActions.'.length));
    }
  });
});
