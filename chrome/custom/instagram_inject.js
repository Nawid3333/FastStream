(()=>{
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


  // Posts the first video_dash_manifest with a value in a response, if the response is JSON.
  function readResponse(text) {
    // Without the key there is nothing to find: most responses, which were all parsed.
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

  // Posts the first video_dash_manifest with a value in parsed JSON.
  function readData(data) {
    // video_dash_manifest
    // Nothing for a response that is not an object (a JSON number or string). Most
    // responses have none, so that is no error: it filled the page's console.
    const objs = findPropertyRecursive(data, 'video_dash_manifest');

    if (!objs || objs.length === 0) {
      return;
    }

    // Find non empty value. Every one can be empty (media still being processed).
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

  const rawOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function() {
    if (!this._hooked) {
      this._hooked = true;
      setupHook(this);
    }
    // eslint-disable-next-line prefer-rest-params
    rawOpen.apply(this, arguments);
  };

  function setupHook(xhr) {
    xhr.addEventListener('readystatechange', (e) =>{
      // Check response code
      if (xhr.readyState !== 4) {
        return;
      }

      // responseText exists only for a text response: for 'json', 'blob' or 'document' it
      // throws InvalidStateError, inside the page's own XHR handling. A 'json' one is
      // already parsed; the others hold no JSON to read.
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

  // Instagram loads some of its data with fetch, which the XHR hook never saw (#232). The
  // page gets its own response untouched; a copy of a text one (JSON, script, HTML) is read.
  // A video, an image or other bytes is not copied: it would be held twice and read as text.
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function(...args) {
      const result = rawFetch.apply(this, args);
      result.then((response) => {
        const type = response.headers.get('Content-Type') || '';
        if (!/json|javascript|^text\//i.test(type)) {
          return;
        }
        return response.clone().text().then(readResponse);
      }).catch(() => {});
      return result;
    };
  }
})();
