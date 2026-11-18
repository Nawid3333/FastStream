// @ts-check
(() => {
  // Not btoa(text): btoa throws on anything outside Latin-1.
  /**
   * @param {string} text
   * @return {string}
   */
  function base64Utf8(text) {
    return new TextEncoder().encode(text).toBase64();
  }

  // Instagram fetches a video's data more than once; each manifest is reported once.
  const reported = new Set();

  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) {
      return;
    }

    if (typeof event.data !== 'object') {
      return;
    }


    if (event.data?.type === 'fs_source_detected') {
      const value = (event.data?.value || '').toString();
      const ext = (event.data?.ext || '').toString();
      // Any script in the page can post this message.
      if (!value || ext !== 'mpd') {
        return;
      }
      const mpd = value;
      if (reported.has(mpd)) {
        return;
      }
      reported.add(mpd);
      const url = `data:application/dash+xml;base64,${base64Utf8(mpd)}`;
      chrome.runtime.sendMessage({
        type: 'DETECTED_SOURCE',
        url,
        ext: ext,
        headers: {
          'Referer': location.href,
          'Origin': location.origin,
        },
      }, () => {
        // Read, so a reloaded extension leaves no unhandled error in the page.
        void chrome.runtime.lastError;
      });

      console.log('Detected source', event.data);
    }
  });

  const sc = document.createElement('script');
  sc.src = chrome.runtime.getURL('custom/instagram_inject.js');
  const it = document.head || document.documentElement;

  it.appendChild(sc);
  sc.remove();
})();
