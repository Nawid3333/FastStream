// @ts-check
// --- ITU-R 468 weighting with per-bin cache, returns dBFS ---

// 468 curve in dB
/** @param {number} fHz - Frequency in hertz. */
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

// Cache of per-bin weights per AnalyserNode
const _weightsCache = new WeakMap(); // analyser -> { fftSize, sampleRate, weights: Float32Array }

// Build or reuse weights. Normalize so the peak bin weight equals 1.0
/** @param {AnalyserNode} analyser - The analyser to weight the frequency bins for. */
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

  // First pass: compute unnormalized linear weights and track the max
  let maxW = 0;
  weights[0] = 0; // DC
  for (let i = 1; i < bufferLength; i++) {
    const dB = ituR468_dB(i * binHz);
    const w = dB === -Infinity ? 0 : Math.pow(10, dB / 20);
    weights[i] = w;
    if (w > maxW) maxW = w;
  }

  // Second pass: normalize to peak 1.0
  const invMax = maxW > 0 ? 1 / maxW : 1;
  for (let i = 1; i < bufferLength; i++) {
    weights[i] *= invMax;
  }

  entry = {fftSize, sampleRate, weights};
  _weightsCache.set(analyser, entry);
  return weights;
}

// The mean square of the Blackman window AnalyserNode applies (a0 0.42, a1 0.5, a2 0.08):
// what the window takes off a signal's power.
const BLACKMAN_MEAN_SQUARE = 0.42 * 0.42 + 0.5 * 0.5 / 2 + 0.08 * 0.08 / 2;

// Each analyser's frequency array, kept: getVolume runs for every meter on every frame.
const _frequencyArrays = new WeakMap();

/**
 * The volume meters' level, from an AnalyserNode. (The mixer's dB scale, the clip check and
 * the channel layouts went with the audio settings window, 2026-10-10.)
 */
export class AudioUtils {
  /**
   * The range the volume meters and the silence graph show, in dB of full scale (a
   * full-scale sine is -3 dB). Volume analysers carry it as their min/maxDecibels.
   */
  static VOLUME_FLOOR_DB = -70;
  static VOLUME_CEILING_DB = 0;

  /** @param {AudioContext} audioContext - The audio context to create the volume analyser on. */
  static createVolumeAnalyserNode(audioContext) {
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.5;
    analyser.maxDecibels = AudioUtils.VOLUME_CEILING_DB;
    analyser.minDecibels = AudioUtils.VOLUME_FLOOR_DB;
    return analyser;
  }

  /**
   * Calculates the volume in decibels from an AnalyserNode: the ITU-R 468 weighted level,
   * in dB of full scale (a full-scale sine near 6.3 kHz, where the weight is 1, is -3 dB),
   * at least the analyser's minDecibels.
   * @param {AnalyserNode} analyser - The Web Audio analyser node.
   * @return {number} The volume in decibels.
   */
  static getVolume(analyser) {
    const bufferLength = analyser.frequencyBinCount;
    let dataArray = _frequencyArrays.get(analyser);
    if (!dataArray || dataArray.length !== bufferLength) {
      dataArray = new Float32Array(bufferLength);
      _frequencyArrays.set(analyser, dataArray);
    }
    // In dB, as they are: the bytes stopped at maxDecibels (-30 then), so every bin of a
    // tone louder than about -16 dB of full scale read the same, and the meters filled
    // no further.
    analyser.getFloatFrequencyData(dataArray);

    const minDb = analyser.minDecibels;
    const weights = get468WeightsForAnalyser(analyser);

    // Combine bins in linear power
    let sum = 0;
    for (let i = 1; i < bufferLength; i++) {
      const dB = dataArray[i];
      if (!(dB > -Infinity)) continue; // silence, or nothing yet

      // Convert to linear amplitude, apply cached 468 weight
      const amp = Math.pow(10, dB / 20) * weights[i];
      sum += amp * amp;
    }

    // The signal's mean square, from its spectrum (Parseval): the analyser divides each bin
    // by its window's length, shows half the spectrum, and applies a Blackman window. The
    // bins' power was averaged instead of added, which put every level 21 dB low (128 bins).
    const meanSquare = 2 * sum / BLACKMAN_MEAN_SQUARE;
    const volumeDb = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -Infinity;
    return Math.max(minDb, volumeDb);
  }
}
