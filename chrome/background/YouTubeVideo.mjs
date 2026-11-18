// @ts-check

/** FastStream finds no YouTube stream; mpv opens the video's page with yt-dlp (docs/notes/mpv.md, "YouTube in mpv"). */

const WatchHosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'];
const PathIdPrefixes = ['/shorts/', '/live/'];
const VideoId = /^[\w-]{11}$/;
// t=90, t=90s, t=1h2m3s, t=2m
const StartTime = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;

/**
 * @param {?string} value
 * @return {number|undefined}
 */
function startSeconds(value) {
  const parts = value ? StartTime.exec(value) : null;
  if (!parts) {
    return undefined;
  }
  const [hours, minutes, seconds] = parts.slice(1).map((part) => Number(part || 0));
  const total = hours * 3600 + minutes * 60 + seconds;
  return total >= 1 ? total : undefined;
}

/**
 * The video a YouTube link or page shows: its own watch address, without list= and the like,
 * which is also the key mpv resumes it by.
 * @param {*} address
 * @return {?{url: string, start: number|undefined}} null for anything that is not one video.
 */
export function youTubeVideo(address) {
  if (typeof address !== 'string') {
    return null;
  }
  let url;
  try {
    url = new URL(address);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }
  let id = null;
  if (url.hostname === 'youtu.be') {
    id = url.pathname.slice(1);
  } else if (WatchHosts.includes(url.hostname)) {
    if (url.pathname === '/watch') {
      id = url.searchParams.get('v');
    } else {
      const prefix = PathIdPrefixes.find((p) => url.pathname.startsWith(p));
      id = prefix ? url.pathname.slice(prefix.length).replace(/\/$/, '') : null;
    }
  }
  if (!id || !VideoId.test(id)) {
    return null;
  }
  return {
    url: `https://www.youtube.com/watch?v=${id}`,
    start: startSeconds(url.searchParams.get('t') || url.searchParams.get('start')),
  };
}
