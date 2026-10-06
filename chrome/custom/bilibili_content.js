class Bilibili2Dash {
  constructor() {
    this.document = document.implementation.createDocument('', '', null);
  }

  playInfoToDash(playInfo) {
    const dashData = playInfo.data.dash;
    const MPD = this.loadDashData(dashData);
    const xml = new XMLSerializer().serializeToString(MPD);
    return '<?xml version="1.0" encoding="utf-8"?>' + xml;
  }

  loadDashTracks(tracks) {
    const AdaptationSet = this.document.createElement('AdaptationSet');
    tracks.forEach((track)=>{
      AdaptationSet.appendChild(this.loadDashTrack(track));
    });
    return AdaptationSet;
  }

  loadDashTrack(track) {
    const id = track.id;
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
    // const codecid = track.codecid;
    const Representation = this.document.createElement('Representation');
    Representation.setAttribute('id', id);
    Representation.setAttribute('codecs', codecs);
    Representation.setAttribute('bandwidth', bandwidth);
    Representation.setAttribute('width', width);
    Representation.setAttribute('height', height);
    if (frameRate) Representation.setAttribute('frameRate', frameRate);
    if (sar) Representation.setAttribute('sar', sar);
    Representation.setAttribute('startWithSAP', startWithSap);
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

  loadDashData(dashData) {
    const duration = dashData.duration;
    const minBufferTime = dashData.minBufferTime;
    const videoAdaptationSet = this.loadDashTracks(dashData.video);
    const audioAdaptationSet = this.loadDashTracks(dashData.audio);
    // const dolby = dashData.dolby;
    // const flac = dashData.flac;

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

    Period.appendChild(videoAdaptationSet);
    Period.appendChild(audioAdaptationSet);
    return MPD;
  }
}

// btoa takes Latin-1 only: a manifest with any other character (a title, an address)
// threw. This is the manifest's UTF-8, in base64.
function base64Utf8(text) {
  return new TextEncoder().encode(text).toBase64();
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
      const playInfo = script.textContent.match(/window\.__playinfo__\s*=\s*(\{.*\})/);
      if (playInfo) {
        // Play info of another shape (FLV, data.durl, instead of data.dash), or more code
        // after it on the line, threw here, uncaught, and nothing was detected.
        let mpd;
        try {
          const playInfoObj = JSON.parse(playInfo[1]);
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
        });

        break;
      }
    }
  }
}

scanScripts();

// Bilibili moves to another episode without loading a page, and this script runs once per
// page load, so only the first video was found (#232). For ten seconds after the address
// changes, the script tags that were not there before are read each second. The ones read
// before (the first video's, still in the page) are not read again: that video would come
// back under the new page's address.
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
