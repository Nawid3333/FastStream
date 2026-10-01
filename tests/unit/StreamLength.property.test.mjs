import {describe, expect, it} from 'vitest';
import fc from 'fast-check';

import {STILLS_LENGTH, StreamLength} from '../../chrome/player/utils/StreamLength.mjs';

// The manifest parsers decide how long a page's stream plays, and so whether
// FastStream accelerates it. They are fed whatever a page's JavaScript
// produces, so the property tests pin three things: a playlist built from
// generated segment durations adds up to their sum, a manifest generated from
// numbers parses back to those numbers, and arbitrary text parses to nothing
// or to something sane -- never a throw, a NaN, or a bogus negative. The one
// negative these string parsers can return is the module's own named constant
// STILLS_LENGTH (UNKNOWN_LENGTH_S and PIECE_LENGTH belong to
// fromFile/rankLength, which never run here).

const segmentDuration = fc.nat({max: 3600000}).map((ms) => (ms + 1) / 1000); // 0.001..3600.001 s

function mediaPlaylist(durations, {type = null, endlist = true} = {}) {
  const lines = ['#EXTM3U'];
  if (type !== null) {
    lines.push('#EXT-X-PLAYLIST-TYPE:' + type);
  }
  durations.forEach((d, i) => lines.push('#EXTINF:' + String(d), 'seg' + i + '.ts'));
  if (endlist) {
    lines.push('#EXT-X-ENDLIST');
  }
  return lines.join('\n');
}

describe('StreamLength.fromHls', () => {
  it('adds up the EXTINF durations of a generated VOD playlist to their sum, within float tolerance', () => {
    fc.assert(fc.property(fc.array(segmentDuration, {minLength: 1, maxLength: 20}), (durations) => {
      const result = StreamLength.fromHls(mediaPlaylist(durations, {type: 'VOD'}));
      const expected = durations.reduce((sum, d) => sum + d, 0);
      expect(result).not.toBeNull();
      expect(Math.abs(result.duration - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, expected));
    }), {numRuns: 200});
  });

  it('reads a single generated EXTINF duration back as exactly the number written', () => {
    fc.assert(fc.property(segmentDuration, (d) => {
      const result = StreamLength.fromHls(mediaPlaylist([d]));
      expect(result.duration).toBe(d);
    }), {numRuns: 200});
  });

  it('reports Infinity for a generated live playlist: segments with neither an end tag nor a VOD type', () => {
    // Line 97: no ENDLIST and no VOD marker means live.
    fc.assert(fc.property(fc.array(segmentDuration, {minLength: 1, maxLength: 20}), (durations) => {
      const result = StreamLength.fromHls(mediaPlaylist(durations, {endlist: false}));
      expect(result).not.toBeNull();
      expect(result.duration).toBe(Infinity);
    }), {numRuns: 200});
  });

  it('returns STILLS_LENGTH wherever an images-only or keyframes-only tag sits among the segments', () => {
    // Lines 73-75: the tag short-circuits the whole scan, wherever it appears.
    fc.assert(fc.property(
        fc.array(segmentDuration, {minLength: 1, maxLength: 20}),
        fc.nat({max: 63}),
        fc.constantFrom('#EXT-X-IMAGES-ONLY', '#EXT-X-I-FRAMES-ONLY'),
        (durations, where, tag) => {
          const lines = mediaPlaylist(durations).split('\n');
          lines.splice(1 + (where % (lines.length - 1)), 0, tag);
          const result = StreamLength.fromHls(lines.join('\n'));
          expect(result).toEqual({duration: STILLS_LENGTH});
        },
    ), {numRuns: 200});
  });

  it('returns the first URL after EXT-X-STREAM-INF as the variant, as written in the playlist', () => {
    // Lines 76-79: the first non-empty, non-comment line after the tag.
    const uriArb = fc.array(
        fc.constantFrom(...'abcdefghijkmnopqrstuvwxyz0123456789/._-'.split('')),
        {minLength: 1, maxLength: 24},
    ).map((chars) => 'seg' + chars.join(''));
    fc.assert(fc.property(uriArb, (uri) => {
      const result = StreamLength.fromHls(
          '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1920x1080\n' + uri + '\n');
      expect(result).toEqual({variant: uri});
    }), {numRuns: 200});
  });

  it('never throws on arbitrary text and returns null, a variant, or a duration that is STILLS_LENGTH, Infinity or finite and positive', () => {
    // Lines 73-97: durations accumulate only finite positive EXTINF values
    // (line 83), so neither NaN nor a negative finite length can come out.
    const arbitraryPlaylist = fc.oneof(
        fc.string({unit: 'binary'}),
        fc.string({unit: 'binary'}).map((s) => '#EXTM3U\n' + s),
        fc.string({unit: 'binary'}).map((s) => '#EXTM3U\n#EXTINF:' + s),
    );
    fc.assert(fc.property(arbitraryPlaylist, (text) => {
      let result = 'threw';
      try {
        result = StreamLength.fromHls(text);
      } catch (error) {
        result = 'threw';
      }
      expect(result).not.toBe('threw');
      if (result === null) {
        return;
      }
      if ('variant' in result) {
        expect(typeof result.variant).toBe('string');
        return;
      }
      expect(typeof result.duration).toBe('number');
      expect(Number.isNaN(result.duration)).toBe(false);
      expect(result.duration === STILLS_LENGTH || result.duration === Infinity ||
          (Number.isFinite(result.duration) && result.duration > 0)).toBe(true);
    }), {numRuns: 200});
  });
});

describe('StreamLength.fromHls with segments of any length', () => {
  // EXTINF values as pages write them, the broken ones too: zero, negative, not a number.
  const extinf = fc.oneof(
      segmentDuration.map(String),
      fc.constantFrom('0', '-1', '-0.5', 'NaN', 'abc', '', 'Infinity', '-Infinity'),
      fc.double({noNaN: false}).map(String),
  );

  it('adds up only the finite positive durations, and lists nothing when there is none', () => {
    fc.assert(fc.property(fc.array(extinf, {maxLength: 12}), (values) => {
      const counted = values.map(parseFloat).filter((v) => Number.isFinite(v) && v > 0);
      const result = StreamLength.fromHls(mediaPlaylist(values));
      if (counted.length === 0) {
        expect(result).toBe(null);
        return;
      }
      expect(result.duration).toBeCloseTo(counted.reduce((a, b) => a + b, 0), 6);
      expect(result.duration).toBeGreaterThan(0);
    }), {numRuns: 300});
  });
});

describe('StreamLength.fromDash and parseIsoDuration', () => {
  // A generated duration, as an MPD writes it: whole hours and minutes, whole
  // or fractional seconds, always over zero.
  const isoDuration = fc.integer({min: 1, max: 5 * 60 * 60 * 1000}).map((ms) => {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = (ms % 60000) / 1000;
    const value = 'PT' + hours + 'H' + minutes + 'M' + String(seconds) + 'S';
    return {value, seconds: ((hours * 60 + minutes) * 60) + seconds};
  });

  it('parses a generated PT#H#M#S duration back to its hours/minutes/seconds, on the raw string and inside a manifest', () => {
    // Lines 386-393 for the parser; lines 105-119 read the same attribute.
    fc.assert(fc.property(isoDuration, ({value, seconds}) => {
      expect(StreamLength.parseIsoDuration(value)).toBeCloseTo(seconds, 9);
      const mpd = '<MPD type="static" mediaPresentationDuration="' + value + '" minBufferTime="PT2S">';
      expect(StreamLength.fromDash(mpd)).toBeCloseTo(seconds, 9);
    }), {numRuns: 200});
  });

  it('reports Infinity for a generated dynamic MPD, whatever duration it also carries', () => {
    // Lines 112-114: type="dynamic" wins before any duration is read.
    fc.assert(fc.property(isoDuration, ({value}) => {
      const mpd = '<MPD type="dynamic" mediaPresentationDuration="' + value + '">';
      expect(StreamLength.fromDash(mpd)).toBe(Infinity);
    }), {numRuns: 200});
  });

  it('never throws on arbitrary text and returns null or a number that is neither NaN, zero nor negative', () => {
    const arbitraryMpd = fc.oneof(
        fc.string({unit: 'binary'}),
        fc.string({unit: 'binary'}).map((s) => '<MPD ' + s + '>'),
        fc.string({unit: 'binary'}).map((s) => '<MPD type="static" mediaPresentationDuration="' + s + '">'),
        fc.string({unit: 'binary'}).map((s) => '<MPD type="static"><Period duration="' + s + '"/></MPD>'),
    );
    fc.assert(fc.property(arbitraryMpd, (text) => {
      let result = 'threw';
      try {
        result = StreamLength.fromDash(text);
      } catch (error) {
        result = 'threw';
      }
      expect(result).not.toBe('threw');
      if (result === null) {
        return;
      }
      expect(typeof result).toBe('number');
      expect(Number.isNaN(result)).toBe(false);
      expect(result === Infinity || result > 0).toBe(true);
    }), {numRuns: 200});
  });

  it('returns null or a positive number for an arbitrary duration string, never NaN or a negative', () => {
    // Lines 388-393: a non-match or a non-positive total becomes null.
    fc.assert(fc.property(fc.string({unit: 'binary'}), (value) => {
      let parsed = 'threw';
      try {
        parsed = StreamLength.parseIsoDuration(value);
      } catch (error) {
        parsed = 'threw';
      }
      expect(parsed).not.toBe('threw');
      if (parsed === null) {
        return;
      }
      expect(typeof parsed).toBe('number');
      expect(Number.isNaN(parsed)).toBe(false);
      expect(parsed === Infinity || parsed > 0).toBe(true);
    }), {numRuns: 200});
  });
});
