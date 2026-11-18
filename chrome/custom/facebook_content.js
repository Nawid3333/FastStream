// @ts-check
(() => {
  /**
   * @param {*} obj - Parsed JSON.
   * @param {string} key
   * @param {Array<*>} [list]
   * @param {Array<string|number>} [stack] - The keys and indexes to obj.
   * @return {Array<*>|undefined}
   */
  function findPropertyRecursive(obj, key, list = [], stack = []) {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }

    if (Array.isArray(obj)) {
      obj.forEach((v, i)=>{
        stack.push(i);
        findPropertyRecursive(v, key, list, stack);
        stack.pop();
      });
    } else {
      if (Object.hasOwn(obj, key)) {
        list.push({value: obj[key], stack: stack.slice(), obj});
      }
      Object.keys(obj).forEach((k)=>{
        stack.push(k);
        findPropertyRecursive(obj[k], key, list, stack);
        stack.pop();
      });
    }

    return list;
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
   * A playback_video's DASH manifest: its playlist, else its delivery fields' manifest.
   * @param {*} video - The playback_video object.
   * @return {?string}
   */
  function manifestOf(video) {
    for (const mpd of [video?.playlist, video?.videoDeliveryLegacyFields?.dash_manifest_xml_string]) {
      if (typeof mpd === 'string' && mpd) {
        return mpd;
      }
    }
    return null;
  }

  // The page's JSON script tags already read, and the manifests already reported.
  const seenScripts = new WeakSet();
  const reported = new Set();

  // Looks for a video's manifest in the JSON script tags not read before.
  function scanScripts() {
    const scriptTags = document.querySelectorAll('script');
    /** @type {Array<*>} */
    let datas = [];
    for (let i = 0; i < scriptTags.length; i++) {
      const script = scriptTags[i];
      if (script.type !== 'application/json' || seenScripts.has(script)) {
        continue;
      }
      seenScripts.add(script);

      try {
        const playInfo = JSON.parse(script.textContent);
        const objects = /** @type {Array<*>} */ (findPropertyRecursive(playInfo, 'playback_video'));
        if (objects.length > 0) {
          objects.forEach((obj)=>{
            datas.push(obj);
          });
        }
      } catch (e) {
        console.error(e);
      }
    }

    datas = datas.filter((data)=>{
      return data.stack.includes('video');
    });

    // The first video with a manifest not reported yet.
    const found = datas.find((data) => {
      const mpd = manifestOf(data.value);
      return mpd && !reported.has(mpd);
    });
    if (!found) {
      return;
    }
    const mpd = /** @type {string} */ (manifestOf(found.value));
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
  }

  scanScripts();

  // Videos change without a page load: new script tags are read for 10 s after each change.
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
