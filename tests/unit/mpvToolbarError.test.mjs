import {beforeAll, beforeEach, describe, expect, it} from 'vitest';

// In MPV mode a failed hand-off used to leave the toolbar button purple ("Playing in
// MPV") while the page played on in the browser, with nothing to say why. The button
// now shows "!" and the reason in its tooltip until a hand-off works or the page changes.

let BackgroundUtils;
let calls;

beforeAll(async () => {
  // BackgroundUtils reads the player URL when it loads.
  globalThis.chrome = {runtime: {getURL: (file) => 'moz-extension://test/' + file}};
  ({BackgroundUtils} = await import('../../chrome/background/BackgroundUtils.mjs'));
});

beforeEach(() => {
  calls = {};
  const record = (name) => (details) => {
    calls[name] = details;
  };
  globalThis.chrome = {
    runtime: {getURL: (file) => 'moz-extension://test/' + file},
    // No translations here: the English fallbacks in the code are what shows.
    i18n: {getMessage: () => ''},
    action: {
      setBadgeText: record('badge'),
      setTitle: record('title'),
      setIcon: record('icon'),
    },
  };
});

describe('the toolbar button in MPV mode', () => {
  it('shows "!" and the reason after a failed hand-off', () => {
    BackgroundUtils.updateTabIcon({tabId: 7, isOn: true, isMpv: true, mpvError: 'mpv executable not found'});
    expect(calls.badge).toEqual({text: '!', tabId: 7});
    expect(calls.title).toEqual({title: 'FastStream - mpv could not open the stream: mpv executable not found', tabId: 7});
    expect(calls.icon).toEqual({path: '/icon3_128.png', tabId: 7});
  });

  it('is the plain purple icon otherwise', () => {
    BackgroundUtils.updateTabIcon({tabId: 7, isOn: true, isMpv: true, mpvError: null});
    expect(calls.badge).toEqual({text: '', tabId: 7});
    expect(calls.title).toEqual({title: 'FastStream - Playing in MPV', tabId: 7});
  });
});
