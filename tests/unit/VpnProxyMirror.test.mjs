import {describe, expect, it, vi} from 'vitest';

import {VpnProxyMirror} from '../../chrome/background/VpnProxyMirror.mjs';

// Firefox VPN proxies a page's requests and leaves FastStream's out (VpnProxyMirror.mjs).
// The proxyInfo below has the shape webRequest reported for an https proxy in Firefox 157.

const ORIGIN = 'moz-extension://f45ea7c1-3b2d-4a19-9c6e-8d5b0f2a7e34/';
const PLAYER = ORIGIN + 'player/index.html';
const PAGE = 'https://video.example/watch/1';
const CDN = 'https://cdn.example/hls/master.m3u8?t=abc&i=63.245';

const vpn = (token = 'Bearer one', isolation = 'iso1') => ({
  type: 'https', host: 'muc139.m1.fastly-masque.net', port: 2499,
  proxyAuthorizationHeader: token, connectionIsolationKey: isolation,
  failoverTimeout: 10, proxyDNS: false, username: '',
});

function setup({permitted = true} = {}) {
  const api = {
    onRequest: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  };
  const mirror = new VpnProxyMirror({origin: ORIGIN, getProxyApi: () => api});
  mirror.setPermitted(permitted);
  // The listener as last registered, and its filter.
  const current = () => {
    const calls = api.onRequest.addListener.mock.calls;
    const removed = new Set(api.onRequest.removeListener.mock.calls.map((c) => c[0]));
    const live = calls.filter((c) => !removed.has(c[0]));
    return live.length ? {listener: live[live.length - 1][0], urls: live[live.length - 1][1].urls} : null;
  };
  return {api, mirror, current};
}

const pageRequest = (url, proxyInfo, extra = {}) => ({
  url, tabId: 3, type: 'xmlhttprequest', incognito: false, originUrl: PAGE, documentUrl: PAGE,
  proxyInfo, ...extra,
});
const ownRequest = (url, extra = {}) => ({
  url, tabId: 3, incognito: false, originUrl: PLAYER, documentUrl: PLAYER, ...extra,
});

describe('VpnProxyMirror', () => {
  it('sends FastStream\'s requests to a stream\'s host the way the page\'s went', () => {
    const {mirror, current} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    mirror.noteRequest(pageRequest(CDN, vpn()));
    mirror.noteSource(pageRequest(CDN, vpn()));

    const live = current();
    expect(live.urls).toEqual(['*://cdn.example/*']);
    expect(live.listener(ownRequest(CDN))).toEqual({
      type: 'https', host: 'muc139.m1.fastly-masque.net', port: 2499,
      proxyAuthorizationHeader: 'Bearer one', connectionIsolationKey: 'iso1', failoverTimeout: 10,
    });
    // The background's own length reads (no tab) go the same way.
    expect(live.listener(ownRequest(CDN, {tabId: -1, originUrl: ORIGIN + 'background.html'})).host)
        .toBe('muc139.m1.fastly-masque.net');
    // The page's own requests are left to the VPN.
    expect(live.listener(pageRequest(CDN, null))).toBeUndefined();
  });

  it('uses the newest token any page request through that proxy carried', () => {
    const {mirror, current} = setup();
    mirror.noteSource(pageRequest(CDN, vpn('Bearer one', 'iso1')));
    mirror.noteRequest(pageRequest('https://fonts.example/a.woff2', vpn('Bearer two', 'iso2')));
    expect(current().listener(ownRequest(CDN))).toMatchObject({
      proxyAuthorizationHeader: 'Bearer two', connectionIsolationKey: 'iso2',
    });
  });

  it('adds only hosts FastStream fetches, not every host the page asks', () => {
    const {api, mirror} = setup();
    for (let i = 0; i < 50; i++) {
      mirror.noteRequest(pageRequest(`https://ads${i}.example/x.js`, vpn()));
    }
    expect(api.onRequest.addListener).not.toHaveBeenCalled();
    mirror.noteSource(pageRequest(CDN, vpn()));
    mirror.noteRequest(pageRequest(CDN, vpn()));
    mirror.noteRequest(pageRequest(CDN, vpn('Bearer two')));
    // One listener, for the one host; the token's change rebuilt nothing.
    expect(api.onRequest.addListener).toHaveBeenCalledTimes(1);
  });

  it('goes direct again once the page, loaded again without the VPN, reaches the host directly', () => {
    const {mirror, current} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    mirror.noteSource(pageRequest(CDN, vpn()));
    expect(current()).not.toBeNull();
    // The VPN turned off (or off for this site), and the page loaded again: its own loads
    // go direct, then its request for the stream.
    mirror.noteRequest(pageRequest('https://video.example/app.js', null, {type: 'script'}));
    expect(mirror.tabs.has(3)).toBe(false);
    mirror.noteRequest(pageRequest(CDN, null));
    expect(current()).toBeNull();
    expect(mirror.proxyFor(ownRequest(CDN))).toBeUndefined();
    expect(mirror.status(CDN, false, 3)).toEqual({proxied: false, copyable: false, permitted: true});
  });

  it('keeps the host for a direct fetch in a page still on the VPN (a content script\'s captions)', () => {
    const {mirror} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    mirror.noteSource(pageRequest(CDN, vpn()));
    mirror.noteRequest(pageRequest('https://cdn.example/subs/en.vtt', null));
    expect(mirror.tabs.has(3)).toBe(true);
    expect(mirror.proxyFor(ownRequest(CDN))).toBeDefined();
  });

  it('keeps the host when another tab\'s site, left out of the VPN, reaches it directly', () => {
    const {mirror} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    mirror.noteSource(pageRequest(CDN, vpn()));
    const other = {tabId: 7, originUrl: 'https://other.example/', documentUrl: 'https://other.example/'};
    mirror.noteRequest(pageRequest('https://other.example/', null, {...other, type: 'main_frame'}));
    mirror.noteRequest(pageRequest(CDN, null, other));
    expect(mirror.proxyFor(ownRequest(CDN))).toBeDefined();
  });

  it('forgets a closed tab\'s hosts', () => {
    const {mirror, current} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    mirror.noteSource(pageRequest(CDN, vpn()));
    mirror.forgetTab(3);
    expect(current()).toBeNull();
    expect(mirror.status(CDN, false, 3).proxied).toBe(false);
  });

  it('follows the tab\'s proxy from the next request to a host the page was not seen asking', () => {
    const {mirror, current} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    const segment = 'https://seg.example/seg-1.ts';
    // The proxy is picked before webRequest hears of the request: this one went direct.
    mirror.noteRequest(ownRequest(segment));
    expect(current().urls).toEqual(['*://seg.example/*']);
    expect(current().listener(ownRequest(segment)).host).toBe('muc139.m1.fastly-masque.net');
    // Not for a request outside any tab, nor in a tab whose page goes direct.
    mirror.noteRequest(ownRequest('https://other.example/x', {tabId: -1}));
    mirror.noteRequest(ownRequest('https://third.example/x', {tabId: 9}));
    expect(current().urls).toEqual(['*://seg.example/*']);
  });

  it('listens only with the permission, and from the moment it is given', () => {
    const {api, mirror, current} = setup({permitted: false});
    mirror.noteSource(pageRequest(CDN, vpn()));
    expect(api.onRequest.addListener).not.toHaveBeenCalled();
    expect(mirror.status(CDN, false, 3)).toEqual({proxied: true, copyable: true, permitted: false});
    mirror.setPermitted(true);
    expect(current().urls).toEqual(['*://cdn.example/*']);
    mirror.setPermitted(false);
    expect(current()).toBeNull();
  });

  it('does not copy a proxy whose settings webRequest does not give in full', () => {
    const {mirror} = setup();
    // MASQUE needs its URI template, which webRequest does not report.
    mirror.noteSource(pageRequest(CDN, {...vpn(), type: 'masque'}));
    expect(mirror.status(CDN, false, 3)).toEqual({proxied: true, copyable: false, permitted: true});
    expect(mirror.proxyFor(ownRequest(CDN))).toBeUndefined();
  });

  it('keeps private windows apart', () => {
    const {mirror} = setup();
    mirror.noteSource(pageRequest(CDN, vpn(), {incognito: true}));
    expect(mirror.proxyFor(ownRequest(CDN, {incognito: true}))).toBeDefined();
    expect(mirror.proxyFor(ownRequest(CDN, {incognito: false}))).toBeUndefined();
  });

  it('remembers a bounded number of hosts', () => {
    const {mirror} = setup();
    for (let i = 0; i < 250; i++) {
      mirror.noteSource(pageRequest(`https://cdn${i}.example/a.m3u8`, vpn()));
    }
    expect(mirror.hosts.size).toBe(200);
    expect(mirror.proxyFor(ownRequest('https://cdn0.example/a.m3u8'))).toBeUndefined();
    expect(mirror.proxyFor(ownRequest('https://cdn249.example/a.m3u8'))).toBeDefined();
  });

  it('adds a source\'s host for the player that asks about it in a tab that goes through the VPN', () => {
    const {mirror, current} = setup();
    mirror.noteRequest(pageRequest(PAGE, vpn(), {type: 'main_frame'}));
    expect(mirror.status(CDN, false, 3)).toEqual({proxied: true, copyable: true, permitted: true});
    expect(current().urls).toEqual(['*://cdn.example/*']);
  });
});
