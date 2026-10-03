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

// btoa takes Latin-1 only: a manifest with any other character (a title, an address)
// threw. This is the manifest's UTF-8, in base64.
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(binary);
}

// look for script tag with "window.__playinfo__"
const scriptTags = document.querySelectorAll('script');
let datas = [];
for (let i = 0; i < scriptTags.length; i++) {
  const script = scriptTags[i];
  if (script.type !== 'application/json') {
    continue;
  }

  try {
    const playInfo = JSON.parse(script.textContent);
    const objects = findPropertyRecursive(playInfo, 'playback_video');
    if (objects.length > 0) {
      objects.forEach((obj)=>{
        datas.push(obj);
      });
    }
  } catch (e) {
    console.error(e);
  }
}

// Look for video in path
datas = datas.filter((data)=>{
  return data.stack.includes('video');
});

// The first one with its manifest: one without (playlist) was sent as a source whose
// manifest was the word "undefined".
const found = datas.find((data) => typeof data.value?.playlist === 'string' && data.value.playlist);
if (!found) {
  console.error('No video found');
} else {
  const mpd = found.value.playlist;
  const url = `data:application/dash+xml;base64,${base64Utf8(mpd)}`;
  chrome.runtime.sendMessage({
    type: 'DETECTED_SOURCE',
    url,
    ext: 'mpd',
    headers: {
      'Referer': location.href,
      'Origin': location.origin,
    },
  });

  console.log('Video found', found.value);
}

