// What a script run by `audioWorklet.addModule()` sees (AudioWorkletGlobalScope). TypeScript's
// DOM library declares the page's side of it (AudioWorkletNode) but not the worklet's own
// globals, and no `@types` package for them is installed. Only what
// chrome/player/modules/channelcounter/channelcounter.worklet.mjs uses.

declare class AudioWorkletProcessor {
  constructor();
  readonly port: MessagePort;
}

declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & {
    process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
  },
): void;
