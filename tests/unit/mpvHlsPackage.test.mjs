import {describe, expect, it} from 'vitest';

import {hlsPackage} from '../../chrome/background/MpvHlsPackage.mjs';
import {checkHlsPackage} from '../../native-host/faststream-mpv-host.mjs';

// The playlists FastStream sends mpv for an HLS stream mpv cannot open from its address alone: a server that
// names no type (text/plain at /pl/7?token=...) or asks every file for the key in the stream's address.

const ORIGIN = 'https://cdn.test';
const MEDIA = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/content/a/page-0.html\n#EXTINF:6,\n/content/a/page-1.html\n#EXT-X-ENDLIST\n';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=640x272\n/pl/7/lo\n' +
  '#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x816\n/pl/7/hi\n' +
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="/pl/7/iframes"\n';

/**
 * A server: files by path; keyed ones refuse (403, or refuse) without ?token=k, signed ones always; a moved
 * one answers as the file at its new address.
 * @param {Object<string, {text?: string, type?: string, keyed?: boolean, refuse?: number, signed?: boolean,
 *   moved?: string}>} files
 * @param {{onAsk?: (url: string) => void}} [hooks]
 * @return {{io: import('../../chrome/background/MpvHlsPackage.mjs').PackageIo, asked: Array<string>}}
 */
function server(files, hooks = {}) {
  const asked = [];
  const answer = (url) => {
    asked.push(url);
    hooks.onAsk?.(url);
    let parsed = new URL(url);
    let file = files[parsed.pathname];
    if (file?.moved) {
      parsed = new URL(file.moved);
      file = files[parsed.pathname];
    }
    if (!file) return {status: 404, type: '', text: '', url: parsed.href};
    if (file.signed || (file.keyed && parsed.searchParams.get('token') !== 'k')) {
      return {status: file.refuse ?? 403, type: 'text/html', text: '', url: parsed.href};
    }
    return {status: 200, type: file.type ?? 'text/plain; charset=utf-8', text: file.text, url: parsed.href};
  };
  return {
    asked,
    io: {
      fetchText: async (url, budget) => {
        const fetched = answer(url);
        budget.left -= new TextEncoder().encode(fetched.text).length;
        return budget.left < 0 ? null : fetched;
      },
      status: async (url) => answer(url).status,
    },
  };
}

describe('the playlists that go to mpv with a stream', () => {
  it('sends today\'s hoster as its master and variants, every address whole and keyed', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER, keyed: true},
      '/pl/7/lo': {text: MEDIA, keyed: true},
      '/pl/7/hi': {text: MEDIA, keyed: true},
      '/content/a/page-0.html': {text: 'TS', type: 'text/html', keyed: true},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files.map((f) => f.name)).toEqual(['master.m3u8', '0.m3u8', '1.m3u8']);
    expect(pack.files[0].text).toContain('\n0.m3u8\n');
    expect(pack.files[0].text).not.toContain('I-FRAME');
    expect(pack.files[1].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
    expect(checkHlsPackage(pack).ok).toBe(true);
  });

  it('sends the variant the quality setting picked, listed without the key, as one playlist', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER, keyed: true},
      '/pl/7/hi': {text: MEDIA, keyed: true},
      '/content/a/page-0.html': {text: 'TS', keyed: true},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7/hi`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files.map((f) => f.name)).toEqual(['0.m3u8']);
    expect(pack.files[0].text.split('\n').filter((l) => l.startsWith('https'))).toEqual([
      `${ORIGIN}/content/a/page-0.html?token=k`, `${ORIGIN}/content/a/page-1.html?token=k`]);
  });

  it('sends a stream whose server names no type, though it asks for no key, without adding one', async () => {
    const {io} = server({'/pl/7': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS'}});
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html\n`);
  });

  it('keys the segments when only they ask for it', async () => {
    const {io} = server({'/v/pl': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS', keyed: true}});
    const pack = await hlsPackage({url: `${ORIGIN}/v/pl?token=k`, keyFrom: `${ORIGIN}/v/pl?token=k`, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('asks nothing for a stream named .m3u8, whatever its query: mpv opens it at once', async () => {
    const {io, asked} = server({'/v/index.m3u8': {text: MASTER.replaceAll('/pl/7/', '/v/')},
      '/v/lo': {text: MEDIA}, '/v/hi': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS', keyed: true}});
    expect(await hlsPackage({url: `${ORIGIN}/v/index.m3u8?token=k`, keyFrom: `${ORIGIN}/v/index.m3u8?token=k`, io})).toBeNull();
    expect(asked).toEqual([]);
  });

  it('keys a named variant the quality setting picked from a disguised master', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER.replace('/pl/7/hi', '/pl/7/hi.m3u8'), keyed: true},
      '/pl/7/hi.m3u8': {text: MEDIA, keyed: true},
      '/content/a/page-0.html': {text: 'TS', keyed: true},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7/hi.m3u8`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('keys a named variant from a disguised master when only its segments want the key', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER.replace('/pl/7/hi', '/pl/7/hi.m3u8'), keyed: true},
      '/pl/7/hi.m3u8': {text: MEDIA},
      '/content/a/page-0.html': {text: 'TS', keyed: true},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7/hi.m3u8`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('sends nothing for a named variant from a disguised master that wants no key', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER.replace('/pl/7/hi', '/pl/7/hi.m3u8'), keyed: true},
      '/pl/7/hi.m3u8': {text: MEDIA},
      '/content/a/page-0.html': {text: 'TS'},
    });
    expect(await hlsPackage({url: `${ORIGIN}/pl/7/hi.m3u8`, keyFrom: `${ORIGIN}/pl/7?token=k`, io})).toBeNull();
  });

  it('asks nothing for a stream found served as HLS (its detection saw the type)', async () => {
    const {io, asked} = server({'/v/pl': {text: MEDIA, type: 'application/vnd.apple.mpegurl'}});
    expect(await hlsPackage({url: `${ORIGIN}/v/pl?sig=1`, keyFrom: `${ORIGIN}/v/pl?sig=1`, typed: true, io})).toBeNull();
    expect(asked).toEqual([]);
  });

  it('keys a variant the quality setting picked from a master its server types HLS', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER, type: 'application/vnd.apple.mpegurl', keyed: true},
      '/pl/7/hi': {text: MEDIA, keyed: true},
      '/content/a/page-0.html': {text: 'TS', keyed: true},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7/hi`, keyFrom: `${ORIGIN}/pl/7?token=k`, typed: true, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('sends nothing for a stream its server types HLS, after reading only its playlist', async () => {
    const {io, asked} = server({'/v/pl': {text: MEDIA, type: 'application/vnd.apple.mpegurl'}, '/content/a/page-0.html': {text: 'TS'}});
    expect(await hlsPackage({url: `${ORIGIN}/v/pl?sig=1`, keyFrom: `${ORIGIN}/v/pl?sig=1`, io})).toBeNull();
    expect(asked).toEqual([`${ORIGIN}/v/pl?sig=1`]);
  });

  it('sends nothing for a live stream: a file of its playlist goes stale', async () => {
    const {io} = server({'/pl/7': {text: MEDIA.replace('#EXT-X-ENDLIST\n', '')}});
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io})).toBeNull();
  });

  it('adds no key a server refuses as well (a signed address per file)', async () => {
    const {io, asked} = server({'/pl/7': {text: MASTER}, '/pl/7/lo': {text: MEDIA, signed: true}, '/pl/7/hi': {text: MEDIA}});
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?sig=1`, keyFrom: `${ORIGIN}/pl/7?sig=1`, io})).toBeNull();
    expect(asked).toEqual([`${ORIGIN}/pl/7?sig=1`, `${ORIGIN}/pl/7/lo`, `${ORIGIN}/pl/7/lo?sig=1`]);
  });

  it('reads addresses against the address after a redirect, and keys none of another server', async () => {
    const {io} = server({
      '/pl/7': {moved: 'https://edge.test/x/7'},
      '/x/7': {text: MEDIA.replace('/content/a/page-0.html', 'seg/page-0.html')},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files[0].text).toContain('\nhttps://edge.test/x/seg/page-0.html\n');
    expect(pack.files[0].text).toContain('\nhttps://edge.test/content/a/page-1.html\n');
  });

  it('keys the segments when they refuse 401 without the key', async () => {
    const {io} = server({'/v/pl': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS', keyed: true, refuse: 401}});
    const pack = await hlsPackage({url: `${ORIGIN}/v/pl?token=k`, keyFrom: `${ORIGIN}/v/pl?token=k`, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('gives every playlist the key only a later variant asked for', async () => {
    const {io} = server({
      '/pl/7': {text: MASTER},
      '/pl/7/lo': {text: MEDIA},
      '/pl/7/hi': {text: MEDIA, keyed: true},
      '/content/a/page-0.html': {text: 'TS'},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files.map((f) => f.name)).toEqual(['master.m3u8', '0.m3u8', '1.m3u8']);
    for (const file of pack.files.slice(1)) expect(file.text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('names in the master only its playlists, read as ffmpeg reads them, which the helper takes', async () => {
    const master = MASTER + '#EXT-X-SESSION-KEY:METHOD=AES-128,URI="/key"\n#EXT-X-SESSION-DATA:DATA-ID="a",URI="/d.json"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000\n#EXT-X-PROGRAM-DATE-TIME:2026-11-18T00:00:00Z\n/pl/7/mid\n/pl/7/stray\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="/pl/7/en"\n';
    const {io} = server({'/pl/7': {text: master}, '/pl/7/lo': {text: MEDIA}, '/pl/7/hi': {text: MEDIA},
      '/pl/7/mid': {text: MEDIA}, '/pl/7/en': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS'}});
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files.map((f) => f.name)).toEqual(['master.m3u8', '0.m3u8', '1.m3u8', '2.m3u8', '3.m3u8']);
    expect(pack.files[0].text).not.toMatch(/SESSION|I-FRAME|stray|https:/);
    expect(pack.files[0].text).toContain('\n2.m3u8\n');
    expect(pack.files[0].text).toContain('URI="3.m3u8"');
    expect(checkHlsPackage(pack).ok).toBe(true);
  });

  it('reads at most 12 MB in all, reads at once sharing it, though the playlists come out smaller', async () => {
    const padded = MEDIA.replace('#EXT-X-ENDLIST', ' '.repeat(5 * 1024 * 1024) + '\n#EXT-X-ENDLIST');
    const master = MASTER + '#EXT-X-STREAM-INF:BANDWIDTH=2000000\n/pl/7/mid\n';
    const {io} = server({'/pl/7': {text: master}, '/pl/7/lo': {text: padded}, '/pl/7/hi': {text: padded},
      '/pl/7/mid': {text: padded}, '/content/a/page-0.html': {text: 'TS'}});
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io})).toBeNull();
  });

  it('gives up on what it still waits for when the hand-off stops', async () => {
    const stop = new AbortController();
    const io = {fetchText: () => new Promise(() => {}), status: () => new Promise(() => {})};
    setTimeout(() => stop.abort(), 20);
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io, signal: stop.signal})).toBeNull();
  });

  it('reads no more once the hand-off stopped', async () => {
    const stop = new AbortController();
    const {io, asked} = server({'/pl/7': {text: MASTER}, '/pl/7/lo': {text: MEDIA}, '/pl/7/hi': {text: MEDIA},
      '/content/a/page-0.html': {text: 'TS'}}, {onAsk: (url) => url.endsWith('/pl/7/lo') && stop.abort()});
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io, signal: stop.signal})).toBeNull();
    expect(asked.some((url) => url.includes('/pl/7/hi'))).toBe(false);
  });

  it('never gives the key to another server', async () => {
    const {io} = server({
      '/pl/7': {text: MEDIA.replace('/content/a/page-1.html', 'https://other.test/content/a/page-1.html'), keyed: true},
      '/content/a/page-0.html': {text: 'TS', keyed: true},
    });
    const pack = await hlsPackage({url: `${ORIGIN}/pl/7`, keyFrom: `${ORIGIN}/pl/7?token=k`, io});
    expect(pack.files[0].text).toContain('https://other.test/content/a/page-1.html\n');
  });
});
