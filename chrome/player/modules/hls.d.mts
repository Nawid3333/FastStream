// The type checker's view of hls.mjs, which tools/sync-vendor.mjs copies from
// hls.js: hls.js's own types. Why this file exists: tsconfig.json.
export * from 'hls.js';
export {default as Hls} from 'hls.js';

// hls.js internals that FastStream's patch exports (patches/hls.js@*.patch) for the
// transmuxer: hls.js's types do not describe them.
export declare const TSDemuxer: any;
export type TSDemuxer = any;
export declare const MP4Remuxer: any;
export type MP4Remuxer = any;
export declare const MP4Demuxer: any;
export type MP4Demuxer = any;
export declare const AACDemuxer: any;
export type AACDemuxer = any;
export declare const MP3Demuxer: any;
export type MP3Demuxer = any;
export declare const PassThroughRemuxer: any;
export type PassThroughRemuxer = any;
