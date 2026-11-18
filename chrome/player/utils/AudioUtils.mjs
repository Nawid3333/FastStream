// @ts-check

/** @param {number} fHz */
function ituR468_dB(fHz) {
  if (!Number.isFinite(fHz) || fHz <= 0) return -Infinity;
  const f = fHz;
  const f2 = f * f; const f3 = f2 * f; const f4 = f2 * f2; const f5 = f3 * f2; const f6 = f3 * f3;

  const h1 = -4.737338981378384e-24 * f6 +
           2.043828333606125e-15 * f4 -
           1.363894795463638e-07 * f2 +
           1.0;

  const h2 = 1.306612257412824e-19 * f5 -
           2.118150887518656e-11 * f3 +
           5.559488023498642e-04 * f;

  const R = (1.246332637532143e-4 * f) / Math.sqrt(h1 * h1 + h2 * h2);
  return 18.2 + 20 * Math.log10(R);
}

const _weightsCache = new WeakMap(); // analyser -> { fftSize, sampleRate, weights: Float32Array }

/** @param {AnalyserNode} analyser - Weights are normalized so the peak bin is 1.0. */
function get468WeightsForAnalyser(analyser) {
  const fftSize = analyser.fftSize;
  const sampleRate = analyser.context.sampleRate;
  const bufferLength = analyser.frequencyBinCount;

  let entry = _weightsCache.get(analyser);
  if (entry && entry.fftSize === fftSize && entry.sampleRate === sampleRate) {
    return entry.weights;
  }

  const weights = new Float32Array(bufferLength);
  const binHz = sampleRate / fftSize;

  let maxW = 0;
  weights[0] = 0; // DC
  for (let i = 1; i < bufferLength; i++) {
    const dB = ituR468_dB(i * binHz);
    const w = dB === -Infinity ? 0 : Math.pow(10, dB / 20);
    weights[i] = w;
    if (w > maxW) maxW = w;
  }

  const invMax = maxW > 0 ? 1 / maxW : 1;
  for (let i = 1; i < bufferLength; i++) {
    weights[i] *= invMax;
  }

  entry = {fftSize, sampleRate, weights};
  _weightsCache.set(analyser, entry);
  return weights;
}

// What AnalyserNode's Blackman window takes off a signal's power.
const BLACKMAN_MEAN_SQUARE = 0.42 * 0.42 + 0.5 * 0.5 / 2 + 0.08 * 0.08 / 2;

// Kept per analyser: getVolume runs for every meter on every frame.
const _frequencyArrays = new WeakMap();

export class AudioUtils {
  // dB of full scale (a full-scale sine is -3 dB).
  static VOLUME_FLOOR_DB = -70;
  static VOLUME_CEILING_DB = 0;

  /** @param {AudioContext} audioContext */
  static createVolumeAnalyserNode(audioContext) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    analyser.maxDecibels = AudioUtils.VOLUME_CEILING_DB;
    analyser.minDecibels = AudioUtils.VOLUME_FLOOR_DB;
    return analyser;
  }

  /**
   * The ITU-R 468 weighted level in dB of full scale, at least the analyser's minDecibels.
   * @param {AnalyserNode} analyser
   * @return {number}
   */
  static getVolume(analyser) {
    const bufferLength = analyser.frequencyBinCount;
    let dataArray = _frequencyArrays.get(analyser);
    if (!dataArray || dataArray.length !== bufferLength) {
      dataArray = new Float32Array(bufferLength);
      _frequencyArrays.set(analyser, dataArray);
    }
    // Float, not byte data: the bytes clip at maxDecibels.
    analyser.getFloatFrequencyData(dataArray);

    const minDb = analyser.minDecibels;
    const weights = get468WeightsForAnalyser(analyser);

    let sum = 0;
    for (let i = 1; i < bufferLength; i++) {
      const dB = dataArray[i];
      if (!(dB > -Infinity)) continue; // silence, or nothing yet

      const amp = Math.pow(10, dB / 20) * weights[i];
      sum += amp * amp;
    }

    // Parseval: the bins hold half the spectrum, each divided by the window's length.
    const meanSquare = 2 * sum / BLACKMAN_MEAN_SQUARE;
    const volumeDb = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity;
    return Math.max(minDb, volumeDb);
  }
}
