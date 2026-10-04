import {describe, expect, it} from 'vitest';
import {AudioUtils} from '../../chrome/player/utils/AudioUtils.mjs';

// The volume meters, the silence graph and the silence skipper read AudioUtils.getVolume.
// It averaged the analyser's 127 bins' power instead of adding it, which put every level
// 21 dB low, and read the bins as bytes, which stop at maxDecibels (-30): every tone louder
// than about -16 dB of full scale read the same, and the meters filled no further (#202).

/**
 * An AnalyserNode as the Web Audio spec computes its frequency data, without smoothing (a
 * steady signal's smoothed value): a Blackman window, a DFT divided by the window's length,
 * the first half of the bins, in dB.
 * @param {function(number): number} signal - The input at a time, in seconds.
 * @return {Object}
 */
function analyser(signal) {
  const node = AudioUtils.createVolumeAnalyserNode(audioContext());
  const size = node.fftSize;
  const rate = 48000;
  return Object.assign(node, {
    frequencyBinCount: size / 2,
    context: {sampleRate: rate},
    getByteFrequencyData(array) {
      const db = new Float32Array(array.length);
      this.getFloatFrequencyData(db);
      for (let k = 0; k < array.length; k++) {
        const scaled = 255 * (db[k] - this.minDecibels) / (this.maxDecibels - this.minDecibels);
        array[k] = Math.max(0, Math.min(255, Math.floor(scaled)));
      }
    },
    getFloatFrequencyData(array) {
      for (let k = 0; k < array.length; k++) {
        let re = 0;
        let im = 0;
        for (let n = 0; n < size; n++) {
          const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / size) + 0.08 * Math.cos(4 * Math.PI * n / size);
          const x = w * signal(n / rate);
          re += x * Math.cos(2 * Math.PI * k * n / size);
          im -= x * Math.sin(2 * Math.PI * k * n / size);
        }
        array[k] = 20 * Math.log10(Math.hypot(re, im) / size);
      }
    },
  });
}

/**
 * @return {{createAnalyser: function(): Object}} An audio context whose analysers start with
 *   the spec's default range, -100 to -30 dB.
 */
function audioContext() {
  return {createAnalyser: () => ({minDecibels: -100, maxDecibels: -30})};
}

// Bin 34 of 128 at 48 kHz, where ITU-R 468 weighs most (about 6.3 kHz).
const PEAK_HZ = 34 * 48000 / 256;
const sine = (level, hz = PEAK_HZ) => (t) => level * Math.sin(2 * Math.PI * hz * t);
const dB = (level) => 20 * Math.log10(level);

describe('AudioUtils.getVolume', () => {
  it('reads a full-scale sine where the weight is 1 at its RMS: -3 dB of full scale', () => {
    expect(AudioUtils.getVolume(analyser(sine(1)))).toBeCloseTo(-3, 0);
  });

  it('keeps 20 dB between sines 20 dB apart, loud ones too', () => {
    // The bytes stopped at -30 dB a bin: -6 and -26 dB of full scale read nearly the same.
    for (const loud of [1, 0.5, 0.1]) {
      const a = AudioUtils.getVolume(analyser(sine(loud)));
      const b = AudioUtils.getVolume(analyser(sine(loud / 10)));
      expect(a - b, `${dB(loud)} dB`).toBeCloseTo(20, 1);
    }
  });

  it('reads silence as the floor of the meters', () => {
    expect(AudioUtils.getVolume(analyser(() => 0))).toBe(AudioUtils.VOLUME_FLOOR_DB);
  });

  it('gives volume analysers the range the meters show', () => {
    const node = AudioUtils.createVolumeAnalyserNode(audioContext());
    expect(node.minDecibels).toBe(AudioUtils.VOLUME_FLOOR_DB);
    expect(node.maxDecibels).toBe(AudioUtils.VOLUME_CEILING_DB);
    expect(AudioUtils.VOLUME_CEILING_DB).toBe(0);
  });
});
