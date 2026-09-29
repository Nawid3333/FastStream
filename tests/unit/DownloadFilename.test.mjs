import {describe, expect, it} from 'vitest';

import {sanitizeDownloadFilename} from '../../chrome/background/DownloadFilename.mjs';

describe('sanitizeDownloadFilename', () => {
  describe('rule 1: refused characters become "_"', () => {
    it('replaces the colon in a screenshot name', () => {
      expect(sanitizeDownloadFilename('Show@00:05.png')).toBe('Show@00_05.png');
    });

    it('replaces each refused punctuation character', () => {
      expect(sanitizeDownloadFilename('what?.txt')).toBe('what_.txt');
      expect(sanitizeDownloadFilename('a*b.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a"b.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a<b.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a>b.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a|b.txt')).toBe('a_b.txt');
    });

    it('replaces "/" so a title like AC/DC does not become a folder', () => {
      expect(sanitizeDownloadFilename('AC/DC live.mp4')).toBe('AC_DC live.mp4');
    });

    it('replaces "/" in a relative path the same way', () => {
      expect(sanitizeDownloadFilename('sub/dir.txt')).toBe('sub_dir.txt');
    });

    it('replaces "\\" so "sub\\dir.txt" stays one file, not a folder', () => {
      expect(sanitizeDownloadFilename('sub\\dir.txt')).toBe('sub_dir.txt');
    });

    it('replaces control characters, including the refused tab', () => {
      expect(sanitizeDownloadFilename('a\tb.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a\u0000b.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a\u001Fb.txt')).toBe('a_b.txt');
      expect(sanitizeDownloadFilename('a\u007Fb.txt')).toBe('a_b.txt');
    });
  });

  describe('rule 2: invisible, direction and unusual space characters', () => {
    it('removes the refused invisible and direction characters', () => {
      expect(sanitizeDownloadFilename('na\u200Bme.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\u200Fme.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\u202Ame.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\u202Eme.exe')).toBe('name.exe');
      expect(sanitizeDownloadFilename('na\u2060me.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\u2064me.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\u2066me.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\u2069me.txt')).toBe('name.txt');
      expect(sanitizeDownloadFilename('na\uFEFFme.txt')).toBe('name.txt');
    });

    it('turns the other space characters into ordinary spaces', () => {
      expect(sanitizeDownloadFilename('a\u00A0b.txt')).toBe('a b.txt');
      expect(sanitizeDownloadFilename('a\u2003b.txt')).toBe('a b.txt');
      expect(sanitizeDownloadFilename('a\u202Fb.txt')).toBe('a b.txt');
      expect(sanitizeDownloadFilename('a\u205Fb.txt')).toBe('a b.txt');
      expect(sanitizeDownloadFilename('a\u3000b.txt')).toBe('a b.txt');
    });
  });

  describe('rule 3: trims only the edges of the name', () => {
    it('removes a leading space', () => {
      expect(sanitizeDownloadFilename(' lead.txt')).toBe('lead.txt');
    });

    it('removes trailing dots', () => {
      expect(sanitizeDownloadFilename('ends.')).toBe('ends');
    });

    it('removes a trailing mix of dots and spaces', () => {
      expect(sanitizeDownloadFilename('ends. ')).toBe('ends');
      expect(sanitizeDownloadFilename('ends .')).toBe('ends');
      expect(sanitizeDownloadFilename('end.txt ')).toBe('end.txt');
    });

    it('keeps spaces and dots inside the name', () => {
      expect(sanitizeDownloadFilename('mid dle.txt')).toBe('mid dle.txt');
    });
  });

  describe('rule 4: Windows device names', () => {
    it('prefixes refused device names, in any case', () => {
      expect(sanitizeDownloadFilename('con.txt')).toBe('_con.txt');
      expect(sanitizeDownloadFilename('CON')).toBe('_CON');
      expect(sanitizeDownloadFilename('Prn.mp4')).toBe('_Prn.mp4');
      expect(sanitizeDownloadFilename('aux.png')).toBe('_aux.png');
      expect(sanitizeDownloadFilename('nul.txt')).toBe('_nul.txt');
      expect(sanitizeDownloadFilename('com1.txt')).toBe('_com1.txt');
      expect(sanitizeDownloadFilename('COM9.wav')).toBe('_COM9.wav');
      expect(sanitizeDownloadFilename('lpt3.txt')).toBe('_lpt3.txt');
      expect(sanitizeDownloadFilename('LPT7.txt')).toBe('_LPT7.txt');
      expect(sanitizeDownloadFilename('con.')).toBe('_con');
    });

    it('leaves names that only look like device names', () => {
      expect(sanitizeDownloadFilename('conman.txt')).toBe('conman.txt');
      expect(sanitizeDownloadFilename('com10.txt')).toBe('com10.txt');
      expect(sanitizeDownloadFilename('auxiliary.txt')).toBe('auxiliary.txt');
    });
  });

  describe('rule 5: at most 200 characters', () => {
    it('shortens a 300-character name but keeps ".mp4"', () => {
      const result = sanitizeDownloadFilename('v'.repeat(296) + '.mp4');
      expect(result).toBe('v'.repeat(196) + '.mp4');
      expect(result.length).toBe(200);
    });

    it('keeps an extension of exactly 10 characters', () => {
      const result = sanitizeDownloadFilename('b'.repeat(300) + '.abcdefghij');
      expect(result).toBe('b'.repeat(189) + '.abcdefghij');
      expect(result.length).toBe(200);
    });

    it('does not keep an extension longer than 10 characters', () => {
      expect(sanitizeDownloadFilename('a'.repeat(200) + '.longextension')).toBe('a'.repeat(200));
    });

    it('does not keep an extension containing a space, and trims the space the cut leaves', () => {
      expect(sanitizeDownloadFilename('a'.repeat(196) + '.tx t')).toBe('a'.repeat(196) + '.tx');
    });

    it('trims a dot the cut leaves at the end', () => {
      expect(sanitizeDownloadFilename('a'.repeat(199) + '.bcdefghijkl')).toBe('a'.repeat(199));
    });

    it('shortens a long name without an extension to 200 characters', () => {
      expect(sanitizeDownloadFilename('a'.repeat(250)).length).toBe(200);
    });

    it('keeps a name of exactly 200 characters as it is', () => {
      expect(sanitizeDownloadFilename('a'.repeat(200))).toBe('a'.repeat(200));
    });

    it('does not cut a surrogate pair in half', () => {
      const name = 'x' + '\u{1F3AC}'.repeat(100);
      const result = sanitizeDownloadFilename(name);
      expect(result.length).toBe(199);
      expect(Array.from(result).length).toBe(100);
    });
  });

  describe('rule 6: fallback when nothing usable is left', () => {
    it('returns "download" for a non-string', () => {
      expect(sanitizeDownloadFilename(null)).toBe('download');
      expect(sanitizeDownloadFilename(undefined)).toBe('download');
      expect(sanitizeDownloadFilename(42)).toBe('download');
    });

    it('returns "download" when nothing is left', () => {
      expect(sanitizeDownloadFilename('')).toBe('download');
      expect(sanitizeDownloadFilename('   ')).toBe('download');
      expect(sanitizeDownloadFilename('.')).toBe('download');
      expect(sanitizeDownloadFilename('\u200B\uFEFF')).toBe('download');
    });

    it('keeps the extension when falling back', () => {
      expect(sanitizeDownloadFilename('\u00A0.webm')).toBe('download.webm');
      expect(sanitizeDownloadFilename('   .png')).toBe('download.png');
    });
  });

  describe('rule 7: leaves everything else as it is', () => {
    it('keeps the names Firefox already accepts', () => {
      expect(sanitizeDownloadFilename('shot 00 05.png')).toBe('shot 00 05.png');
      expect(sanitizeDownloadFilename('two  spaces.txt')).toBe('two  spaces.txt');
      expect(sanitizeDownloadFilename('trail .txt')).toBe('trail .txt');
      expect(sanitizeDownloadFilename('dots..txt')).toBe('dots..txt');
      expect(sanitizeDownloadFilename('ümlaut.txt')).toBe('ümlaut.txt');
      expect(sanitizeDownloadFilename('\u{1F3AC} clip.webm')).toBe('\u{1F3AC} clip.webm');
    });

    it('keeps punctuation the player may use', () => {
      expect(sanitizeDownloadFilename('#')).toBe('#');
      expect(sanitizeDownloadFilename('&')).toBe('&');
      expect(sanitizeDownloadFilename('~')).toBe('~');
      expect(sanitizeDownloadFilename('100%.txt')).toBe('100%.txt');
      expect(sanitizeDownloadFilename('a@b(1) [x]\', demo.txt')).toBe('a@b(1) [x]\', demo.txt');
    });
  });
});
