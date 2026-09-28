import {afterEach, describe, expect, it} from 'vitest';
import {MpvBackend} from '../../chrome/background/MpvBackend.mjs';
import {isStreamUrl as hostIsStreamUrl} from '../../native-host/faststream-mpv-host.mjs';

// mpv plays whatever it is given, local files and UNC paths included, and opening a UNC
// path makes Windows sign in to that host with the user's credentials. The player page is
// web-accessible, so a page can build a FastStream player around a source of its choosing
// and have the user send it to mpv. FastStream itself only finds http(s) streams, so the
// extension (MpvBackend) and the native host each accept those and nothing else. The two
// checks are separate copies - the host is plain Node, outside the extension - so both run
// against the same table here.

const allowed = [
  'https://cdn.example.com/master.m3u8',
  'http://127.0.0.1:41993/clip.mp4?t=1',
  'HTTPS://CDN.EXAMPLE.COM/a.mpd',
  'https://example.com/watch?a=1,b=2#t=10',
];

const refused = [
  'file:///C:/Users/victim/private.mp4',
  'file://attacker/share/x.mkv',
  '\\\\attacker\\share\\x.mkv',
  '//attacker/share/x.mkv',
  'https:\\\\attacker\\share\\x.mkv',
  'smb://attacker/share/x.mkv',
  'ftp://example.com/a.mp4',
  'javascript:alert(1)',
  'data:video/mp4;base64,AAAA',
  'blob:https://example.com/0f7c',
  'ytdl://example',
  '--script=evil.lua',
  ' https://example.com/leading-space.m3u8',
  'https://',
  '',
  null,
  undefined,
  42,
];

for (const [name, check] of [['MpvBackend.isStreamUrl', (url) => MpvBackend.isStreamUrl(url)],
  ['the native host\'s isStreamUrl', hostIsStreamUrl]]) {
  describe(name, () => {
    it.each(allowed)('lets %s through', (url) => {
      expect(check(url)).toBe(true);
    });
    it.each(refused)('refuses %s', (url) => {
      expect(check(url)).toBe(false);
    });
  });
}

describe('openStream with a URL that is not http(s)', () => {
  afterEach(() => {
    delete globalThis.chrome;
  });

  it('never reaches the native host, and leaves the dedupe record alone', async () => {
    let calls = 0;
    globalThis.chrome = {runtime: {sendNativeMessage: () => calls++}};
    const tab = {mpvSentUrls: new Set()};
    const result = await new MpvBackend().openStream('\\\\attacker\\share\\x.mkv', tab);
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    expect(tab.mpvSentUrls.size).toBe(0);
  });
});
