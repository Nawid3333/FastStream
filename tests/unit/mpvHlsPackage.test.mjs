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
 * A server: files by path; keyed ones refuse 403 without ?token=k.
 * @param {Object<string, {text: string, type?: string, keyed?: boolean}>} files
 * @return {{io: import('../../chrome/background/MpvHlsPackage.mjs').PackageIo, asked: Array<string>}}
 */
function server(files) {
  const asked = [];
  const answer = (url) => {
    asked.push(url);
    const parsed = new URL(url);
    const file = files[parsed.pathname];
    if (!file) return {status: 404, type: '', text: ''};
    if (file.keyed && parsed.searchParams.get('token') !== 'k') return {status: 403, type: 'text/html', text: ''};
    return {status: 200, type: file.type ?? 'text/plain; charset=utf-8', text: file.text};
  };
  return {
    asked,
    io: {
      fetchText: async (url) => answer(url),
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
    const {io} = server({'/v/index.m3u8': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS', keyed: true}});
    const pack = await hlsPackage({url: `${ORIGIN}/v/index.m3u8?token=k`, keyFrom: `${ORIGIN}/v/index.m3u8?token=k`, io});
    expect(pack.files[0].text).toContain(`${ORIGIN}/content/a/page-0.html?token=k`);
  });

  it('sends nothing for a stream mpv opens itself: named .m3u8, no key asked', async () => {
    const {io, asked} = server({'/v/index.m3u8': {text: MASTER.replaceAll('/pl/7/', '/v/')},
      '/v/lo': {text: MEDIA}, '/v/hi': {text: MEDIA}, '/content/a/page-0.html': {text: 'TS'}});
    expect(await hlsPackage({url: `${ORIGIN}/v/index.m3u8?sig=1`, keyFrom: `${ORIGIN}/v/index.m3u8?sig=1`, io})).toBeNull();
    // The master, its first variant, its first segment: no more.
    expect(asked.length).toBe(3);
  });

  it('sends nothing for a live stream: a file of its playlist goes stale', async () => {
    const {io} = server({'/pl/7': {text: MEDIA.replace('#EXT-X-ENDLIST\n', '')}});
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?token=k`, keyFrom: `${ORIGIN}/pl/7?token=k`, io})).toBeNull();
  });

  it('adds no key a server refuses as well (a signed address per file)', async () => {
    const {io} = server({'/pl/7': {text: MASTER}});
    expect(await hlsPackage({url: `${ORIGIN}/pl/7?sig=1`, keyFrom: `${ORIGIN}/pl/7?sig=1`, io})).toBeNull();
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
