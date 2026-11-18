// @ts-check
import {AudioLevel, VideoLevel} from '../Levels.mjs';
import {cachedAnswer} from '../DecodingCapabilities.mjs';

/**
 * @typedef {{probe: ?(import('../DecodingCapabilities.mjs').VideoProbe|import('../DecodingCapabilities.mjs').AudioProbe), frameRate?: number,
 *   videoRange?: import('../DecodingCapabilities.mjs').VideoRange}} RepresentationDetails
 */

export class DashTrackUtils {
  /**
   * @param {import('../../modules/dash.mjs').Representation} rep
   * @return {string} <type>-<representation id>.
   */
  static getLevelFromRepresentation(rep) {
    // A representation dash.js plays is one of an adaptation.
    const type = /** @type {NonNullable<typeof rep.adaptation>} */ (rep.adaptation).type;
    const id = rep.id;
    return `${type}-${id}`;
  }

  /**
   * Null while dash.js has none: no stream yet, or a stream processor before its first representation.
   * @param {?import('../../modules/dash.mjs').MediaPlayerClass} dash
   * @param {string} type
   * @return {?string}
   */
  static getCurrentLevel(dash, type) {
    const processor = dash?.getStreamController()?.getActiveStream()?.getStreamProcessors()?.find((o) => o.getType() === type);
    const rep = processor?.getRepresentationController().getCurrentRepresentation();
    return rep ? this.getLevelFromRepresentation(rep) : null;
  }

  /**
   * @param {string} levelId - <type>-<representation id>.
   * @return {string|{type: string, id: string}} Its parts, or the id itself without a type.
   */
  static deconstructLevel(levelId) {
    const parts = levelId.split('-');
    if (parts.length < 2) {
      return levelId;
    }
    const type = parts[0];
    const id = parts.slice(1).join('-');
    return {type, id};
  }

  /**
   * @param {Array<import('../../modules/dash.mjs').MediaInfo>} tracks
   * @param {?Map<string, RepresentationDetails>} [details]
   * @return {Map<string, VideoLevel>}
   */
  static getVideoLevelList(tracks, details = null) {
    const map = new Map();

    tracks.forEach((track) => {
      track.bitrateList.forEach((data) => {
        const levelId = 'video-' + data.id;
        const existing = map.get(levelId);
        if (existing) {
          console.warn('Duplicate level id found in getVideoLevelList:', levelId, track, existing.track);
          return;
        }

        map.set(levelId, new VideoLevel(/** @type {{audioCodec: any, bitrate: any, decoding: any, frameRate: any, height: any, id: any, label: any, language: any, mimeType: any, track: any, videoCodec: any, videoRange: any, width: any}} */ ({
          id: levelId,
          width: data.width,
          height: data.height,
          bitrate: data.bandwidth,
          mimeType: track.mimeType,
          language: track.lang,
          videoCodec: this.mimeCodecToCodec(/** @type {string} */ (track.codec)),
          track: track,
          frameRate: details?.get(levelId)?.frameRate,
          videoRange: details?.get(levelId)?.videoRange,
          decoding: cachedAnswer(details?.get(levelId)?.probe ?? null),
        })));
      });
    });
    return map;
  }

  /**
   * @param {string} mimeCodec
   * @return {?string} The codecs part, or null without one.
   */
  static mimeCodecToCodec(mimeCodec) {
    // mimeCodec format: video/mp4; codecs="avc1.42E01E, mp4a.40.2"
    const parts = mimeCodec.split(';');
    if (parts.length < 2) {
      return null;
    }
    const codecPart = parts[1].trim();
    if (!codecPart.startsWith('codecs=')) {
      return null;
    }
    let codecStr = codecPart.substring(7).trim();
    if (codecStr.startsWith('"') && codecStr.endsWith('"')) {
      codecStr = codecStr.substring(1, codecStr.length - 1);
    }
    return codecStr;
  }

  /**
   * @param {Array<import('../../modules/dash.mjs').MediaInfo>} tracks
   * @param {?Map<string, RepresentationDetails>} [details]
   * @return {Map<string, AudioLevel>}
   */
  static getAudioLevelList(tracks, details = null) {
    const map = new Map();

    tracks.forEach((track) => {
      track.bitrateList.forEach((data) => {
        const levelId = 'audio-' + data.id;
        const existing = map.get(levelId);
        if (existing) {
          console.warn('Duplicate level id found in getAudioLevelList:', levelId, track, existing.track);
          return;
        }

        map.set(levelId, new AudioLevel({
          id: levelId,
          bitrate: data.bandwidth,
          mimeType: track.mimeType,
          language: track.lang,
          audioCodec: this.mimeCodecToCodec(/** @type {string} */ (track.codec)),
          track: track,
          decoding: cachedAnswer(details?.get(levelId)?.probe ?? null),
        }));
      });
    });

    return map;
  }
}

