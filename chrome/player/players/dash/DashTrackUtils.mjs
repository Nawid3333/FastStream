import {AudioLevel, VideoLevel} from '../Levels.mjs';
import {cachedAnswer} from '../DecodingCapabilities.mjs';

export class DashTrackUtils {
  static getLevelFromRepresentation(rep) {
    const type = rep.adaptation.type;
    const id = rep.id;
    return `${type}-${id}`;
  }

  /**
   * The level dash.js plays for a type, or null while it has none: no stream yet, or a
   * stream processor before its first representation (at the start, or a period change).
   * The players' "no level" was -1 for the one, which FastStreamClient took for a level
   * and wrote over the level an archive had asked for; the other threw.
   * @param {Object} dash - dash.js's MediaPlayer.
   * @param {string} type - 'video' or 'audio'.
   * @return {?string}
   */
  static getCurrentLevel(dash, type) {
    const processor = dash?.getStreamController()?.getActiveStream()?.getStreamProcessors()?.find((o) => o.getType() === type);
    const rep = processor?.getRepresentationController().getCurrentRepresentation();
    return rep ? this.getLevelFromRepresentation(rep) : null;
  }

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
   * @param {Array<Object>} tracks - dash.js MediaInfo objects.
   * @param {?Map<string, Object>} [details] - DashPlayer.representationDetails.
   * @return {Map<string, VideoLevel>}
   */
  static getVideoLevelList(tracks, details = null) {
    // make into map
    const map = new Map();

    tracks.forEach((track) => {
      track.bitrateList.forEach((data) => {
        const levelId = 'video-' + data.id;
        const existing = map.get(levelId);
        if (existing) {
          console.warn('Duplicate level id found in getVideoLevelList:', levelId, track, existing.track);
          return;
        }

        map.set(levelId, new VideoLevel({
          id: levelId,
          width: data.width,
          height: data.height,
          bitrate: data.bandwidth,
          mimeType: track.mimeType,
          language: track.lang,
          videoCodec: this.mimeCodecToCodec(track.codec),
          track: track,
          frameRate: details?.get(levelId)?.frameRate,
          videoRange: details?.get(levelId)?.videoRange,
          decoding: cachedAnswer(details?.get(levelId)?.probe ?? null),
        }));
      });
    });
    return map;
  }

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
   * @param {Array<Object>} tracks - dash.js MediaInfo objects.
   * @param {?Map<string, Object>} [details] - DashPlayer.representationDetails.
   * @return {Map<string, AudioLevel>}
   */
  static getAudioLevelList(tracks, details = null) {
    // make into map
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
          audioCodec: this.mimeCodecToCodec(track.codec),
          track: track,
          decoding: cachedAnswer(details?.get(levelId)?.probe ?? null),
        }));
      });
    });

    return map;
  }
}

