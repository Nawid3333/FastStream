import {describe, expect, it} from 'vitest';

import {lengthFromAnswer} from '../../chrome/player/players/mp4/RangeAnswers.mjs';

// What MP4Player learns from the answer to its first 1 MB range. A server that ignores Range
// answers 200 with the whole file, and each later range downloaded the file from byte 0 again
// (a 2 GB file: ~2 TB): unless the whole file came in that answer, Firefox's own player plays it.

const FIRST = {start: 0, end: 1000000};

describe('lengthFromAnswer', () => {
  it('reads the length from Content-Range, as before', () => {
    expect(lengthFromAnswer({status: 206, headers: {'content-range': 'bytes 0-999999/17245699'}, received: 1000000}, FIRST))
        .toEqual({length: 17245699, playDirectly: false});
  });

  it('takes a whole file that fits in the range as the file', () => {
    // sample.mp4, 991017 bytes, answered 200 to bytes=0-999999.
    expect(lengthFromAnswer({status: 200, headers: {'content-length': '991017'}, received: 991017}, FIRST))
        .toEqual({length: 991017, playDirectly: false});
    // No Content-Length (a chunked answer): fewer bytes than asked for is the whole file too.
    expect(lengthFromAnswer({status: 200, headers: {}, received: 500000}, FIRST))
        .toEqual({length: 500000, playDirectly: false});
  });

  it('hands a bigger file from a server that ignores Range to Firefox\'s own player', () => {
    expect(lengthFromAnswer({status: 200, headers: {'content-length': '17245699'}, received: 1000000}, FIRST))
        .toEqual({length: 0, playDirectly: true});
    // As many bytes as asked for, and no length: more may follow, so it may be bigger.
    expect(lengthFromAnswer({status: 200, headers: {}, received: 1000000}, FIRST))
        .toEqual({length: 0, playDirectly: true});
  });

  it('reads on when a 200\'s length is exactly the range: the whole file, or only the range', () => {
    // A file of exactly 1 MB, or a server that answers a range with 200 and the range's length.
    // The next range tells which: empty (or 416) ends the file there.
    expect(lengthFromAnswer({status: 200, headers: {'content-length': '1000000'}, received: 1000000}, FIRST))
        .toEqual({length: 0, playDirectly: false});
  });

  it('knows no length from a 206 without Content-Range, and leaves the decision to the samples', () => {
    expect(lengthFromAnswer({status: 206, headers: {'content-length': '1000000'}, received: 1000000}, FIRST))
        .toEqual({length: 0, playDirectly: false});
    expect(lengthFromAnswer({status: 206, headers: null, received: 1000000}, FIRST))
        .toEqual({length: 0, playDirectly: false});
  });
});
