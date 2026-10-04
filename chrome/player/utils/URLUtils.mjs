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
  static is_url(urlStr) {
    try {
      new URL(urlStr);
      return true;
    } catch (e) {
      return false;
    }
  }

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

  static get_param(url, name) {
    try {
      const urlObj = new URL(url);
      return urlObj.searchParams.get(name);
    } catch (e) {
      return null;
    }
  }
  static strip_queryhash(url) {
    return url.split(/[#?]/)[0];
  }

  // A plain url.includes(domain) also matches an attacker host that merely
  // contains the domain as a substring, e.g. evil.com/vimeo.com or
  // vimeo.com.evil.com. This checks the actual hostname instead.
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
  static playableUrl(url, base) {
    let parsed;
    try {
      parsed = new URL(url, base);
    } catch (e) {
      return null;
    }
    return URLUtils.PlayableProtocols.includes(parsed.protocol) ? parsed.href : null;
  }

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

  static getModeFromExtension(ext) {
    return ModesMap.get(ext);
  }

  static getModeFromURL(url) {
    const ext = URLUtils.get_url_extension(url);
    return URLUtils.getModeFromExtension(ext) || PlayerModes.DIRECT;
  }


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

  static headersStringToObj(str) {
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

