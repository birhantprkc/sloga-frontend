/**
 * Pass-through RMS meter for the incoming-voice normalizer.
 *
 * Runs on the audio thread so levels keep flowing while the tab is hidden —
 * main-thread timers are throttled in background tabs, and the moment the
 * output goes quiet is exactly when the gain controller must keep tracking
 * (see audioNormalizer.ts). Audio passes through untouched; every ~50 ms one
 * linear RMS number crosses to the main thread, which owns all of the dB
 * math and gain decisions so they stay unit-testable.
 *
 * Served self-hosted from public/ — never a CDN; the desktop shell CSP
 * blocks external script origins outright.
 */
class NormalizerMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this._sumSquares = 0;
    this._count = 0;
    this._stopped = false;
    // ~50 ms at the context rate. At 48 kHz that is 2400 samples — wide
    // enough that plosives don't read as level spikes, short enough that the
    // controller sees a talker start within one smoothing constant.
    this._window = Math.max(128, Math.round(sampleRate * 0.05));
    // The controller's dispose() sends "stop". Without it, returning true
    // forever keeps this processor alive on the audio thread until the
    // whole context closes — actively-processing nodes are exempt from GC.
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this._stopped = true;
      }
    };
  }

  process(inputs, outputs) {
    if (this._stopped) {
      return false;
    }
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    for (let channel = 0; channel < output.length; channel++) {
      const source = input[channel] || input[0];
      if (source) {
        output[channel].set(source);
      }
    }

    const samples = input[0];
    if (samples) {
      for (let i = 0; i < samples.length; i++) {
        this._sumSquares += samples[i] * samples[i];
      }
      this._count += samples.length;
      if (this._count >= this._window) {
        this.port.postMessage(Math.sqrt(this._sumSquares / this._count));
        this._sumSquares = 0;
        this._count = 0;
      }
    }

    return true;
  }
}

registerProcessor("NormalizerMeter", NormalizerMeter);
