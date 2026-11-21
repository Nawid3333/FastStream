import {describe, expect, it} from 'vitest';

import {youTubeVideo} from '../../chrome/background/YouTubeVideo.mjs';

const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;

describe('youTubeVideo', () => {
  it('turns every kind of link to one video into its watch address', () => {
    for (const link of [
      WATCH,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}&feature=share`,
      `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
      `https://www.youtube.com/watch?app=desktop&v=${ID}&list=PL0123456789&index=3`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/shorts/${ID}/`,
      `https://www.youtube.com/live/${ID}?si=abc`,
      `https://youtu.be/${ID}?si=abc`,
      `http://youtu.be/${ID}`,
      // A trailing slash, as some pages write them.
      `https://youtu.be/${ID}/`,
      `https://www.youtube.com/watch/?v=${ID}`,
      `https://www.youtube.com/live/${ID}/`,
    ]) {
      expect(youTubeVideo(link)?.url, link).toBe(WATCH);
    }
  });

  it('keeps the start time a link names, in seconds', () => {
    expect(youTubeVideo(`${WATCH}&t=42`)?.start).toBe(42);
    expect(youTubeVideo(`${WATCH}&t=42s`)?.start).toBe(42);
    expect(youTubeVideo(`https://youtu.be/${ID}?t=1h2m3s`)?.start).toBe(3723);
    expect(youTubeVideo(`https://youtu.be/${ID}?t=2m`)?.start).toBe(120);
    expect(youTubeVideo(`https://www.youtube.com/live/${ID}?start=90`)?.start).toBe(90);
    expect(youTubeVideo(WATCH)?.start).toBeUndefined();
    expect(youTubeVideo(`${WATCH}&t=0`)?.start).toBeUndefined();
    expect(youTubeVideo(`${WATCH}&t=soon`)?.start).toBeUndefined();
  });

  it('is null for anything that is not one video', () => {
    for (const page of [
      'https://www.youtube.com/',
      'https://www.youtube.com/results?search_query=x',
      'https://www.youtube.com/playlist?list=PL0123456789',
      'https://www.youtube.com/@channel',
      `https://www.youtube.com/embed/${ID}`,
      'https://www.youtube.com/watch',
      'https://www.youtube.com/watch?v=short',
      `https://www.youtube.com/watch?v=${ID}x`,
      `https://www.youtube.com/watch?v=${ID.slice(0, 10)}%22`,
      `https://www.youtube.com.evil.test/watch?v=${ID}`,
      `https://evil.test/watch?v=${ID}`,
      `https://youtu.be/${ID}/more`,
      `ftp://youtu.be/${ID}`,
      `javascript:alert(1)//https://youtu.be/${ID}`,
      'not a url',
      '',
      undefined,
      42,
    ]) {
      expect(youTubeVideo(page), String(page)).toBeNull();
    }
  });
});
