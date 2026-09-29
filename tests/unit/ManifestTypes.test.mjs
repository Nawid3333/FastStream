import {describe, expect, it} from 'vitest';

import {contentTypeOf, modeFromContentType} from '../../chrome/background/ManifestTypes.mjs';
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
