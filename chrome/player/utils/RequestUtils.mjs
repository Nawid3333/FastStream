// @ts-check
import {MessageTypes} from '../enums/MessageTypes.mjs';
import {EnvUtils} from './EnvUtils.mjs';


/** @typedef {Object<string, (string|null|undefined)>} QueryParams */
export const SpecialHeaders = [
  'origin',
  'referer',
  'user-agent',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'x-client-data',
  'cookie',
];

/**
 * The parts of an XMLHttpRequest the callers read, filled from a fetch(). status is 0 when the
 * request failed outright (network error, refused, body cut off), as an XMLHttpRequest's was.
 */
export class RequestResult {
  /** @param {string} responseType - '' or 'text', 'json', 'arraybuffer' or 'blob'. */
  constructor(responseType) {
    this.responseType = responseType;
    this.status = 0;
    this.statusText = '';
    this.responseURL = '';
    /** @type {*} */
    this.response = null;
    /** @type {?Headers} */
    this.headers = null;
  }

  /**
   * Throws for a responseType other than text, like XMLHttpRequest's.
   * @return {string}
   */
  get responseText() {
    if (this.responseType !== '' && this.responseType !== 'text') {
      throw new DOMException(`responseText is only for a text response, not "${this.responseType}"`, 'InvalidStateError');
    }
    return this.response ?? '';
  }

  /**
   * @param {string} name
   * @return {?string}
   */
  getResponseHeader(name) {
    return this.headers ? this.headers.get(name) : null;
  }

  /**
   * @return {string} Every header as XMLHttpRequest gives them: "name: value" lines, CRLF.
   */
  getAllResponseHeaders() {
    if (!this.headers) return '';
    let text = '';
    for (const [name, value] of this.headers) text += `${name}: ${value}\r\n`;
    return text;
  }
}

/**
 * @param {Response} response
 * @param {(progress: {loaded: number, total: number, lengthComputable: boolean}) => void} onProgress
 * @return {Promise<Response>} The whole body, readable as text, ArrayBuffer or Blob again.
 */
async function readWithProgress(response, onProgress) {
  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  /** @type {BlobPart[]} */
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(/** @type {Uint8Array<ArrayBuffer>} */ (value));
    loaded += value.byteLength;
    onProgress({loaded, total, lengthComputable: total > 0});
  }
  return new Response(new Blob(chunks), {headers: response.headers});
}

export class RequestUtils {
  /**
   * @param {Object<string, (string|boolean)>} headers
   * @return {{customHeaderCommands: FSHeaderCommand[], regularHeaders: Object<string, (string|boolean)>}} The
   *   special headers as commands for a header rule, and the rest.
   */
  static splitSpecialHeaders(headers) {
    /** @type {FSHeaderCommand[]} */
    const customHeaderCommands = [];
    /** @type {Object<string, (string|boolean)>} */
    const regularHeaders = {};
    for (const header in headers) {
      if (!Object.hasOwn(headers, header)) continue;
      const name = header.toLowerCase();
      if (SpecialHeaders.includes(name)) {
        if (headers[header] === false) {
          customHeaderCommands.push({operation: 'remove', header});
        } else {
          customHeaderCommands.push({operation: 'set', header, value: /** @type {string} */ (headers[header])});
        }
      } else {
        regularHeaders[header] = headers[header];
      }
    }
    return {customHeaderCommands, regularHeaders};
  }
  /**
   * @param {Object} options
   * @param {string} options.url
   * @param {string} [options.method]
   * @param {string} [options.type] - Alias for method.
   * @param {Object<string, string>} [options.headers]
   * @param {QueryParams} [options.query]
   * @param {string} [options.responseType] - '' or 'text', 'json', 'arraybuffer' or 'blob'.
   * @param {{start: number, end: number}} [options.range]
   * @param {(progress: {loaded: number, total: number, lengthComputable: boolean}) => void} [options.onProgress]
   * @param {boolean} [options.usePlusForSpaces]
   * @param {any} [options.data]
   * @param {any} [options.body] - Alias for data.
   * @param {Array<Object>} [options.header_commands]
   * @return {Promise<RequestResult>} Resolves failed or not.
   */
  static async request(options) {
    const responseType = options.responseType || '';
    if (!['', 'text', 'json', 'arraybuffer', 'blob'].includes(responseType)) {
      throw new Error(`RequestUtils.request: no responseType "${responseType}"`);
    }
    let query = '';
    if (options.query) {
      query = '?' + Object.keys(options.query).filter((key) => {
        return /** @type {QueryParams} */ (options.query)[key] !== undefined && /** @type {QueryParams} */ (options.query)[key] !== null && /** @type {QueryParams} */ (options.query)[key] !== '';
      }).map((key) => {
        if (options.usePlusForSpaces) {
          return encodeURIComponent(key) + '=' + encodeURIComponent(/** @type {Object<string, string>} */ (options.query)[key]).replace(/%20/g, '+');
        }
        return encodeURIComponent(key) + '=' + encodeURIComponent(/** @type {Object<string, string>} */ (options.query)[key]);
      }).join('&');
    }
    const headers = new Headers();
    if (options.range !== undefined) {
      headers.set('Range', 'bytes=' + options.range.start + '-' + options.range.end);
    }
    if (options.headers) {
      for (const name in options.headers) {
        if (Object.hasOwn(options.headers, name)) {
          headers.append(name, options.headers[name]);
        }
      }
    }

    if (options.header_commands && EnvUtils.isExtension()) {
      await chrome.runtime.sendMessage({
        type: MessageTypes.SET_HEADERS,
        url: options.url,
        commands: options.header_commands,
      });
    }

    const method = options.method || options.type || 'GET';
    const result = new RequestResult(responseType);
    try {
      const response = await fetch(options.url + query, {
        method,
        headers,
        // fetch() refuses a body for GET and HEAD.
        body: /^(GET|HEAD)$/i.test(method) ? undefined : (options.data || options.body),
      });
      result.status = response.status;
      result.statusText = response.statusText;
      result.responseURL = response.url;
      result.headers = response.headers;
      const body = options.onProgress && response.body ? await readWithProgress(response, options.onProgress) : response;
      if (responseType === 'arraybuffer') {
        result.response = await body.arrayBuffer();
      } else if (responseType === 'blob') {
        result.response = await body.blob();
      } else {
        const text = await body.text();
        if (responseType === 'json') {
          try {
            result.response = JSON.parse(text);
          } catch (e) {
            result.response = null;
          }
        } else {
          result.response = text;
        }
      }
    } catch (e) {
      result.status = 0;
      result.response = null;
    }
    return result;
  }
  /**
   * @param {{url: string, method?: string, type?: string, headers?: Object<string, string>, query?: QueryParams, responseType?: string, range?: {start: number, end: number}, onProgress?: (progress: {loaded: number, total: number, lengthComputable: boolean}) => void, usePlusForSpaces?: boolean, data?: *, body?: *, header_commands?: Array<Object>}|string} details - Request details or URL string.
   * @param {Function} [callback] - callback(error, xhr, body).
   * @return {Promise<RequestResult|undefined>} Undefined when request() threw.
   */
  static async requestSimple(details, callback) {
    if (typeof details === 'string') {
      details = {
        url: details,
      };
    }
    let xhr;
    try {
      xhr = await this.request(details);
    } catch (e) {
      console.warn(e);
      if (callback) callback(e, xhr, false);
      return xhr;
    }

    if (xhr.status !== 200 && xhr.status !== 206) {
      if (callback) {
        callback(new Error(`Bad status code: ${xhr.status}`), xhr, false);
      }
      return xhr;
    }

    if (callback) {
      callback(undefined, xhr, xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : xhr.response);
    }
    return xhr;
  }
}
