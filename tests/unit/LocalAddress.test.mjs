import {describe, expect, it} from 'vitest';

import {isLocalAddress} from '../../chrome/background/LocalAddress.mjs';

describe('isLocalAddress', () => {
  it('is true for the local network and this computer', () => {
    for (const url of [
      'http://10.1.2.3/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.168.0.1:8096/v',
      'http://127.0.0.1/', 'http://127.8.8.8/', 'http://0.0.0.0/', 'http://169.254.1.1/',
      // Forms the URL parser writes as dotted addresses first.
      'http://0x7f.1/', 'http://2130706433/', 'http://0300.0250.0.1/',
      'http://localhost:3000/', 'http://LOCALHOST/', 'http://app.localhost/', 'http://nas.local/', 'http://nas/',
      'http://[::1]/', 'http://[::]/', 'http://[fd12:3456::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
      'http://[::ffff:192.168.1.1]/', 'http://[::ffff:127.0.0.1]/',
      // A name ending in a dot, which the parser keeps.
      'http://localhost./', 'http://nas.local./', 'http://nas./', 'http://192.168.1.1./',
      // Shared address space: carrier-grade NAT, Tailscale.
      'http://100.64.0.1/', 'http://100.101.102.103:8096/', 'http://100.127.255.254/',
      'http://[fd00::1]/', 'http://[FE80::1]/', 'http://[febf::1]/',
    ]) {
      expect(isLocalAddress(url), url).toBe(true);
    }
  });

  it('is false for addresses on the internet, and for what cannot be read', () => {
    for (const url of [
      'https://cdn.example.com/v.m3u8', 'http://8.8.8.8/', 'http://172.15.0.1/', 'http://172.32.0.1/',
      'http://192.169.0.1/', 'http://11.0.0.1/', 'http://169.255.0.1/', 'http://[2001:db8::1]/',
      'http://[::ffff:8.8.8.8]/', 'http://localhost.example.com/', 'http://local.example/', 'not a url', '',
      'http://100.63.255.255/', 'http://100.128.0.1/', 'http://example.com./',
      // Short first groups are outside fc00::/7 and fe80::/10 (0x00fc, 0x0fe8).
      'http://[fc::1]/', 'http://[fcd::1]/', 'http://[fe8::1]/', 'http://[fec0::1]/',
      // Not a web address: an extension page's one-word host is no local network.
      'moz-extension://ab-cd/player/index.html', 'file:///C:/film.mp4',
    ]) {
      expect(isLocalAddress(url), url).toBe(false);
    }
  });
});
