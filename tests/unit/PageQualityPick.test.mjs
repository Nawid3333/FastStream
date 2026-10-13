import {describe, expect, it} from 'vitest';

import {desiredHeight, listForSource, pickQuality} from '../../chrome/player/utils/PageQualityPick.mjs';

// Which of a page's own qualities is played (page-qualities.js lists them): the background
// decides it for mpv, the player for itself, by the user's quality setting.

const LIST = [
  {url: 'https://h.test/1_360p.mp4/', label: '360p', height: 360},
  {url: 'https://h.test/1_720p.mp4/', label: '720p', height: 720},
  {url: 'https://h.test/1.mp4/', label: '1080p', height: 1080},
];

describe('desiredHeight', () => {
  it('reads the quality setting, Auto and anything unreadable as the highest', () => {
    expect(desiredHeight('720p')).toBe(720);
    expect(desiredHeight('2160p')).toBe(2160);
    expect(desiredHeight('Auto')).toBe(Infinity);
    expect(desiredHeight(undefined)).toBe(Infinity);
    expect(desiredHeight('nonsense')).toBe(Infinity);
  });
});

describe('pickQuality', () => {
  it('takes the highest for Auto, and the setting\'s height, or the nearest above it', () => {
    expect(pickQuality(LIST, Infinity).label).toBe('1080p');
    expect(pickQuality(LIST, 720).label).toBe('720p');
    expect(pickQuality(LIST, 480).label).toBe('720p');
    // Nothing at or above: the highest below.
    const low = LIST.slice(0, 2);
    expect(pickQuality(low, 1080).label).toBe('720p');
  });

  it('leaves the page\'s choice when no entry says its height', () => {
    expect(pickQuality([{url: 'a', label: 'Original', height: 0}, {url: 'b', label: 'Mobile', height: 0}], Infinity))
        .toBe(null);
    // One that does not is passed over.
    expect(pickQuality([{url: 'a', label: 'Original', height: 0}, ...LIST], Infinity).label).toBe('1080p');
  });

  it('does not reorder the list it is given', () => {
    const list = [...LIST].reverse();
    pickQuality(list, 480);
    pickQuality(list, Infinity);
    expect(list.map((entry) => entry.label)).toEqual(['1080p', '720p', '360p']);
  });
});

describe('listForSource', () => {
  it('finds the list by the stream\'s URL, or by the address it was redirected from', () => {
    expect(listForSource({url: LIST[1].url}, [LIST])).toEqual(LIST);
    expect(listForSource({url: 'https://cdn.test/remote_control.php?t=1', requestedUrl: LIST[0].url}, [LIST]))
        .toEqual(LIST);
  });

  it('keeps only the files on the host of the one the page plays', () => {
    // A script in the page listing a file elsewhere: it would be fetched with this request's
    // headers.
    const planted = [...LIST, {url: 'https://elsewhere.test/x.mp4', label: '4320p', height: 4320}];
    expect(listForSource({url: LIST[0].url}, [planted])).toEqual(LIST);
    // None left beside it: no list.
    expect(listForSource({url: LIST[0].url}, [[LIST[0], {url: 'https://elsewhere.test/x.mp4', label: '720p', height: 720}]]))
        .toBe(null);
  });

  it('goes on to the next list when the first that holds the file has no other on its host', () => {
    // The <video>'s <source> elements come first (page-qualities.js): the played file and one
    // on another host gave no list, and the player's own list after them was never looked at.
    const sources = [LIST[0], {url: 'https://mirror.test/1_360p.mp4', label: '360p', height: 360}];
    expect(listForSource({url: LIST[0].url}, [sources, LIST])).toEqual(LIST);
  });

  it('takes no list that does not hold the stream\'s file', () => {
    expect(listForSource({url: 'https://cdn.test/other.mp4'}, [LIST])).toBe(null);
    expect(listForSource({url: LIST[0].url}, [])).toBe(null);
    expect(listForSource({url: LIST[0].url}, undefined)).toBe(null);
  });
});
