// @ts-check
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {RequestUtils} from './RequestUtils.mjs';
import {SubtitleUtils} from './SubtitleUtils.mjs';

/**
 * A subtitle track as the SOURCES message carries it.
 * @typedef {{source: string, headers?: Array<{name: string, value?: string}>, data?: string,
 *   label: string, language?: string}} SentSubtitle
 */

/**
 * Fetches the tracks that came as a URL, with the page's Origin and Referer. One that fails
 * is left out and must not throw: the caller's other work waits on this.
 * @param {SentSubtitle[]} subs
 * @return {Promise<SentSubtitle[]>} Those with their text (data).
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
