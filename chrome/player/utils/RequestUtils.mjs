import {MessageTypes} from '../enums/MessageTypes.mjs';
import {LargeBuffer} from '../modules/LargeBuffer.mjs';
import {EnvUtils} from './EnvUtils.mjs';
import {URLUtils} from './URLUtils.mjs';


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
 * What RequestUtils.request() resolves with: the parts of an XMLHttpRequest its callers
 * read, filled from a fetch() (it was an XMLHttpRequest until 2026-10-06). status is 0 when
 * the request failed outright - a network error, a refused request, a body cut off - as an
 * XMLHttpRequest's was.
 */
export class RequestResult {
  /** @param {string} responseType - '' or 'text', 'json', 'arraybuffer' or 'blob'. */
  constructor(responseType) {
    this.responseType = responseType;
    this.status = 0;
    this.statusText = '';
    this.responseURL = '';
    this.response = null;
    /** @type {?Headers} */
    this.headers = null;
  }

  /**
   * The body as text, for a text response; like XMLHttpRequest's, it throws for any other
   * responseType.
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
   * @return {?string} The header's value, null when there is none.
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
 * Reads a response's body piece by piece, telling onProgress how far it got.
 * @param {Response} response
 * @param {function({loaded: number, total: number, lengthComputable: boolean})} onProgress
 * @return {Promise<Response>} The whole body, readable as text, ArrayBuffer or Blob again.
 */
async function readWithProgress(response, onProgress) {
  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    onProgress({loaded, total, lengthComputable: total > 0});
  }
  return new Response(new Blob(chunks), {headers: response.headers});
}

/**
 * Utility functions for HTTP requests and header manipulation.
 */
export class RequestUtils {
  /**
   * Splits headers into special and regular headers for custom handling.
   * @param {Object} headers - The headers object.
   * @return {Object} An object with customHeaderCommands and regularHeaders.
   */
  static splitSpecialHeaders(headers) {
    const customHeaderCommands = [];
    const regularHeaders = {};
    for (const header in headers) {
      if (!Object.hasOwn(headers, header)) continue;
      const name = header.toLowerCase();
      if (SpecialHeaders.includes(name)) {
        if (headers[header] === false) {
          customHeaderCommands.push({operation: 'remove', header});
        } else {
          customHeaderCommands.push({operation: 'set', header, value: headers[header]});
        }
      } else {
        regularHeaders[header] = headers[header];
      }
    }
    return {customHeaderCommands, regularHeaders};
  }
  /**
   * Makes an HTTP request with fetch() and various options.
   * @param {Object} options - Request options.
   * @param {string} options.url - The request URL.
   * @param {string} [options.method] - HTTP method (GET, POST, etc.).
   * @param {Object} [options.headers] - Headers to set.
   * @param {Object} [options.query] - Query parameters.
   * @param {string} [options.responseType] - Response type: '' or 'text', 'json',
   *   'arraybuffer' or 'blob'.
   * @param {Object} [options.range] - Byte range for partial requests.
   * @param {Function} [options.onProgress] - Progress callback, with {loaded, total,
   *   lengthComputable} for each piece of the body.
   * @param {boolean} [options.usePlusForSpaces] - Use plus for spaces in query.
   * @param {any} [options.data] - Data to send in the request body.
   * @param {any} [options.body] - Alias for data.
   * @param {Array} [options.header_commands] - Custom header commands for extension.
   * @return {Promise<RequestResult>} Resolves with what the request got, failed or not.
   */
<<<<<<< HEAD
  static async request(options) {
    const responseType = options.responseType || '';
    if (!['', 'text', 'json', 'arraybuffer', 'blob'].includes(responseType)) {
      throw new Error(`RequestUtils.request: no responseType "${responseType}"`);
    }
    let query = '';
    if (options.query) {
      query = '?' + Object.keys(options.query).filter((key) => {
        return options.query[key] !== undefined && options.query[key] !== null && options.query[key] !== '';
      }).map((key) => {
        if (options.usePlusForSpaces) {
          return encodeURIComponent(key) + '=' + encodeURIComponent(options.query[key]).replace(/%20/g, '+');
        }
        return encodeURIComponent(key) + '=' + encodeURIComponent(options.query[key]);
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
      // A refusal rejects request(), as it did.
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
        // XMLHttpRequest dropped a body for GET and HEAD; fetch() refuses one.
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
          // As XMLHttpRequest's: null for a body that is not JSON.
          try {
            result.response = JSON.parse(text);
          } catch (e) {
            result.response = null;
          }
        } else {
          result.response = text;
=======
  static request(options) {
    return new Promise(async (resolve, reject) => {
      try {
        const xmlHttp = new XMLHttpRequest();
        options.xmlHttp = xmlHttp;
        if (options.responseType !== undefined) xmlHttp.responseType = options.responseType;
        let sent = false;
        xmlHttp.addEventListener('load', function() {
          if (sent) return;
          sent = true;
          resolve(xmlHttp);
        });
        xmlHttp.addEventListener('error', () => {
          if (sent) return;
          sent = true;
          resolve(xmlHttp);
        });
        xmlHttp.addEventListener('timeout', () => {
          if (sent) return;
          sent = true;
          resolve(xmlHttp);
        });
        xmlHttp.addEventListener('abort', () => {
          if (sent) return;
          sent = true;
          resolve(xmlHttp);
        });

        xmlHttp.addEventListener('progress', (e) => {
          if (options.onProgress) options.onProgress(e);
        });

        let query = '';
        if (options.query) {
          query = '?' + Object.keys(options.query).filter((key) => {
            return options.query[key] !== undefined && options.query[key] !== null && options.query[key] !== '';
          }).map((key) => {
            if (options.usePlusForSpaces) {
              return encodeURIComponent(key) + '=' + encodeURIComponent(options.query[key]).replace(/%20/g, '+');
            }
            return encodeURIComponent(key) + '=' + encodeURIComponent(options.query[key]);
          }).join('&');
        }
        const method = options.method || options.type || 'GET';

        xmlHttp.open(method, options.url + query, true); // true for asynchronous
        if (options.range !== undefined) {
          xmlHttp.setRequestHeader('Range', 'bytes=' + options.range.start + '-' + options.range.end);
        }

        // xmlHttp.setRequestHeader('Origin', '');
        if (options.headers) {
          for (const name in options.headers) {
            if (Object.hasOwn(options.headers, name)) {
              xmlHttp.setRequestHeader(name, options.headers[name]);
            }
          }
        }

        if (options.header_commands) {
          if (EnvUtils.isExtension()) {
            await chrome.runtime.sendMessage({
              type: MessageTypes.SET_HEADERS,
              url: options.url,
              commands: options.header_commands,
            });
          }
>>>>>>> upstream/main
        }


        xmlHttp.send(options.data || options.body);
      } catch (e) {
        reject(e);
      }
<<<<<<< HEAD
    } catch (e) {
      // A network error, a refused request or a body cut off: what XMLHttpRequest gave, a
      // status of 0 and no response, for the caller to check like any other status.
      result.status = 0;
      result.response = null;
    }
    return result;
=======
    });
>>>>>>> upstream/main
  }
  /**
   * Makes a simple HTTP request and returns what it got.
   * @param {Object|string} details - Request details or URL string.
   * @param {Function} [callback] - Optional callback(error, xhr, body): body is the
   *   responseText, or with a details.responseType other than text, the response.
   * @return {Promise<RequestResult|undefined>} Resolves with request()'s result, undefined when
   *   request() threw.
   */
  static async requestSimple(details, callback) {
    if (typeof details === 'string') {
      details = {
        url: details,
      };
    }
    // use request()
    let xhr;
    try {
      xhr = await this.request(details);
    } catch (e) {
      console.warn(e);
      if (callback) callback(e, xhr, false);
      return xhr;
    }

    // check error
    if (xhr.status !== 200 && xhr.status !== 206) {
      if (callback) {
        callback(new Error(`Bad status code: ${xhr.status}`), xhr, false);
      }
      return xhr;
    }

    // success (responseText throws for any responseType but text)
    if (callback) {
      callback(undefined, xhr, xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : xhr.response);
    }
    return xhr;
  }

  /**
   * Downloads a large file in fragments using range requests and returns a LargeBuffer.
   * The fragments are fetched as the buffer is read, not up front, so `source` has to stay
   * reachable until the last byte has been read.
   * @param {string} source - The URL of the large file.
   * @param {number} [fragSize] - Bytes per range request.
   * @return {Promise<LargeBuffer>} Resolves with a LargeBuffer containing the file data.
   * @throws {Error} If the request fails or headers are missing.
   */
  static async httpGetLarge(source, fragSize = 1e9 / 4) {
    const headersXHR = await this.request({
      url: source,
      responseType: 'arraybuffer',
      range: {
        start: 0,
        end: 1,
      },
    });

    if (headersXHR.status !== 200 && headersXHR.status !== 206) {
      throw new Error('Bad status code');
    }

    const headers = URLUtils.headersStringToObj(headersXHR.getAllResponseHeaders());
    const range = headers['content-range'];
    if (!range) {
      throw new Error('No content-range header');
    }

    const s = range.split('/');
    const contentLength = parseInt(s[1]);
    if (!contentLength) {
      throw new Error('No content length');
    }

    const fragCount = Math.ceil(contentLength / fragSize);
    const buffer = new LargeBuffer(contentLength, fragCount);
    await buffer.initialize(async (i) => {
      if (i >= fragCount) {
        throw new Error('Fragment index ' + i + ' out of range');
      }
      const start = i * fragSize;
      const end = Math.min(i * fragSize + fragSize - 1, contentLength - 1);
      const xhr = await this.request({
        url: source,
        responseType: 'arraybuffer',
        range: {
          start,
          end,
        },
      });
      if (xhr.status !== 200 && xhr.status !== 206) {
        throw new Error('Bad status code');
      }
      return new Uint8Array(xhr.response);
    });

    return buffer;
  }
}
