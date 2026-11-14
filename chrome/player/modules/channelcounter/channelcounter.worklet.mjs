// @ts-check
registerProcessor('channelcounter-worklet', class ChannelCounter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputChannelCount = 0;
    this._closed = false;

    this.port.onmessage = (event) => {
      if (event.data.type === 'close') {
        this.close();
      }
    };
  }
  /**
   * @param {Float32Array[][]} input
   * @param {Float32Array[][]} output
   * @param {Record<string, Float32Array>} parameters
   * @return {boolean}
   */
  process(input, output, parameters) {
    if (this._closed) {
      return false;
    }
    if (input && input[0].length != this.inputChannelCount) {
      this.inputChannelCount = input[0].length;
      this.port.postMessage(input[0].length);
    }
    return true;
  }

  close() {
    this._closed = true;
  }
});
