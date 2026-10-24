import {describe, expect, it} from 'vitest';

import {relabelEsdsAacLayout, windowsAacLayout} from '../../chrome/player/players/mp4/AacLayout.mjs';

// AAC with a channel layout of its own (a PCE) that Windows' decoder takes and gives nothing back
// for: a film on a film site's hoster sat at 0:00 for good. The configs below are the real ones:
// the film's (Lavc62.4.100), and a 6.0 track a 2026 ffmpeg writes (Lavc62.30.100). What decodes after
// the relabelling was measured in Firefox 157 through WebCodecs (AacLayout.mjs).

const hex = (text) => Uint8Array.from(Buffer.from(text, 'hex'));
const asHex = (bytes) => bytes && Buffer.from(bytes).toString('hex');

// AAC LC, 44.1 kHz, channelConfiguration 0. PCE: front CPE 0, SCE 0; side SCE 1; back CPE 1;
// comment "Lavc62.4.100"; then the SBR sync extension (0x2b7, none present).
const FILM = '1200050844002000c40c4c61766336322e342e31303056e500';
// The same elements relabelled: front SCE 0, CPE 0; back CPE 1, SCE 1. Nothing else changes.
const FILM_RELABELLED = '1200050808000108840c4c61766336322e342e31303056e500';
// That ffmpeg's 6.0: front CPE 0, SCE 0; side CPE 1; back SCE 1.
const FFMPEG_6_0 = '1200050844002008840d4c61766336322e33302e31303056e500';
// Front SCE 0, CPE 0; side CPE 1; back SCE 1.
const FFMPEG_6_0_RELABELLED = '1200050844000108840d4c61766336322e33302e31303056e500';

/**
 * The PCE's element groups, read back.
 * @param {string} text - An AudioSpecificConfig as hex.
 * @return {Object<string, string[]>}
 */
function groups(text) {
  const bytes = hex(text);
  let pos = 16 + 10; // the 2-byte header with the GASpecificConfig; tag, object type, rate
  const read = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++, pos++) value = (value << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    return value;
  };
  const counts = [read(4), read(4), read(4)];
  read(2 + 3 + 4 + 1 + 1 + 1);
  const result = {};
  ['front', 'side', 'back'].forEach((name, i) => {
    result[name] = [];
    for (let n = 0; n < counts[i]; n++) result[name].push((read(1) ? 'CPE' : 'SCE') + read(4));
  });
  return result;
}

describe('windowsAacLayout', () => {
  it('puts the front centre first and a lone side channel at the back centre (the film)', () => {
    expect(groups(FILM)).toEqual({front: ['CPE0', 'SCE0'], side: ['SCE1'], back: ['CPE1']});
    const relabelled = asHex(windowsAacLayout(hex(FILM)));
    expect(relabelled).toBe(FILM_RELABELLED);
    expect(groups(relabelled)).toEqual({front: ['SCE0', 'CPE0'], side: [], back: ['CPE1', 'SCE1']});
  });

  it('puts the front centre first in the 6.0 ffmpeg writes now', () => {
    expect(asHex(windowsAacLayout(hex(FFMPEG_6_0)))).toBe(FFMPEG_6_0_RELABELLED);
    expect(groups(FFMPEG_6_0_RELABELLED)).toEqual({front: ['SCE0', 'CPE0'], side: ['CPE1'], back: ['SCE1']});
  });

  it('keeps the length, the comment and what follows the PCE', () => {
    const relabelled = windowsAacLayout(hex(FILM));
    expect(relabelled.length).toBe(hex(FILM).length);
    expect(asHex(relabelled).slice(20)).toBe(FILM.slice(20));
  });

  it('leaves the layouts Windows decodes as they are', () => {
    // Stereo and 5.1 by channel configuration, a stereo PCE, and the two relabelled 6.0 shapes.
    for (const text of ['121056e500', '123056e500', '1200050400002000', FILM_RELABELLED, FFMPEG_6_0_RELABELLED]) {
      expect(windowsAacLayout(hex(text))).toBe(null);
    }
  });

  it('leaves what it was not measured for: HE-AAC, two side singles, a back centre already there', () => {
    // HE-AAC (object type 5), 44.1 kHz, channelConfiguration 0.
    expect(windowsAacLayout(hex('2a00050844002000c400'))).toBe(null);
    // Front SCE 0, CPE 0; side SCE 1, SCE 2; back CPE 1.
    expect(windowsAacLayout(hex('12000508840001008a2000'))).toBe(null);
    // Front CPE 0, SCE 0; side SCE 1; back SCE 2: a lone side channel, and the back centre taken.
    expect(windowsAacLayout(hex('12000508440020008800'))).toBe(null);
  });

  it('gives up on a config shorter than its PCE says', () => {
    expect(windowsAacLayout(hex(FILM.slice(0, 14)))).toBe(null);
    expect(windowsAacLayout(new Uint8Array(0))).toBe(null);
  });
});

describe('relabelEsdsAacLayout', () => {
  // The film's esds box content (mp4box's esds.data): ES_Descriptor, DecoderConfigDescriptor
  // (MPEG-4 audio), DecoderSpecificInfo (the config), SLConfigDescriptor.
  const ESD = '0380808039000200048080802b40150000000002f1aa0002f1aa0580808019' + FILM + '068080800102';

  it('relabels the config inside the box, in place, once', () => {
    const esd = hex(ESD);
    expect(relabelEsdsAacLayout(esd)).toBe(true);
    expect(asHex(esd)).toBe(ESD.replace(FILM, FILM_RELABELLED));
    expect(relabelEsdsAacLayout(esd)).toBe(false);
  });

  it('reads one-byte descriptor lengths and the ES_Descriptor\'s optional fields', () => {
    // Lengths in one byte, and a streamDependenceFlag with its 2-byte ES_ID.
    const info = '05' + (FILM.length / 2).toString(16) + FILM;
    const content = '40150000000002f1aa0002f1aa' + info;
    const config = '04' + (content.length / 2).toString(16) + content;
    const body = '0002' + '80' + '0003' + config;
    const esd = hex('03' + (body.length / 2).toString(16) + body);
    expect(relabelEsdsAacLayout(esd)).toBe(true);
    expect(asHex(esd)).toContain(FILM_RELABELLED);
  });

  it('leaves other streams alone', () => {
    // objectTypeIndication 0x6B: MP3.
    const mp3 = hex(ESD.replace('2b40', '2b6b'));
    expect(relabelEsdsAacLayout(mp3)).toBe(false);
    expect(asHex(mp3)).toBe(ESD.replace('2b40', '2b6b'));
    expect(relabelEsdsAacLayout(hex('0400'))).toBe(false);
    expect(relabelEsdsAacLayout(hex(ESD.slice(0, 60)))).toBe(false);
  });
});
