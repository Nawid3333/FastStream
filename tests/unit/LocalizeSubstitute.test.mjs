import {describe, expect, it} from 'vitest';
import {Localize} from '../../chrome/player/modules/Localize.mjs';

// The web build looks messages up itself (the extension asks chrome.i18n) and puts the
// substitutions in for $1, $2, ... itself too.

describe('Localize.substitute', () => {
  it('puts each substitution in for its placeholder', () => {
    expect(Localize.substitute('$1 gain is $2 dB ($3%)', ['Left', 3, 50])).toBe('Left gain is 3 dB (50%)');
  });

  it('takes a substitution as it is, $ patterns included', () => {
    // An error message or a host's reason can hold anything. String.replace read these as
    // patterns: "$&" became the placeholder itself, "$'" the rest of the message.
    expect(Localize.substitute('Error: $1!', ['a $& b'])).toBe('Error: a $& b!');
    expect(Localize.substitute('Error: $1!', [`a $' b`])).toBe(`Error: a $' b!`);
    expect(Localize.substitute('Error: $1!', ['a $1 b'])).toBe('Error: a $1 b!');
  });

  it('does not replace a placeholder that came in with an earlier substitution', () => {
    expect(Localize.substitute('$1 then $2', ['costs $2', 'more'])).toBe('costs $2 then more');
  });

  it('reads $10 as the tenth placeholder, not the first and a 0', () => {
    const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    expect(Localize.substitute('$10 $1', ten)).toBe('j a');
  });

  it('leaves a placeholder without a substitution, and every occurrence of one with it', () => {
    expect(Localize.substitute('$1 and $2', ['x'])).toBe('x and $2');
    expect(Localize.substitute('$1, $1', ['x'])).toBe('x, x');
    expect(Localize.substitute('no placeholders')).toBe('no placeholders');
  });
});
