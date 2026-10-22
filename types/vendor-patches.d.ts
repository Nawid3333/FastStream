// What FastStream's patches add to the vendored libraries (patches/*.patch), which the
// libraries' own types do not describe, and where a library's types are narrower than its
// code. chrome/player/modules/*.d.mts re-export each library's own types; this adds to them.
import type {MediaInfo, Representation, Stream, StreamController, StreamProcessor} from 'dashjs';
import type {Box, Sample} from 'mp4box';

declare module 'dashjs' {
  interface MediaPlayerClass {
    /** patches/dashjs@*.patch: the player's StreamController. */
    getStreamController(): DashStreamController;
    /**
     * patches/dashjs@*.patch: narrows the representations the ABR may pick from, given the
     * bitrate it measured (kbit/s) and the track.
     */
    setCustomBitrateSelectionFunction(
      selection: (representations: Representation[], bitrateInKbit: number, mediaInfo: MediaInfo) => Representation[],
    ): void;
    /**
     * dash.js waits for each filter's answer (_applyCustomFiltersRepresentation resolves a
     * promise with it), so a filter may answer asynchronously; its types say boolean only.
     */
    registerCustomCapabilitiesFilter(filter: (representation: Representation) => boolean | Promise<boolean>): void;
  }

  /**
   * dash.js's StreamController, with what its methods really return: its types give the
   * active stream as `object` and the streams and processors as `any[]`.
   */
  type DashStreamController = Omit<StreamController, 'getActiveStream' | 'getStreams'> & {
    getActiveStream(): DashStream | null;
    getStreams(): DashStream[];
  };

  /** A Stream as dash.js's code has it: its processors are StreamProcessors. */
  type DashStream = Omit<Stream, 'getStreamProcessors'> & {
    getStreamProcessors(): StreamProcessor[];
  };

  interface MediaInfo {
    /** The track's representations, which the StreamProcessor sets; its types lack them. */
    representations: Representation[];
  }

  interface Representation {
    /** FastStream's own: DashPlayer.extractAllFragments notes the processor that plays it. */
    processor?: StreamProcessor;
  }

  interface RepresentationController {
    /** What it plays, or null before its first; dash.js's types also give it as `object`. */
    getCurrentRepresentation(): Representation | null;
  }

  interface StreamProcessor {
    /** The representation it plays: in dash.js's StreamProcessor, not in its types. */
    getRepresentation(): Representation | null;
  }
}

declare module 'mp4box' {
  interface SampleEntry {
    /**
     * An mp4a entry's esds box: mp4box puts each child box on its parent by type, and a box
     * read from a file keeps its bytes as data.
     */
    esds?: Box & {data: Uint8Array};
  }

  interface ISOFile {
    /** mp4box's code takes a missing useRap as false, as its own callers do. */
    seek(time: number, useRap?: boolean): {offset: number, time: number};

    /**
     * patches/mp4box@*.patch: a fragment's samples per track, read from its moof against
     * the movie's trex defaults.
     */
    getSampleList(moof: any, trexList: Array<{track_id: number}>): Array<{
      track_id: number,
      samples: Sample[],
      samples_size: number,
      samples_duration: number,
    }>;
  }
}
