import {describe, expect, it} from 'vitest';

import {contentTypeOf, modeFromContentType, modeFromMediaType} from '../../chrome/background/ManifestTypes.mjs';
import {PlayerModes} from '../../chrome/player/enums/PlayerModes.mjs';

const typed = (value) => [{name: 'Server', value: 'nginx'}, {name: 'Content-Type', value}];

describe('ManifestTypes', () => {
  it('reads the media type, whatever the header\'s case, without its parameters', () => {
    expect(contentTypeOf([{name: 'content-type', value: 'Application/Vnd.Apple.MpegURL; charset=UTF-8'}])).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeOf([{name: 'CONTENT-TYPE', value: ' application/dash+xml '}])).toBe('application/dash+xml');
    expect(contentTypeOf([{name: 'Server', value: 'nginx'}])).toBe('');
    expect(contentTypeOf([{name: 'Content-Type'}])).toBe('');
    expect(contentTypeOf(undefined)).toBe('');
  });

  it('knows an HLS playlist by each type servers send for one', () => {
    for (const type of ['application/vnd.apple.mpegurl', 'application/x-mpegURL', 'audio/mpegurl', 'audio/x-mpegurl']) {
      expect(modeFromContentType(typed(type)), type).toBe(PlayerModes.ACCELERATED_HLS);
    }
  });

  it('knows a DASH manifest', () => {
    expect(modeFromContentType(typed('application/dash+xml; charset=utf-8'))).toBe(PlayerModes.ACCELERATED_DASH);
  });

  it('takes no segment, file or page for a manifest', () => {
    for (const type of ['video/mp4', 'video/mp2t', 'video/iso.segment', 'audio/mp4', 'video/webm', 'image/jpeg', 'text/html',
      'application/octet-stream', 'text/plain', 'application/json', '']) {
      expect(modeFromContentType(typed(type)), type).toBeUndefined();
    }
    expect(modeFromContentType(undefined)).toBeUndefined();
  });
});

// A file a <video> or <audio> element loaded, with no type in its URL. All of them were
// taken for MP4 videos: a notification sound went to mpv as an allowlisted page's first
// stream, and a WebM went to the player's MP4 mode, which reads MP4 only.
describe('modeFromMediaType', () => {
  it('takes no audio file for a video', () => {
    for (const type of ['audio/mpeg', 'audio/ogg', 'audio/mp4', 'Audio/WAV; codecs=1']) {
      expect(modeFromMediaType(typed(type)), type).toBeNull();
    }
  });

  it('plays a WebM or Ogg video as it is', () => {
    expect(modeFromMediaType(typed('video/webm'))).toBe(PlayerModes.DIRECT);
    expect(modeFromMediaType(typed('video/ogg'))).toBe(PlayerModes.DIRECT);
  });

  it('takes anything else for an MP4, as before', () => {
    for (const type of ['video/mp4', 'application/octet-stream', 'binary/octet-stream', '']) {
      expect(modeFromMediaType(typed(type)), type).toBe(PlayerModes.ACCELERATED_MP4);
    }
    expect(modeFromMediaType(undefined)).toBe(PlayerModes.ACCELERATED_MP4);
  });
});
