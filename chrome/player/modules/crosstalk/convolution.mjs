import {VirtualAudioNode} from '../../ui/audio/VirtualAudioNode.mjs';
import {FFT} from './fft.mjs';

const IMPULSE_BUFFER_SIZE = 1024;
const FREQUENCY_BUFFER_SIZE = IMPULSE_BUFFER_SIZE * 4;
const SHIFT_AMOUNT = 256;

/* eslint-disable camelcase */
export class ConvolutionXTC {
  constructor(audioContext, options) {
    this.audioContext = audioContext;
    this.cachedOptions = {};
    this.currentConvolver = 0;
    this.fft = new FFT(FREQUENCY_BUFFER_SIZE);
    this.configure(options);
  }

  getInputNode() {
    return this.inputNode;
  }

  getBypassInputNode() {
    return this.inputBypassNode;
  }

  getOutputNode() {
    return this.outputNode;
  }

  idft(X) {
    const x = new Float32Array(X.length);
    this.fft.inverseTransform(x, X);
    return this.fft.fromComplexArray(x, new Float32Array(x.length / 2));
  }

  complexMultiply([a, b], [c, d]) {
    return [a * c - b * d, a * d + b * c];
  }

  complexDivide([a, b], [c, d]) {
    const den = c * c + d * d;
    return [(a * c + b * d) / den, (b * c - a * d) / den];
  }

  complexPower([a, b], n) {
    const r = Math.sqrt(a * a + b * b);
    const theta = Math.atan2(b, a);
    const rN = Math.pow(r, n);
    const thetaN = n * theta;
    return [rN * Math.cos(thetaN), rN * Math.sin(thetaN)];
  }

  calculateH(g, omegatc, B) {
    const x1 = [Math.cos(omegatc), Math.sin(omegatc)];
    const x2 = [Math.cos(2 * omegatc), Math.sin(2 * omegatc)];
    const x3 = [Math.cos(3 * omegatc), Math.sin(3 * omegatc)];
    const x4 = [Math.cos(4 * omegatc), Math.sin(4 * omegatc)];
    const gg = g * g;

    const gbb1 = Math.pow(gg + B, 2) + 2*B + 1;
    const den = [gg*x4[0] + gg - x2[0] * gbb1, gg*x4[1] - x2[1] * gbb1];
    const num1 = [gg*x4[0] - (B + 1) * x2[0], gg*x4[1] - (B + 1) * x2[1]];
    const ggb = g*(gg + B);
    const num2 = [g*x1[0] - ggb*x3[0], g*x1[1] - ggb*x3[1]];

    const [a, b] = this.complexDivide(num1, den);
    const [c, d] = this.complexDivide(num2, den);

    return [a, b, c, d];
  }

  rotateBuffer(buffer, amount) {
    if (amount === 0) {
      return;
    }
    // rotate right
    const temp = buffer.slice(-amount);
    buffer.copyWithin(amount, 0, buffer.length - amount);
    buffer.set(temp, 0);
  }

  configure(options) {
    const g = options.g;
    // In samples, and not rounded to whole ones: at 48 kHz that moved the microdelay knob in
    // steps of 20.8 us, so most of its range changed nothing.
    const tc = options.tc;
    let y = options.y;

    if (this.cachedOptions.g === g && this.cachedOptions.tc === tc && this.cachedOptions.y === y) {
      return;
    }

    this.cachedOptions = {
      g, tc, y,
    };

    const gg = g * g;
    const n = FREQUENCY_BUFFER_SIZE;
    const H_CIS = new Float32Array(n * 2);
    const H_CROSS = new Float32Array(n * 2);

    const B_P = 0;

    const max_y = 1.0 / (1.0 - g);
    const min_y = Math.max(1.0, Math.sqrt(5 + Math.sqrt(5)) / 2 / Math.sqrt(gg + 1));
    y = Math.max(min_y, y);
    const valid = isFinite(y) && y <= max_y;

    // The positive frequencies; the negative ones mirror them below, as they must for a
    // real impulse response. A delay of whole samples gave that by itself, a fraction does not.
    for (let k = 0; k <= n / 2; k++) {
      const omegatc = 2 * Math.PI * k / n * tc;
      const cos = Math.cos(omegatc);
      const cm_I = Math.sqrt(gg - 2*g*cos + 1);
      const cm_II = Math.sqrt(gg + 2*g*cos + 1);
      const sp = Math.max(1/cm_I, 1/cm_II);

      let H;
      if (sp < y || !valid) {
        H = this.calculateH(g, omegatc, B_P);
      } else if (cm_I < cm_II) {
        const B_I = -gg + 2*g*cos + cm_I / y - 1;
        H = this.calculateH(g, omegatc, B_I);
      } else {
        const B_II = -gg - 2*g*cos + cm_II / y - 1;
        H = this.calculateH(g, omegatc, B_II);
      }

      H_CIS[k * 2] = H[0];
      H_CIS[k * 2 + 1] = H[1];
      H_CROSS[k * 2] = H[2];
      H_CROSS[k * 2 + 1] = H[3];
      if (k > 0 && k < n / 2) {
        H_CIS[(n - k) * 2] = H[0];
        H_CIS[(n - k) * 2 + 1] = -H[1];
        H_CROSS[(n - k) * 2] = H[2];
        H_CROSS[(n - k) * 2 + 1] = -H[3];
      }
    }
    // A real filter's response at the Nyquist frequency is real.
    H_CIS[n + 1] = 0;
    H_CROSS[n + 1] = 0;

    this.H_CIS = H_CIS;
    this.H_CROSS = H_CROSS;

    this.h_CIS = this.idft(H_CIS);
    this.h_CROSS = this.idft(H_CROSS);
    this.rotateBuffer(this.h_CIS, SHIFT_AMOUNT);
    this.rotateBuffer(this.h_CROSS, SHIFT_AMOUNT);
    if (this.buffer_XTC) {
      this.updateBuffers();
    }
  }

  updateBuffers() {
    this.buffer_XTC.copyToChannel(this.h_CIS.subarray(0, IMPULSE_BUFFER_SIZE), 0);
    this.buffer_XTC.copyToChannel(this.h_CROSS.subarray(0, IMPULSE_BUFFER_SIZE), 1);
    this.buffer_XTC.copyToChannel(this.h_CROSS.subarray(0, IMPULSE_BUFFER_SIZE), 2);
    this.buffer_XTC.copyToChannel(this.h_CIS.subarray(0, IMPULSE_BUFFER_SIZE), 3);
    const current = this.currentConvolver;
    const other = (current + 1) % 2;
    this.convolvers_XTC[other].buffer = this.buffer_XTC;

    if (!this.switchTimeout) {
      // Connected with no output index, as it is disconnected: connected with one (which
      // meant nothing here), the disconnect below never matched it and threw into an
      // empty catch, so both convolvers ran for good, at twice the CPU.
      this.getInputNode().connect(this.convolvers_XTC[other]);
    }

    clearTimeout(this.switchTimeout);
    this.switchTimeout = setTimeout(() => {
      this.getOutputNode().connectFrom(this.convolvers_XTC[other]);
      this.detachConvolver(this.convolvers_XTC[current]);

      this.currentConvolver = other;
      this.switchTimeout = null;
    }, 100);
  }

  // Takes a convolver off the input and the output where it is on them: the first switch
  // has no convolver to retire, and while a switch is pending both are on the input.
  detachConvolver(convolver) {
    if (this.getInputNode().indexConnectedTo(convolver) !== -1) {
      this.getInputNode().disconnect(convolver);
    }
    if (this.getOutputNode().indexConnectedFrom(convolver) !== -1) {
      this.getOutputNode().disconnectFrom(convolver);
    }
  }

  async init() {
    this.inputNode = new VirtualAudioNode('ConvolutionXTC Input');
    this.inputBypassNode = new VirtualAudioNode('ConvolutionXTC Bypass Input');
    this.outputNode = new VirtualAudioNode('ConvolutionXTC Output');
    const ctx = this.audioContext;
    // create convolver nodes
    this.buffer_XTC = ctx.createBuffer(4, IMPULSE_BUFFER_SIZE, ctx.sampleRate);
    this.buffer_BYPASS = ctx.createBuffer(1, IMPULSE_BUFFER_SIZE, ctx.sampleRate);

    this.convolvers_XTC = [ctx.createConvolver(), ctx.createConvolver()];
    this.convolver_BYPASS = ctx.createConvolver();

    const convolvers = this.convolvers_XTC.concat([this.convolver_BYPASS]);
    convolvers.forEach((convolver) => {
      convolver.normalize = false;
    });

    const h_BYPASS = new Float32Array(IMPULSE_BUFFER_SIZE);
    h_BYPASS[0] = 1;
    this.rotateBuffer(h_BYPASS, SHIFT_AMOUNT);
    this.buffer_BYPASS.getChannelData(0).set(h_BYPASS);
    this.convolver_BYPASS.buffer = this.buffer_BYPASS;

    this.getBypassInputNode().connect(this.convolver_BYPASS);
    this.getOutputNode().connectFrom(this.convolver_BYPASS);

    this.updateBuffers();
  }

  destroy() {
    clearTimeout(this.switchTimeout);
    this.switchTimeout = null;
    this.getBypassInputNode().disconnect(this.convolver_BYPASS);
    this.getOutputNode().disconnectFrom(this.convolver_BYPASS);

    this.convolvers_XTC.forEach((convolver) => {
      this.detachConvolver(convolver);
    });
    this.convolver_BYPASS = null;
    this.convolvers_XTC = null;
    this.buffer_XTC = null;
    this.buffer_BYPASS = null;
    this.inputNode = null;
    this.inputBypassNode = null;
    this.outputNode = null;
    this.fft = null;
  }
}
