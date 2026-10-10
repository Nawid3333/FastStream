// btoa takes Latin-1 only: a manifest with any other character (a title, an address)
// threw. This is the manifest's UTF-8, in base64.
function base64Utf8(text) {
  return new TextEncoder().encode(text).toBase64();
}

// The manifests already reported: Instagram fetches the same video's data more than once
// (prefetch, then play), and each answer reported it again - the background keeps every
// report as another source of the tab (review). As bilibili_content.js and
// facebook_content.js do.
const reported = new Set();

// Listen for messages
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
    // What instagram_inject.js posts. Any script in the page can post this too, and a
    // type other than a DASH manifest was passed on as a source of no type.
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
    });

    console.log('Detected source', event.data);
  }
});

const sc = document.createElement('script');
sc.src = chrome.runtime.getURL('custom/instagram_inject.js');
const it = document.head || document.documentElement;

it.appendChild(sc);
sc.remove();
