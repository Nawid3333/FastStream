import {MessageTypes} from '../enums/MessageTypes.mjs';
import {RequestUtils} from './RequestUtils.mjs';
import {SubtitleUtils} from './SubtitleUtils.mjs';

/**
 * Fetches the text of the page's subtitle tracks that came as a URL (the background's
 * SOURCES), with the page's Origin and Referer. A track that cannot be fetched is left
 * out: requestSimple answers a network error with no request at all, and reading its
 * status threw - every track was lost, the page's fullscreen state was not taken over,
 * and the background never got its answer (main.mjs recieveSources, until 2026-10-05).
 * @param {Array<Object>} subs - The tracks: {source, headers, data?, label, language}.
 * @return {Promise<Array<Object>>} Those with their text (data).
 */
export async function loadSubtitles(subs) {
  await Promise.all(subs.map(async (sub) => {
    if (sub && !sub.data && sub.source) {
      try {
        const headers = sub.headers || [];
        const customHeaderCommands = headers.filter((header) => {
          const name = String(header?.name || '').toLowerCase();
          return name === 'origin' || name === 'referer';
        }).map((header) => {
          return {
            operation: 'set',
            header: header.name.toLowerCase(),
            value: header.value,
          };
        });

        await chrome.runtime.sendMessage({
          type: MessageTypes.SET_HEADERS,
          url: sub.source,
          commands: customHeaderCommands,
        });
        const xhr = await RequestUtils.requestSimple({url: sub.source, responseType: 'arraybuffer'});
        if (xhr && (xhr.status === 200 || xhr.status === 206)) {
          const body = SubtitleUtils.decodeSubtitleBytes(xhr.response, xhr.getResponseHeader('Content-Type'));
          if (body) {
            sub.data = body;
          }
        }
      } catch (e) {
        console.warn('A subtitle track could not be loaded', sub.source, e);
      }
    }
  }));
  return subs.filter((sub) => sub && sub.data);
}
