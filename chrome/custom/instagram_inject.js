// @ts-check
(()=>{
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


  // Posts the first non-empty video_dash_manifest of a JSON response.
  /** @param {*} text */
  function readResponse(text) {
    if (typeof text !== 'string' || !text.includes('video_dash_manifest')) {
      return;
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }
    readData(data);
  }

  /** @param {*} data */
  function readData(data) {
    // Most responses have none: no error, it would fill the page's console.
    const objs = findPropertyRecursive(data, 'video_dash_manifest');

    if (!objs || objs.length === 0) {
      return;
    }

    // A value is empty while the media is still being processed.
    const value = objs.find((o)=>!!o.value)?.value;

    if (!value) {
      console.error('No value found', data);
      return;
    }

    window.postMessage({
      type: 'fs_source_detected',
      value: value.toString(),
      ext: 'mpd',
    }, '*');
  }

  // A reel opened by its address has its manifest in the page's JSON script tag.
  function readPageData() {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      readResponse(script.textContent);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', readPageData, {once: true});
  } else {
    readPageData();
  }

  const rawOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function() {
    if (!/** @type {XMLHttpRequest & {_hooked?: boolean}} */ (this)._hooked) {
      /** @type {XMLHttpRequest & {_hooked?: boolean}} */ (this)._hooked = true;
      setupHook(this);
    }
    // eslint-disable-next-line prefer-rest-params
    rawOpen.apply(this, /** @type {*} */ (arguments));
  };

  /** @param {XMLHttpRequest} xhr */
  function setupHook(xhr) {
    xhr.addEventListener('readystatechange', (/** @type {Event} */ e) =>{
      if (xhr.readyState !== 4) {
        return;
      }

      // responseText throws for a 'json', 'blob' or 'document' response.
      if (xhr.responseType === 'json') {
        readData(xhr.response);
        return;
      }
      if (xhr.responseType !== '' && xhr.responseType !== 'text') {
        return;
      }

      readResponse(xhr.responseText);
    });
  }

  // Instagram loads some data with fetch too; only a text response is copied.
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function(...args) {
      const result = rawFetch.apply(this, args);
      result.then((response) => {
        const type = response.headers.get('Content-Type') || '';
        if (!/json|javascript|^text\//i.test(type) || /event-stream|ndjson|json-seq|stream\+json/i.test(type)) {
          return;
        }
        return response.clone().text().then(readResponse);
      }).catch(() => {});
      return result;
    };
  }
})();
