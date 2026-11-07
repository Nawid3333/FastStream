import {describe, expect, it} from 'vitest';
import {classifyResponse} from '../../chrome/background/StreamDetection.mjs';
import {MultiRegexMatcher} from '../../chrome/background/MultiRegexMatcher.mjs';

// What the background makes of a page's responses (webRequest's onHeadersReceived): nothing,
// a subtitle file, or a stream and its player mode. Each row is a case the code's comments
// record; the listener in background.mjs only acts on the answer (backgroundDetection.test.mjs
// runs it with the rest of the background).

const none = new MultiRegexMatcher();
none.compile();

/**
 * A response as webRequest gives it.
 * @param {string} url
 * @param {Object} [over] - Other fields: statusCode, method, type, headers (name -> value).
 * @return {Object}
 */
function response(url, {statusCode = 200, method = 'GET', type = 'xmlhttprequest', headers = {}} = {}) {
  return {
    url, requestId: 1, statusCode, method, type,
    responseHeaders: Object.entries(headers).map(([name, value]) => ({name, value})),
  };
}

const HLS = {kind: 'source', mode: 'accelerated_hls'};
const DASH = {kind: 'source', mode: 'accelerated_dash'};
const IGNORE = {kind: 'ignore'};

describe('classifyResponse', () => {
  it.each([
    ['an HLS playlist by its extension', response('https://cdn.test/v/master.m3u8'), null, HLS],
    ['a DASH manifest by its extension', response('https://cdn.test/v/manifest.mpd'), null, DASH],
    ['a manifest only its Content-Type names', response('https://cdn.test/v/7', {headers: {'Content-Type': 'application/vnd.apple.mpegurl'}}), null, HLS],
    ['a subtitle file', response('https://cdn.test/subs/en.vtt'), null, {kind: 'subtitles'}],
    ['a client or server error', response('https://cdn.test/v/master.m3u8', {statusCode: 404}), null, IGNORE],
    ['a 204', response('https://cdn.test/v/master.m3u8', {statusCode: 204}), null, IGNORE],
    ['a redirect, whose end is the stream', response('https://host.test/clip.m3u8', {statusCode: 302, headers: {Location: 'https://cdn.test/a'}}), null, IGNORE],
    ['a 302 without a Location: the file itself', response('https://cdn.test/v/master.m3u8', {statusCode: 302}), null, HLS],
    ['a CORS preflight', response('https://cdn.test/v/master.m3u8', {method: 'OPTIONS'}), null, IGNORE],
    ['a HEAD request', response('https://cdn.test/v/master.m3u8', {method: 'HEAD'}), null, IGNORE],
    ['a page at a stream\'s address (the "expired" page)', response('https://host.test/clip.m3u8', {type: 'main_frame', headers: {'Content-Type': 'text/html; charset=utf-8'}}), null, IGNORE],
    ['a media element\'s HTML answer', response('https://host.test/clip.m3u8', {type: 'media', headers: {'Content-Type': 'text/html'}}), null, IGNORE],
    ['a player\'s fetch of a manifest the server calls text/html', response('https://cdn.test/v/master.m3u8', {headers: {'Content-Type': 'text/html'}}), null, HLS],
    ['a proxy a player fetches the stream through', response('https://proxy.test/get?url=https%3A%2F%2Fcdn.test%2Fv%2Fmaster.m3u8'), null, HLS],
    ['a tracking pixel naming the stream in its query', response('https://track.test/px?u=https%3A%2F%2Fcdn.test%2Fv%2Fmaster.m3u8', {type: 'image'}), null, IGNORE],
    ['a stream redirected to an address that names none', response('https://cdn.test/v/7?token=1', {headers: {'Content-Type': 'application/octet-stream'}}), 'https://host.test/v/master.m3u8', HLS],
    ['a proxy link redirected to an address that names none', response('https://cdn.test/s/9f3e', {headers: {'Content-Type': 'application/octet-stream'}}), 'https://proxy.test/p?url=https%3A%2F%2Fcdn.test%2Fv%2Fmaster.m3u8', HLS],
    ['a redirect\'s end that is a page', response('https://host.test/expired', {type: 'main_frame', headers: {'Content-Type': 'text/html'}}), 'https://host.test/clip.m3u8', IGNORE],
    ['nothing a player plays', response('https://cdn.test/app.js', {type: 'script'}), null, IGNORE],
  ])('%s', (_, details, first, expected) => {
    expect(classifyResponse(details, first, none)).toEqual(expected);
  });

  it('takes the type a custom source pattern names', () => {
    const matcher = new MultiRegexMatcher();
    matcher.addRegex('^https://stream\\.test/live/', '', 'm3u8');
    matcher.compile();
    expect(classifyResponse(response('https://stream.test/live/channel-7'), null, matcher)).toEqual(HLS);
    expect(classifyResponse(response('https://stream.test/live/channel-7'), null, none)).toEqual(IGNORE);
  });
});
