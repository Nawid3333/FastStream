import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LevelManager} from '../../chrome/player/players/LevelManager.mjs';

// DashPlayer's side of the codec fallback (#348): a MEDIA_ERR_DECODE on its <video> counts
// against the codec of the level playing, which LevelManager leaves out from the second one
// (decodingAwareQuality.test.mjs). dash.js itself is not needed for that, and not loaded.
vi.mock('../../chrome/player/modules/dash.mjs', () => ({MediaPlayer: () => ({create: () => ({})})}));
const {default: DashPlayer} = await import('../../chrome/player/players/dash/DashPlayer.mjs');

const AV1 = 'av01.0.05M.08';

/**
 * The parts of a DashPlayer onVideoError reads, with a real LevelManager.
 * @param {Object} error - The <video>'s MediaError.
 * @return {{player: Object, levelManager: LevelManager}}
 */
function playing(error) {
  const levelManager = Object.create(LevelManager.prototype);
  levelManager.videoDecodeFailures = new Map();
  const player = {
    dash: {},
    video: {error},
    client: {getLevelManager: () => levelManager},
    getCurrentVideoLevelID: () => 'video-6',
    getVideoLevels: () => new Map([['video-6', {id: 'video-6', videoCodec: AV1}]]),
  };
  return {player, levelManager};
}

const decodeError = (message) => ({code: 3, message});

describe('DashPlayer, a decode error', () => {
  beforeEach(() => {
    vi.stubGlobal('MediaError', {MEDIA_ERR_DECODE: 3});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('counts against the video codec of the level playing', () => {
    // The real-streams check's message, 2026-10-05.
    const {player, levelManager} = playing(decodeError('RemoteVideoDecoderChild::InitIPDL: RemoteMediaManager is not available.'));
    DashPlayer.prototype.onVideoError.call(player);
    expect(levelManager.isVideoCodecFailed(AV1)).toBe(false);
    DashPlayer.prototype.onVideoError.call(player);
    expect(levelManager.isVideoCodecFailed(AV1)).toBe(true);
  });

  it('asks the client once, at the failure that leaves the codec out, to load the source again', () => {
    const {player} = playing(decodeError('RemoteVideoDecoderChild::InitIPDL'));
    DashPlayer.prototype.onVideoError.call(player);
    expect(DashPlayer.prototype.takeCodecReload.call(player)).toBe(false);
    DashPlayer.prototype.onVideoError.call(player);
    expect(DashPlayer.prototype.takeCodecReload.call(player)).toBe(true);
    expect(DashPlayer.prototype.takeCodecReload.call(player)).toBe(false);
    DashPlayer.prototype.onVideoError.call(player);
    expect(DashPlayer.prototype.takeCodecReload.call(player)).toBe(false);
  });

  it('does not count an audio decoder\'s failure against the video codec', () => {
    const {player, levelManager} = playing(decodeError('FFmpegAudioDecoder: decode error'));
    DashPlayer.prototype.onVideoError.call(player);
    DashPlayer.prototype.onVideoError.call(player);
    expect(levelManager.isVideoCodecFailed(AV1)).toBe(false);
  });

  it('counts nothing for another kind of error, or after the player was destroyed', () => {
    const network = playing({code: 2, message: ''});
    DashPlayer.prototype.onVideoError.call(network.player);
    DashPlayer.prototype.onVideoError.call(network.player);
    expect(network.levelManager.isVideoCodecFailed(AV1)).toBe(false);
    const destroyed = playing(decodeError(''));
    destroyed.player.dash = null;
    DashPlayer.prototype.onVideoError.call(destroyed.player);
    DashPlayer.prototype.onVideoError.call(destroyed.player);
    expect(destroyed.levelManager.isVideoCodecFailed(AV1)).toBe(false);
  });

  it('survives a level it cannot read, as in a teardown', () => {
    const {player, levelManager} = playing(decodeError(''));
    player.getCurrentVideoLevelID = () => {
      throw new Error('no active stream');
    };
    expect(() => DashPlayer.prototype.onVideoError.call(player)).not.toThrow();
    expect(levelManager.videoDecodeFailures.size).toBe(0);
  });
});
