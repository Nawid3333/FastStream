import crypto from 'node:crypto';
import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {MP4 as HlsMP4} from '../../chrome/player/modules/hls.mjs';

// The save's MP4 writer (chrome/player/modules/hls2mp4/MP4Generator.mjs) started as a copy of
// hls.js's (src/remux/mp4-generator.ts), and FastStream made it write a whole MP4 file: real
// sample tables, edit lists, no fragments, its own audio sample entries. What it still had
// unchanged from hls.js it takes from hls.js itself now, so hls.js's updates bring it: the
// video sample entries (hls2mp4, through FastStream's patch exporting hls.js's MP4) and the
// fragment boxes (the tests' fMP4 helper). This file covers the rest: an hls.js update that
// changes a function FastStream keeps its own version of fails here, in that update's own
// pull request, so a person looks at the change before it is merged.

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const HLS = '../../node_modules/hls.js/';

/**
 * A function's text, brace-matched from its declaration; null when it is not there once.
 * @param {string} source
 * @param {string} declaration - e.g. 'static box(' or 'export function normalizePts('.
 * @return {?string}
 */
function functionText(source, declaration) {
  const at = source.indexOf(declaration);
  if (at < 0 || source.indexOf(declaration, at + 1) >= 0) return null;
  let p = at + declaration.length;
  let paren = 1;
  while (paren > 0 && p < source.length) {
    if (source[p] === '(') paren++;
    else if (source[p] === ')') paren--;
    p++;
  }
  let depth = 0;
  for (let i = source.indexOf('{', p); i >= 0 && i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at, i + 1);
  }
  return null;
}

/**
 * A function's code without its comments, whitespace and trailing commas, hashed: a change
 * of formatting alone leaves it as it was.
 * @param {string} text
 * @return {string}
 */
const fingerprint = (text) => crypto.createHash('sha256').update(text.replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '').replace(/,([)\]}])/g, '$1')).digest('hex').slice(0, 16);

// hls.js's functions FastStream has its own version of, as of hls.js 1.7.4, when each was
// last compared with FastStream's. audioStsd is the part of mp4a, mp3 and ac3 that hls.js
// moved into a function of its own; FastStream's three still write it themselves.
const GENERATOR = {
  box: '3be95e4b86fb60e6', hdlr: 'e0c90bbc326316c4', mdhd: 'cdc3ba76159a22d0',
  mdia: '1b2a0acf2eff3569', minf: '80df4b37119d7aa3', moov: 'e3cd82b75009d3ea',
  mvhd: 'eb71215e0ff0e24b', sdtp: 'e0bb271ea9082074', stbl: '6f00621fe9a01568',
  stsd: '47fcef0672fd55e4', esds: '530e4a4eb388fe04', audioStsd: 'd692617b2bd3fee8',
  mp4a: '07823ba170ab3d48', mp3: 'c92031e440a9fffe', ac3: '692472637ae525b3',
  tkhd: '30f5e53f97cdd5f5', trak: '8afabf7b7534b8ee', initSegment: '2eeed446dd150342',
};
// hls.js's normalizePts (src/remux/mp4-remuxer.ts), which hls2mp4/ptsNormalize.mjs rewrites.
const NORMALIZE_PTS = '820954a4003e73d7';

/**
 * What to do when hls.js changed one of them.
 * @param {string} name
 * @param {string} where - FastStream's file.
 * @param {string} upstream - hls.js's file.
 * @return {string}
 */
const changed = (name, where, upstream) => `hls.js changed ${name} (${upstream}). FastStream has its own ` +
  `version of it, in ${where}. Compare hls.js's change (its release notes, or a diff of ${upstream} between ` +
  'the two versions) with FastStream\'s version: take it over where it applies to a whole MP4 file, or note ' +
  'why it does not (fragment-only, already handled). Then put the new fingerprint here, in the same pull request.';

describe('hls.js\'s MP4 writer, where FastStream keeps its own version', () => {
  const generator = read(HLS + 'src/remux/mp4-generator.ts');
  const ours = read('../../chrome/player/modules/hls2mp4/MP4Generator.mjs');

  for (const [name, pinned] of Object.entries(GENERATOR)) {
    it(`MP4.${name} is as when it was compared`, () => {
      const text = functionText(generator, `static ${name}(`);
      expect(text, `hls.js's src/remux/mp4-generator.ts no longer has one MP4.${name}: hls.js ` +
        'reorganised its writer, so this list needs comparing again').not.toBeNull();
      expect(fingerprint(/** @type {string} */ (text)), changed(`MP4.${name}`,
          'chrome/player/modules/hls2mp4/MP4Generator.mjs', 'src/remux/mp4-generator.ts')).toBe(pinned);
      if (name !== 'audioStsd') {
        // A pin for a function FastStream no longer has would guard nothing.
        expect(functionText(ours, `static ${name}(`), `MP4Generator.mjs has no ${name}: take it off this list`).not.toBeNull();
      }
    });
  }

  it('normalizePts is as when it was compared', () => {
    const text = functionText(read(HLS + 'src/remux/mp4-remuxer.ts'), 'export function normalizePts(');
    expect(text, 'hls.js\'s src/remux/mp4-remuxer.ts no longer has normalizePts').not.toBeNull();
    expect(fingerprint(/** @type {string} */ (text)), changed('normalizePts',
        'chrome/player/modules/hls2mp4/ptsNormalize.mjs', 'src/remux/mp4-remuxer.ts')).toBe(NORMALIZE_PTS);
  });
});

describe('what the save takes from hls.js\'s MP4 writer', () => {
  it('is exported by FastStream\'s patch to hls.js', () => {
    // hls2mp4 writes the video's sample entry with it; without it every HLS save fails.
    for (const name of ['avc1', 'hvc1', 'moof', 'mvex', 'mdat']) {
      expect(typeof HlsMP4?.[name], `hls.js's MP4.${name}: patches/hls.js@*.patch must export MP4`).toBe('function');
    }
  });

  it('is not loaded by a DASH save: only hls2mp4, whose transmuxer has hls.js already, imports it', () => {
    // The DASH and fMP4 saves (mp4merger) use MP4Generator and give every track its sample
    // entry: an import of hls.js there would load its 1.2 MB into every DASH save.
    for (const file of ['hls2mp4/MP4Generator.mjs', 'dash2mp4/mp4merger.mjs', 'dash2mp4/dash2mp4.mjs']) {
      expect(read(`../../chrome/player/modules/${file}`), file).not.toMatch(/from\s+['"][^'"]*hls\.mjs['"]/);
    }
  });
});
