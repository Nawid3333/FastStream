// @ts-check
(() => {
  class Bilibili2Dash {
    constructor() {
      this.document = document.implementation.createDocument('', '', null);
    }

    /**
     * @param {*} playInfo - The page's play info (window.__playinfo__).
     * @return {string}
     */
    playInfoToDash(playInfo) {
      const dashData = playInfo.data.dash;
      const MPD = this.loadDashData(dashData);
      const xml = new XMLSerializer().serializeToString(MPD);
      return '<?xml version="1.0" encoding="utf-8"?>' + xml;
    }

    /**
     * One AdaptationSet per codec: bilibili lists a quality in several codecs under one id.
     * @param {Array<*>} tracks
     * @param {Set<string>} ids - The ids given so far, in the whole manifest.
     * @return {Array<*>} The AdaptationSets.
     */
    loadDashTracks(tracks, ids) {
      /** @type {Map<string, *>} */
      const sets = new Map();
      tracks.forEach((track)=>{
        const family = String(track.codecs || '').split('.')[0];
        let set = sets.get(family);
        if (!set) {
          set = this.document.createElement('AdaptationSet');
          sets.set(family, set);
        }
        let id = family ? `${track.id}-${family}` : String(track.id);
        for (let n = 2; ids.has(id); n++) {
          id = `${track.id}-${family}-${n}`;
        }
        ids.add(id);
        set.appendChild(this.loadDashTrack(track, id));
      });
      return Array.from(sets.values());
    }

    /**
     * @param {*} track
     * @param {string} id - Its Representation's id.
     */
    loadDashTrack(track, id) {
      const baseUrl = track.baseUrl;
      const bandwidth = track.bandwidth;
      const mimeType = track.mimeType;
      const codecs = track.codecs;
      const width = track.width;
      const height = track.height;
      const frameRate = track.frameRate;
      const sar = track.sar;
      const startWithSap = track.startWithSap;
      const SegmentBase = track.SegmentBase;
      const Representation = this.document.createElement('Representation');
      Representation.setAttribute('id', id);
      Representation.setAttribute('codecs', codecs);
      Representation.setAttribute('bandwidth', bandwidth);
      if (width) Representation.setAttribute('width', width);
      if (height) Representation.setAttribute('height', height);
      if (frameRate) Representation.setAttribute('frameRate', frameRate);
      if (sar) Representation.setAttribute('sar', sar);
      if (startWithSap !== undefined) Representation.setAttribute('startWithSAP', startWithSap);
      Representation.setAttribute('mimeType', mimeType);

      const BaseURL = this.document.createElement('BaseURL');
      BaseURL.textContent = baseUrl;
      Representation.appendChild(BaseURL);

      const SegmentBaseElement = this.document.createElement('SegmentBase');
      SegmentBaseElement.setAttribute('indexRange', SegmentBase.indexRange);
      Representation.appendChild(SegmentBaseElement);

      const Initialization = this.document.createElement('Initialization');
      Initialization.setAttribute('range', SegmentBase.Initialization);
      SegmentBaseElement.appendChild(Initialization);

      return Representation;
    }

    /** @param {*} dashData */
    loadDashData(dashData) {
      const duration = dashData.duration;
      const minBufferTime = dashData.minBufferTime;
      /** @type {Set<string>} */
      const ids = new Set();
      const videoAdaptationSets = this.loadDashTracks(dashData.video || [], ids);
      // A video without sound has no audio list (null).
      const audioAdaptationSets = this.loadDashTracks(dashData.audio || [], ids);

      const MPD = this.document.createElement('MPD');
      MPD.setAttribute('xmlns', 'urn:mpeg:dash:schema:mpd:2011');
      MPD.setAttribute('xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance');
      MPD.setAttribute('xsi:schemaLocation', 'urn:mpeg:DASH:schema:MPD:2011 DASH-MPD.xsd');
      MPD.setAttribute('profiles', 'urn:mpeg:dash:profile:isoff-main:2011');
      MPD.setAttribute('minBufferTime', `PT${minBufferTime}S`);
      MPD.setAttribute('type', 'static');
      MPD.setAttribute('mediaPresentationDuration', `PT${duration}S`);

      const Period = this.document.createElement('Period');
      MPD.appendChild(Period);

      for (const set of [...videoAdaptationSets, ...audioAdaptationSets]) Period.appendChild(set);
      return MPD;
    }
  }

  // Not btoa(text): btoa throws on anything outside Latin-1.
  /**
   * @param {string} text
   * @return {string}
   */
  function base64Utf8(text) {
    return new TextEncoder().encode(text).toBase64();
  }

  /**
   * The JSON object that starts at `start` (a "{"), up to its own closing brace.
   * @param {string} text
   * @param {number} start
   * @return {?string}
   */
  function jsonObjectAt(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (inString) {
        if (char === '\\') i++;
        else if (char === '"') inString = false;
      } else if (char === '"') {
        inString = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}' && --depth === 0) {
        return text.slice(start, i + 1);
      }
    }
    return null;
  }

  // The page's script tags already read, and the manifests already reported.
  const seenScripts = new WeakSet();
  const reported = new Set();

  // Looks for "window.__playinfo__" in the script tags not read before.
  function scanScripts() {
    const scriptTags = document.querySelectorAll('script');
    for (let i = 0; i < scriptTags.length; i++) {
      const script = scriptTags[i];
      if (seenScripts.has(script)) {
        continue;
      }
      seenScripts.add(script);
      if (script.textContent.includes('window.__playinfo__')) {
        const assignment = /window\.__playinfo__\s*=\s*\{/.exec(script.textContent);
        const playInfo = assignment && jsonObjectAt(script.textContent, assignment.index + assignment[0].length - 1);
        if (playInfo) {
          // Play info of another shape (FLV: data.durl, no data.dash) throws here.
          let mpd;
          try {
            const playInfoObj = JSON.parse(playInfo);
            const converter = new Bilibili2Dash();
            mpd = converter.playInfoToDash(playInfoObj);
          } catch (e) {
            console.error('No DASH play info', e);
            continue;
          }
          // Skipped, not the end of the scan: a later script can hold the next video's.
          if (reported.has(mpd)) {
            continue;
          }
          reported.add(mpd);
          const url = `data:application/dash+xml;base64,${base64Utf8(mpd)}`;
          chrome.runtime.sendMessage({
            type: 'DETECTED_SOURCE',
            url,
            ext: 'mpd',
            headers: {
              'Referer': location.href,
              'Origin': location.origin,
            },
          }, () => {
            // Read, so a reloaded extension leaves no unhandled error in the page.
            void chrome.runtime.lastError;
          });

          break;
        }
      }
    }
  }

  scanScripts();

  // Episodes change without a page load: new script tags are read for 10 s after each change.
  let lastHref = location.href;
  let rescans = 0;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      rescans = 10;
    }
    if (rescans > 0) {
      rescans--;
      scanScripts();
    }
  }, 1000);
})();
