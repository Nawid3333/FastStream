// @ts-check
import {DefaultPlayerEvents} from '../../enums/DefaultPlayerEvents.mjs';
import {PlayerModes} from '../../enums/PlayerModes.mjs';
import {RequestUtils} from '../../utils/RequestUtils.mjs';
import HLSPlayer from '../hls/HLSPlayer.mjs';

export default class VMPlayer extends HLSPlayer {
  /**
   * @param {import('../../FastStreamClient.mjs').FastStreamClient} client
   * @param {*} options
   */
  constructor(client, options) {
    super(client, options);
  }

  /**
   * Only a video's player page or config on player.vimeo.com, rebuilt from its number; anything else is refused.
   * @param {string} url
   * @return {string|null} Null for anything else.
   */
  static vimeoRequestUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (e) {
      return null;
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.hostname !== 'player.vimeo.com') {
      return null;
    }
    const path = /^\/video\/(\d+)(\/config)?\/?$/.exec(parsed.pathname);
    if (!path) {
      return null;
    }
    const query = parsed.search ? '?' + parsed.search.slice(1) : '';
    return 'https://player.vimeo.com/video/' + encodeURIComponent(path[1]) + (path[2] ? '/config' : '') + query;
  }

  /**
   * @param {import('../../VideoSource.mjs').VideoSource} source
   * @override
   */
  async setSource(source) {
    try {
      const requestUrl = VMPlayer.vimeoRequestUrl(source.url);
      if (!requestUrl) {
        throw new Error('Not a Vimeo player address: ' + source.url);
      }
      // By the path vimeoRequestUrl checked: a config address may have no query.
      const isEmbed = !new URL(requestUrl).pathname.endsWith('/config');
      const hc = [];
      if (Array.isArray(source.headers)) {
        source.headers.forEach(/** @type {(h: {name: string, value: string}) => void} */ ((h) => {
          hc.push({
            operation: 'set',
            header: h.name,
            value: h.value,
          });
        }));
      } else {
        for (const key in source.headers) {
          if (Object.hasOwn(source.headers, key)) {
            hc.push({
              operation: 'set',
              header: key,
              value: source.headers[key],
            });
          }
        }
      }

      const xhr = await RequestUtils.request({
        url: requestUrl,
        header_commands: hc,
        responseType: isEmbed ? 'text' : 'json',
      });

      const config = xhr.response;
      const hls = !isEmbed ? config?.request?.files?.hls : this.extractVimeoHlsUrlFromIframePlayer(config);
      if (!hls || !hls.cdns) {
        throw new Error('Vimeo HLS data not found');
      }
      const defaultCdn =
          hls.default_cdn && hls.cdns[hls.default_cdn] ?
              hls.default_cdn :
              Object.keys(hls.cdns)[0];

      let hlsUrl = hls.cdns[defaultCdn].url;

      if (!hlsUrl) {
        throw new Error('Vimeo HLS URL missing');
      }

      hlsUrl = hlsUrl.replace(/\\u0026/g, '&');

      this.source = source.copy();
      this.source.url = hlsUrl;
      this.source.mode = PlayerModes.ACCELERATED_HLS;
    } catch (e) {
      console.error(e);
      this.emit(DefaultPlayerEvents.ERROR, e);
      return;
    }

    await super.setSource(this.source);
  }

  /** @override */
  destroy() {
    if (this.source) {
      URL.revokeObjectURL(this.source.url);
    }
    super.destroy();
  }

  /** @override */
  getSource() {
    return this.source;
  }

  /** @param {string} html */
  extractVimeoHlsUrlFromIframePlayer(html) {
    const config = this.extractJsonConfig(html, 'window.playerConfig =');

    if (!config) {
      throw new Error('Vimeo iframe: playerConfig not found');
    }

    return config?.request?.files?.hls;
  }

  /**
   * @param {string} html
   * @param {string} prefix
   */
  extractJsonConfig(html, prefix) {
    const startIndex = html.indexOf(prefix);
    if (startIndex === -1) return null;

    let i = startIndex + prefix.length;

    while (i < html.length && html[i] !== '{') {
      i++;
    }

    if (i >= html.length) return null;

    const jsonStart = i;
    let braceCount = 0;
    let foundStart = false;
    // Braces inside a string ("title": "a {b}") are text.
    let inString = false;

    for (; i < html.length; i++) {
      const char = html[i];
      if (inString) {
        if (char === '\\') {
          i++;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        braceCount++;
        foundStart = true;
      } else if (char === '}') {
        braceCount--;
      }

      if (foundStart && braceCount === 0) {
        const jsonString = html.substring(jsonStart, i + 1);
        try {
          return JSON.parse(jsonString);
        } catch (e) {
          return null;
        }
      }
    }

    return null;
  }
}
