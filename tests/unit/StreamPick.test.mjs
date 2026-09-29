import {describe, expect, it} from 'vitest';

import {PIECE_LENGTH} from '../../chrome/player/utils/StreamLength.mjs';
import {StreamPick} from '../../chrome/player/utils/StreamPick.mjs';

const source = (name, duration) => ({url: `https://cdn.example/${name}`, duration});
const urls = (sources) => sources && sources.map((s) => s.url);

describe('StreamPick.played', () => {
  const episode = source('episode.m3u8', 1337);
  const nextEpisode = source('next.m3u8', 1420);
  const ad = source('ad.mp4', 30);

  it('tells nothing without a video, or when the video tells nothing', () => {
    expect(StreamPick.played([episode, nextEpisode], null)).toBeNull();
    expect(StreamPick.played([episode, nextEpisode], {src: '', duration: null, before: null})).toBeNull();
    expect(StreamPick.played([episode, nextEpisode], {src: 'blob:https://site.example/1', duration: NaN})).toBeNull();
  });

  it('takes the file the video plays, over a longer stream', () => {
    const film = source('film.mp4', 160);
    const extra = source('extra.m3u8', 720);
    expect(urls(StreamPick.played([film, extra], {src: film.url, duration: 160}))).toEqual([film.url]);
    // The file's own length, when the video has not read it yet.
    expect(urls(StreamPick.played([film, extra], {src: film.url, duration: null}))).toEqual([film.url]);
  });

  it('takes the stream as long as the video, over a longer one', () => {
    // An MSE player: a blob: URL, and the manifest's length.
    const video = {src: '', duration: 1337.4};
    expect(urls(StreamPick.played([episode, nextEpisode], video))).toEqual([episode.url]);
  });

  it('keeps every stream as long as the video: its variants, its audio', () => {
    const variant = source('episode-720p.m3u8', 1337.2);
    const audio = source('episode-audio.m3u8', 1336);
    const played = StreamPick.played([episode, variant, audio, nextEpisode], {duration: 1337});
    expect(urls(played)).toEqual([episode.url, variant.url, audio.url]);
  });

  it('matches within 3 s, or a quarter of a percent of a long video', () => {
    expect(StreamPick.sameLength(1339, 1337)).toBe(true);
    expect(StreamPick.sameLength(1341, 1337)).toBe(false);
    expect(StreamPick.sameLength(7217, 7200)).toBe(true);
    expect(StreamPick.sameLength(7219, 7200)).toBe(false);
    // A short video: 3 s, more than its quarter of a percent.
    expect(StreamPick.sameLength(62.5, 60)).toBe(true);
    expect(StreamPick.sameLength(63.5, 60)).toBe(false);
  });

  it('never matches a length it does not know, or a piece of a stream', () => {
    for (const duration of [null, undefined, 0, PIECE_LENGTH, NaN]) {
      expect(StreamPick.sameLength(duration, 30)).toBe(false);
      // Not even a video of a second or two, within 3 s of them as numbers.
      expect(StreamPick.sameLength(duration, 1)).toBe(false);
    }
    expect(StreamPick.played([source('seg.mp4', PIECE_LENGTH), source('x.mp4', null)], {duration: 10})).toBeNull();
  });

  it('takes a live stream for a live video, and no recording for it', () => {
    const live = source('live.m3u8', Infinity);
    const vod = source('vod.m3u8', 7200);
    expect(urls(StreamPick.played([vod, live], {duration: Infinity}))).toEqual([live.url]);
    expect(StreamPick.played([vod], {duration: Infinity})).toBeNull();
    // No recording over a live stream: the live stream plays, as it did before.
    expect(StreamPick.played([live, vod], {duration: 7200})).toBeNull();
  });

  it('tells nothing when no stream is as long as the video', () => {
    expect(StreamPick.played([episode, nextEpisode], {duration: 600})).toBeNull();
  });

  it('does not take a short video over a far longer stream: an ad played in the page\'s video', () => {
    // Its file, or its length: the longest play, as they did before.
    expect(StreamPick.played([ad, episode], {src: ad.url, duration: 30})).toBeNull();
    expect(StreamPick.played([ad, episode], {src: '', duration: 30})).toBeNull();
    // An ad whose length was not read counts by the video's.
    const unread = source('ad.mp4', null);
    expect(StreamPick.played([unread, episode], {src: unread.url, duration: 30})).toBeNull();
    // Beside a stream of unknown length, which ranks as ten minutes.
    expect(StreamPick.played([ad, source('stream.m3u8', null)], {src: ad.url, duration: 30})).toBeNull();
  });

  it('takes a short video when nothing far longer plays', () => {
    const clip = source('clip.mp4', 42);
    expect(urls(StreamPick.played([clip, source('other.mp4', 60)], {src: clip.url, duration: 42}))).toEqual([clip.url]);
    // A five-minute video beside a twenty-minute stream: under five times as long.
    const short = source('short.m3u8', 300);
    expect(urls(StreamPick.played([short, source('long.m3u8', 1200)], {duration: 300}))).toEqual([short.url]);
  });

  it('does not take a trailer or a preview over a far longer film, however long it runs', () => {
    const trailer = source('trailer.m3u8', 180);
    const film = source('film.m3u8', 7200);
    expect(StreamPick.played([trailer, film], {duration: 180})).toBeNull();
    // Five times as long is far longer.
    expect(StreamPick.played([source('a.m3u8', 200), source('b.m3u8', 1000)], {duration: 200})).toBeNull();
    expect(urls(StreamPick.played([source('a.m3u8', 201), source('b.m3u8', 1000)], {duration: 201}))).toEqual(['https://cdn.example/a.m3u8']);
  });

  it('measures the video\'s file by the length read from it', () => {
    // Its length read from the file: 30 s, an ad, whatever the video says.
    expect(StreamPick.played([ad, episode], {src: ad.url, duration: 1337})).toBeNull();
  });

  it('with a file of unknown length, decides only among the longest', () => {
    const unknown = source('film.mp4', null);
    const other = source('other.mp4', null);
    // Its file among the longest (both rank as ten minutes): that one.
    expect(urls(StreamPick.played([unknown, other], {src: unknown.url, duration: null}))).toEqual([unknown.url]);
    // Not among them: the longest play.
    expect(StreamPick.played([unknown, episode], {src: unknown.url, duration: null})).toBeNull();
  });
});
