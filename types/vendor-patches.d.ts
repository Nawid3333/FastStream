// What FastStream's patches add to the vendored libraries (patches/*.patch), which the
// libraries' own types do not describe, and where a library's types are narrower than its
// code. chrome/player/modules/*.d.mts re-export each library's own types; this adds to them.
import type {
  DashHandler, FragmentRequest, MediaInfo, Representation, Segment, SegmentsController, Stream, StreamController,
  StreamProcessor,
} from 'dashjs';
import type {Box, DataStream, Sample} from 'mp4box';

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
    /** Whether it has an init segment: in dash.js's Representation, not in its types. */
    hasInitialization(): boolean;
    /** Whether it lists its segments (a template, a timeline, a list): likewise. */
    hasSegments(): boolean;
  }

  interface FragmentRequest {
    /**
     * In dash.js's FragmentRequest, not in its types: the byte range ("start-end"), null for
     * the whole file, and the representation it is for.
     */
    range: string | null;
    representation: Representation | null;
    /** FastStream's own: DashPlayer.extractFragments notes the store's level of each request. */
    level?: string;
  }

  interface SegmentsController {
    /** Every segment of a representation (null when it has no way to list them): its types lack it. */
    getAllSegments(representation: Representation): Segment[] | null;
  }

  interface DashHandler {
    /** The request for a segment (null for none): DashHandler returns it, its types lack it. */
    _getRequestForSegment(mediaInfo: MediaInfo, segment: Segment): FragmentRequest | null;
  }

  interface RepresentationController {
    /** What it plays, or null before its first; dash.js's types also give it as `object`. */
    getCurrentRepresentation(): Representation | null;
  }

  interface StreamProcessor {
    /** The representation it plays: in dash.js's StreamProcessor, not in its types. */
    getRepresentation(): Representation | null;
    /** Its segments' controller and its DashHandler: likewise. */
    getSegmentsController(): SegmentsController;
    getDashHandler(): DashHandler;
  }
}

declare module 'mp4box' {
  interface SampleEntry {
    /**
     * An mp4a entry's esds box: mp4box puts each child box on its parent by type, and a box
     * read from a file keeps its bytes as data.
     */
    esds?: Box & {data: Uint8Array};

    /**
     * mp4box's types ask for a MultiBufferStream, its code (writeHeader, writeFooter and each
     * entry's write) uses only DataStream's writers: MP4Merger writes an entry into one.
     */
    write(stream: DataStream): void;
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

declare module 'hls.js' {
  interface Fragment {
    /**
     * FastStream's own: HLSFragmentStore notes on each fragment it stores the store's id of
     * its level and its track (0 the levels, 1 the audio tracks).
     */
    levelIdentifier?: string;
    trackID?: number;
    /**
     * FastStream's own: HLSFragmentRequester.takeOverDecryption keeps here the key of a
     * segment whose decryption it took over from hls.js, and the keys hls.js had for it.
     */
    fs_oldcryptdata?: LevelKey;
    fs_oldlevelKeys?: Fragment['levelkeys'];
  }

  interface LevelDetails {
    /** FastStream's own: HLSPlayer.trackUpdated notes the track (0 a level, 1 an audio track). */
    trackID?: number;
  }
}
