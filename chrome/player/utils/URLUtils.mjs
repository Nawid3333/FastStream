// @ts-check
import {PlayerModes} from '../enums/PlayerModes.mjs';

const ModesMap = new Map();
ModesMap.set('webm', PlayerModes.DIRECT);
ModesMap.set('mp4', PlayerModes.ACCELERATED_MP4);
ModesMap.set('m3u8', PlayerModes.ACCELERATED_HLS);
ModesMap.set('m3u8v1', PlayerModes.ACCELERATED_HLS);
ModesMap.set('m3u', PlayerModes.ACCELERATED_HLS);
ModesMap.set('mpd', PlayerModes.ACCELERATED_DASH);

ModesMap.set('vmpatch', PlayerModes.ACCELERATED_VM);

/**
 * Utility functions for working with URLs and extracting identifiers.
 */
export class URLUtils {
  /**
  * @param {string} urlStr
  */
  static is_url(urlStr) {
    try {
      new URL(urlStr);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
  * @param {string} url
  */
  static get_url_params(url) {
    try {
      const urlObj = new URL(url);
      const params = new Map();
      urlObj.searchParams.forEach((value, key) =>{
        params.set(key, value);
      });
      return params;
    } catch (e) {
      return new Map();
    }
  }

  /**
  * @param {string} url
  * @param {string} name
  */
  static get_param(url, name) {
    try {
      const urlObj = new URL(url);
      return urlObj.searchParams.get(name);
    } catch (e) {
      return null;
    }
  }
  /**
   * The URL with FastStream's time (its faststream-timestamp parameter) set, or taken off,
   * and everything else as it was, byte for byte. URLSearchParams writes the whole query
   * anew, a '=' in a value as %3D, and a signed link is then refused: vidmoly's
   * t=…= became t=…%3D, and every segment after a rebuild at a time got a 403 (#592).
   * @param {string} url
   * @param {?number} seconds - The time, or null to take it off.
   * @return {string}
   */
  static withTimestamp(url, seconds) {
    const hashAt = url.indexOf('#');
    const hash = hashAt === -1 ? '' : url.slice(hashAt);
    const rest = hashAt === -1 ? url : url.slice(0, hashAt);
    const queryAt = rest.indexOf('?');
    const query = queryAt === -1 ? [] : rest.slice(queryAt + 1).split('&');
    const kept = query.filter((part) => !/^faststream-timestamp(=|$)/.test(part));
    if (seconds === null && kept.length === query.length) {
      return url;
    }
    if (seconds !== null) {
      kept.push('faststream-timestamp=' + seconds);
    }
    const base = queryAt === -1 ? rest : rest.slice(0, queryAt);
    return base + (kept.length ? '?' + kept.join('&') : '') + hash;
  }

  /**
  * @param {string} url
  */
  static strip_queryhash(url) {
    return url.split(/[#?]/)[0];
  }

  // A plain url.includes(domain) also matches an attacker host that merely
  // contains the domain as a substring, e.g. evil.com/vimeo.com or
  // vimeo.com.evil.com. This checks the actual hostname instead.
  /**
  * @param {string} url
  * @param {string} domain
  */
  static hostnameMatches(url, domain) {
    try {
      const hostname = new URL(url).hostname;
      return hostname === domain || hostname.endsWith(`.${domain}`);
    } catch (e) {
      return false;
    }
  }

  // The protocols a <video> or <audio> may load a source from: the web, a file the user
  // picked or dropped (blob:), an inline one (data:) and a local file opened in the tab.
  static PlayableProtocols = ['http:', 'https:', 'blob:', 'data:', 'file:'];

  // The source as an absolute URL when it has one of those protocols, else null. A source
  // can come from the player's address or the sources browser's text field, so a
  // `javascript:` one must not reach `video.src`.
  /**
  * @param {string} url
  * @param {string} base
  */
  static playableUrl(url, base) {
    let parsed;
    try {
      parsed = new URL(url, base);
    } catch (e) {
      return null;
    }
    return URLUtils.PlayableProtocols.includes(parsed.protocol) ? parsed.href : null;
  }

  /**
  * @param {string} url
  */
  static get_url_extension(url) {
    // The last path segment's extension only: a dot in the host or in a folder is none.
    // https://e.com/stream has no extension (it gave 'com/stream'), and a bare host
    // https://example.mp4 is no MP4. Also given file names, which have no scheme.
    let path = this.strip_queryhash(url).trim();
    const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path);
    if (authority) {
      path = path.substring(authority[0].length);
    }
    const name = path.substring(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.substring(dot + 1).trim().toLowerCase();
  }

  /**
  * @param {string} ext
  */
  static getModeFromExtension(ext) {
    return ModesMap.get(ext);
  }

  /**
  * @param {string} url
  */
  static getModeFromURL(url) {
    const ext = URLUtils.get_url_extension(url);
    return URLUtils.getModeFromExtension(ext) || PlayerModes.DIRECT;
  }


  /**
  * @param {string} str
  */
  static validateHeadersString(str) {
    const lines = str.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const split = line.split(':');
      if (line.trim() === '') continue;

      if (split.length > 1) {
        const name = split[0].trim();
        const value = split.slice(1).join(':').trim();
        if (name.length === 0 || value.length === 0) {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }

  /**
  * @param {Object<string, string>} obj
  */
  static objToHeadersString(obj) {
    let str = '';
    for (const name in obj) {
      if (Object.hasOwn(obj, name)) {
        let cased = name;
        // Pascal case
        cased = cased.replace(/\w+/g,
            (w) =>{
              return w[0].toUpperCase() + w.slice(1).toLowerCase();
            });

        str += `${cased}: ${obj[name]}\n`;
      }
    }
    return str;
  }

  /**
  * @param {string} str
  */
  static headersStringToObj(str) {
    /** @type {Object<string, string>} */
    const obj = {};
    const lines = str.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const split = line.split(':');
      if (split.length > 1) {
        obj[split[0].trim().toLowerCase()] = split.slice(1).join(':').trim();
      }
    }
    return obj;
  }
}

