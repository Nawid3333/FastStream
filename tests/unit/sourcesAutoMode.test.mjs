import {expect, it, vi} from 'vitest';
import {FakeDocument} from './helpers/fakeDom.mjs';

// A new row in the Sources window starts on "Auto", which takes the mode from the address when the address field is
// left. Play with the field still being typed in (a tap on Android need not leave it) found "Auto" and only said
// "Please select a player mode!". Play now takes the mode from the address too.

const doc = new FakeDocument('<html><body></body></html>');
vi.stubGlobal('document', doc);
vi.stubGlobal('window', {getSelection: () => ({selectAllChildren() {}, removeAllRanges() {}})});
doc.createTextNode = (text) => Object.assign(doc.createElement('#text'), {textContent: text});
const el = (tag = 'div') => doc.body.appendChild(doc.createElement(tag));

vi.mock('../../chrome/player/ui/DOMElements.mjs', () => ({DOMElements: {}}));
vi.mock('../../chrome/player/modules/Localize.mjs', () => ({Localize: {getMessage: (key) => key}}));
vi.mock('../../chrome/player/utils/InterfaceUtils.mjs', () => ({InterfaceUtils: {}}));

const {WebUtils} = await import('../../chrome/player/utils/WebUtils.mjs');
vi.spyOn(WebUtils, 'createSVGIcon').mockImplementation(() => document.createElement('svg'));
const {SourcesBrowser} = await import('../../chrome/player/ui/SourcesBrowser.mjs');
const {VideoSource} = await import('../../chrome/player/VideoSource.mjs');
const {PlayerModes} = await import('../../chrome/player/enums/PlayerModes.mjs');

it('plays a new row on Play with the mode its address names, the field not left yet', async () => {
  const client = {setSource: vi.fn(async () => {}), play: vi.fn(async () => {})};
  const browser = {linkui: {sourcesList: el()}, updateSources() {}, client};
  const source = new VideoSource('', null, PlayerModes.AUTO);
  SourcesBrowser.prototype.setupSourceListing.call(browser, source);
  const {url, mode, setBtn} = source.sourceBrowserElements;

  url.value = 'https://cdn.test/v/master.m3u8';
  url.fire('input');
  setBtn.fire('click');
  await vi.waitFor(() => expect(client.setSource).toHaveBeenCalledTimes(1));

  expect(client.setSource.mock.calls[0][0].mode).toBe(PlayerModes.ACCELERATED_HLS);
  // The row shows the mode it plays with, and offers no "Auto" any more.
  const options = Array.from(mode.children[1].children);
  expect(options.some((option) => option.dataset.val === PlayerModes.AUTO)).toBe(false);
});

// A link copied with the Sources window's Copy button carries its headers and mode in the address. Pasted and played
// with the field not left, the address went out with them unread: no headers, and their query in the request.
it('reads a copied link\'s headers and mode at Play, the field not left yet', async () => {
  const client = {setSource: vi.fn(async () => {}), play: vi.fn(async () => {})};
  const browser = {linkui: {sourcesList: el()}, updateSources() {}, client};
  const source = new VideoSource('', null, PlayerModes.AUTO);
  SourcesBrowser.prototype.setupSourceListing.call(browser, source);
  const {url, setBtn} = source.sourceBrowserElements;
  const copied = new VideoSource('https://cdn.test/v/clip', {Referer: 'https://site.test/'}, PlayerModes.ACCELERATED_HLS);

  url.value = copied.toCopyURL().toString();
  url.fire('input');
  setBtn.fire('click');
  await vi.waitFor(() => expect(client.setSource).toHaveBeenCalledTimes(1));

  const played = client.setSource.mock.calls[0][0];
  expect(played.url).toBe('https://cdn.test/v/clip');
  // Header names in lower case, as the player keeps them.
  expect(played.headers).toEqual({referer: 'https://site.test/'});
  expect(played.mode).toBe(PlayerModes.ACCELERATED_HLS);
});
