import {describe, expect, it} from 'vitest';

import {StreamLength, UNKNOWN_LENGTH_S} from '../../chrome/player/utils/StreamLength.mjs';

// MP4 boxes: a 32-bit size, a four-character type, the payload.
function box(type, ...payloads) {
  const body = concat(...payloads);
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
  out.set(body, 8);
  return out;
}

// A box header that claims a size, with none of the payload: the start of a large mdat.
function boxHeader(type, size) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setUint32(0, size);
  out.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
  return out;
}

// The same with a 64-bit size.
function boxHeader64(type, size) {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, 1);
  out.set(Array.from(type, (c) => c.charCodeAt(0)), 4);
  view.setBigUint64(8, BigInt(size));
  return out;
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  values.forEach((value, i) => new DataView(out.buffer).setUint32(i * 4, value));
  return out;
}

function u64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

// mvhd: version and flags, the times, then the rest of a real one's fields (rate, volume,
// matrix, next track id), which the reader skips.
function mvhd(version, timescale, duration) {
  const times = version === 1 ?
    concat(u64(0), u64(0), u32(timescale), u64(duration)) :
    concat(u32(0, 0, timescale), u32(duration));
  return box('mvhd', new Uint8Array([version, 0, 0, 0]), times, new Uint8Array(80));
}

function mehd(version, duration) {
  return box('mehd', new Uint8Array([version, 0, 0, 0]), version === 1 ? u64(duration) : u32(duration));
}

const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(512), new TextEncoder().encode('isomiso2avc1mp41'));

// EBML: an ID (its marker bits kept) and a size (as an 8-byte vint), then the payload.
function ebml(id, ...payloads) {
  const body = concat(...payloads);
  const idBytes = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) {
    idBytes.unshift(value % 256);
  }
  const size = new Uint8Array(8);
  size[0] = 0x01;
  new DataView(size.buffer).setUint32(4, body.length);
  return concat(new Uint8Array(idBytes), size, body);
}

// An element of unknown size: a live stream's Segment.
function ebmlUnknownSize(id) {
  const idBytes = [];
  for (let value = id; value > 0; value = Math.floor(value / 256)) {
    idBytes.unshift(value % 256);
  }
  return concat(new Uint8Array(idBytes), new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
}

function float64(value) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return out;
}

function float32(value) {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setFloat32(0, value);
  return out;
}

const EBML_HEADER = ebml(0x1A45DFA3, ebml(0x4282, new TextEncoder().encode('webm')));
const SEEK_HEAD = ebml(0x114D9B74, ebml(0x4DBB, new Uint8Array(12)));

describe('StreamLength.fromMp4', () => {
  it('reads the length from a movie header version 0', () => {
    expect(StreamLength.fromFile(concat(ftyp, box('moov', mvhd(0, 1000, 90500))))).toEqual({duration: 90.5});
  });

  it('reads the 64-bit length of a movie header version 1', () => {
    const bytes = concat(ftyp, box('moov', mvhd(1, 90000, 90000 * 7200)));
    expect(StreamLength.fromFile(bytes)).toEqual({duration: 7200});
  });

  it('reads a fragmented file\'s length from mvex > mehd, as its mvhd says 0', () => {
    const v0 = concat(ftyp, box('moov', mvhd(0, 1000, 0), box('trak'), box('mvex', box('trex'), mehd(0, 1452000))));
    expect(StreamLength.fromFile(v0)).toEqual({duration: 1452});
    const v1 = concat(ftyp, box('moov', mvhd(0, 1000, 0), box('mvex', mehd(1, 5400000))));
    expect(StreamLength.fromFile(v1)).toEqual({duration: 5400});
  });

  it('points past the media data to a movie header at the end of the file', () => {
    const start = concat(ftyp, boxHeader('free', 8), boxHeader('mdat', 1000000));
    const next = ftyp.length + 8 + 1000000;
    expect(StreamLength.fromMp4(start)).toEqual({next});
    // The read from there.
    expect(StreamLength.fromMp4(box('moov', mvhd(0, 600, 600 * 1500)), next)).toEqual({duration: 1500});
  });

  it('points past media data of a 64-bit size', () => {
    const start = concat(ftyp, boxHeader64('mdat', 5 * 2 ** 32));
    expect(StreamLength.fromMp4(start)).toEqual({next: ftyp.length + 5 * 2 ** 32});
  });

  it('reads the movie header again from its start when only its first bytes came', () => {
    // The moov starts 20 bytes before the end of the read.
    const moov = box('moov', mvhd(0, 1000, 60000));
    const bytes = concat(ftyp, box('free', new Uint8Array(100)), moov.subarray(0, 20));
    expect(StreamLength.fromMp4(bytes)).toEqual({next: ftyp.length + 108});
    // At the start of a read, what came is all there is.
    expect(StreamLength.fromMp4(moov.subarray(0, 20), 5000)).toBeNull();
  });

  it('gives up on media data that runs to the end of the file', () => {
    expect(StreamLength.fromMp4(concat(ftyp, boxHeader('mdat', 0)))).toBeNull();
  });

  it('tells no length for an unknown one, or a movie header without one', () => {
    expect(StreamLength.fromFile(concat(ftyp, box('moov', mvhd(0, 1000, 0xFFFFFFFF))))).toBeNull();
    // An init segment: no length of its own.
    expect(StreamLength.fromFile(concat(ftyp, box('moov', mvhd(0, 1000, 0), box('mvex', box('trex')))))).toBeNull();
    expect(StreamLength.fromFile(concat(ftyp, box('moov', box('trak'))))).toBeNull();
  });

  it('takes no other bytes for an MP4', () => {
    // An MPEG-TS packet, an HTML page, a JPEG, too few bytes.
    const ts = new Uint8Array(188 * 4).fill(0xFF);
    for (let i = 0; i < ts.length; i += 188) ts[i] = 0x47;
    expect(StreamLength.fromFile(ts)).toBeNull();
    expect(StreamLength.fromFile(new TextEncoder().encode('<!doctype html><title>x</title>'))).toBeNull();
    expect(StreamLength.fromFile(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 74, 70, 73, 70, 0, 1]))).toBeNull();
    expect(StreamLength.fromFile(concat(box('abcd'), box('moov', mvhd(0, 1, 60))))).toBeNull();
    expect(StreamLength.fromMp4(new Uint8Array(4))).toEqual({next: 0});
  });
});

describe('StreamLength.fromWebm', () => {
  it('reads the length from Segment > Info, in the default timecode scale', () => {
    const bytes = concat(EBML_HEADER, ebmlUnknownSize(0x18538067), SEEK_HEAD,
        ebml(0x1549A966, ebml(0x2AD7B1, new Uint8Array([0x0F, 0x42, 0x40])), ebml(0x4489, float64(1452345))));
    expect(StreamLength.fromFile(bytes)).toEqual({duration: 1452.345});
  });

  it('reads a 4-byte length, in another timecode scale', () => {
    const bytes = concat(EBML_HEADER, ebml(0x18538067,
        ebml(0x1549A966, ebml(0x4489, float32(2400)), ebml(0x2AD7B1, new Uint8Array([0x3B, 0x9A, 0xCA, 0x00])))));
    // 2,400 ticks of a second each.
    expect(StreamLength.fromFile(bytes)).toEqual({duration: 2400});
  });

  it('tells no length for a live stream, or media data of unknown size before the Info', () => {
    expect(StreamLength.fromFile(concat(EBML_HEADER, ebmlUnknownSize(0x18538067), SEEK_HEAD,
        ebml(0x1549A966, ebml(0x2AD7B1, new Uint8Array([0x0F, 0x42, 0x40])))))).toBeNull();
    expect(StreamLength.fromFile(concat(EBML_HEADER, ebmlUnknownSize(0x18538067),
        ebmlUnknownSize(0x1F43B675)))).toBeNull();
    expect(StreamLength.fromWebm(concat(ebml(0x1A45DFA3), ebml(0x1654AE6B)))).toBeNull();
  });
});

describe('StreamLength.fromHls', () => {
  it('adds up a media playlist\'s segments', () => {
    const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\na.ts\n#EXTINF:9.5,title\nb.ts\n' +
      '#EXTINF:4.25,\nc.ts\n#EXT-X-ENDLIST\n';
    expect(StreamLength.fromHls(playlist)).toEqual({duration: 23.75});
  });

  it('takes a VOD playlist without its end tag for ended', () => {
    expect(StreamLength.fromHls('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n')).toEqual({duration: 12});
  });

  it('takes a playlist that has not ended for live', () => {
    expect(StreamLength.fromHls('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4120\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts\n')).toEqual({duration: Infinity});
    expect(StreamLength.fromHls('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:6,\na.ts\n')).toEqual({duration: Infinity});
  });

  it('names a master playlist\'s first variant', () => {
    const master = '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"\n' +
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n\n720p/index.m3u8?token=a\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=640000\n360p/index.m3u8\n';
    expect(StreamLength.fromHls(master)).toEqual({variant: '720p/index.m3u8?token=a'});
    expect(StreamLength.fromHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n')).toBeNull();
  });

  it('reads a playlist with a byte order mark, CRLF lines and blank lines first', () => {
    const bom = String.fromCharCode(0xFEFF);
    expect(StreamLength.fromHls(`${bom}\r\n\r\n#EXTM3U\r\n#EXTINF:3,\r\na.ts\r\n#EXT-X-ENDLIST\r\n`)).toEqual({duration: 3});
  });

  it('takes nothing else for a playlist', () => {
    expect(StreamLength.fromHls('<!doctype html><title>404</title>')).toBeNull();
    expect(StreamLength.fromHls('')).toBeNull();
    expect(StreamLength.fromHls('#EXTM3U\n#EXT-X-ENDLIST\n')).toBeNull();
    // A radio station list: an M3U, not an HLS playlist.
    expect(StreamLength.fromHls('#EXTM3U\n#EXTINF:-1,Radio One\nhttp://radio.example/stream\n')).toBeNull();
    // A page that quotes one: a playlist starts with its tag.
    expect(StreamLength.fromHls('<pre>#EXTM3U\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST\n</pre>')).toBeNull();
  });
});

describe('StreamLength.fromDash', () => {
  it('reads the MPD\'s mediaPresentationDuration', () => {
    const mpd = '<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"\n  type="static"\n' +
      '  mediaPresentationDuration="PT1H2M3.5S" minBufferTime="PT2S">\n<Period id="0"></Period></MPD>';
    expect(StreamLength.fromDash(mpd)).toBe(3723.5);
  });

  it('takes a dynamic MPD for live', () => {
    expect(StreamLength.fromDash('<MPD type=\'dynamic\' availabilityStartTime="2026-01-01T00:00:00Z"></MPD>')).toBe(Infinity);
  });

  it('adds up the periods when the MPD has no total', () => {
    const mpd = '<mpd:MPD type="static"><mpd:Period duration="PT20M"/><mpd:Period duration="PT4M30S"/></mpd:MPD>';
    expect(StreamLength.fromDash(mpd)).toBe(1470);
    expect(StreamLength.fromDash('<MPD><Period duration="PT20M"/><Period start="PT20M"/></MPD>')).toBeNull();
    expect(StreamLength.fromDash('<MPD></MPD>')).toBeNull();
  });

  it('takes nothing else for an MPD', () => {
    expect(StreamLength.fromDash('<html><body>MPD</body></html>')).toBeNull();
  });
});

describe('StreamLength.parseIsoDuration', () => {
  it('reads the parts MPDs use', () => {
    expect(StreamLength.parseIsoDuration('PT1.5S')).toBe(1.5);
    expect(StreamLength.parseIsoDuration('PT45M')).toBe(2700);
    expect(StreamLength.parseIsoDuration('P1DT2H')).toBe(93600);
    expect(StreamLength.parseIsoDuration(' P1W ')).toBe(604800);
  });

  it('gives null for none, zero or a malformed one', () => {
    expect(StreamLength.parseIsoDuration(undefined)).toBeNull();
    expect(StreamLength.parseIsoDuration('PT0S')).toBeNull();
    expect(StreamLength.parseIsoDuration('1H')).toBeNull();
    expect(StreamLength.parseIsoDuration('PT1H30')).toBeNull();
  });
});

describe('StreamLength.longest', () => {
  const src = (name, duration) => ({name, duration});
  const names = (sources) => StreamLength.longest(sources).map((source) => source.name);

  it('takes the film over the ad', () => {
    expect(names([src('ad', 15), src('film', 5400), src('intro', 3)])).toEqual(['film']);
  });

  it('keeps streams of about the same length, for the caller to choose from', () => {
    // The same episode as HLS and as MP4.
    expect(names([src('hls', 1452), src('mp4', 1450.5), src('ad', 30)])).toEqual(['hls', 'mp4']);
  });

  it('ranks a stream of unknown length above a short one and below a long one', () => {
    expect(names([src('ad', 30), src('unknown', null)])).toEqual(['unknown']);
    expect(names([src('unknown'), src('episode', 1400)])).toEqual(['episode']);
    expect(names([src('a', null), src('b', undefined), src('c', NaN), src('d', 0)])).toEqual(['a', 'b', 'c', 'd']);
    expect(names([src('zero', 0), src('ad', 30)])).toEqual(['zero']);
  });

  it('ties within a tenth of the longest, and no further', () => {
    const tie = 0.9 * UNKNOWN_LENGTH_S;
    expect(names([src('unknown', null), src('edge', tie)])).toEqual(['unknown', 'edge']);
    expect(names([src('unknown', null), src('under', tie - 1)])).toEqual(['unknown']);
  });

  it('takes a live stream over any recording', () => {
    expect(names([src('vod', 3 * 3600), src('live', Infinity), src('live2', Infinity)])).toEqual(['live', 'live2']);
  });

  it('keeps a single source, and gives none for none', () => {
    expect(names([src('only', 5)])).toEqual(['only']);
    expect(StreamLength.longest([])).toEqual([]);
  });
});
