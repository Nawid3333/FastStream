// An HLS playlist as long as a spec needs - an episode beside an ad - from the hls-ts
// fixture's segments, played over and over.

import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = path.resolve(import.meta.dirname, 'fixtures/hls-ts/index.m3u8');

/**
 * Builds the playlist.
 * @param {number} seconds - Its length: a multiple of the fixture's 9 s.
 * @param {string} segmentPath - Where the spec serves the fixture's segments, as '/hls-ts/'.
 * @return {string} The playlist.
 */
export function loopedPlaylist(seconds, segmentPath) {
  const fixture = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/);
  const segments = [];
  fixture.forEach((line, i) => {
    if (line.startsWith('#EXTINF:')) {
      segments.push({extinf: line, uri: segmentPath + fixture[i + 1], length: parseFloat(line.slice('#EXTINF:'.length))});
    }
  });

  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXT-X-PLAYLIST-TYPE:VOD'];
  let total = 0;
  for (let loop = 0; total < seconds; loop++) {
    // Each loop starts the fixture's timestamps over.
    if (loop > 0) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    for (const segment of segments) {
      lines.push(segment.extinf, segment.uri);
      total += segment.length;
    }
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}
