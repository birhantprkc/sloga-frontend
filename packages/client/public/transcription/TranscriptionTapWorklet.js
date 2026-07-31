/**
 * Copies one participant's audio out to the main thread for transcription.
 *
 * A tap, not a filter: it never modifies the signal and its output is silence.
 * The node exists in a private AudioContext whose destination nobody listens
 * to, purely so the graph gets pulled and `process()` keeps being called.
 *
 * Chunks are batched to ~100ms before posting. A render quantum is 128 frames,
 * which at 16kHz is 8ms — posting every quantum would put ~125 messages per
 * second per participant on the main thread for no benefit, since the segmenter
 * downstream works in 20ms frames and only acts on utterance boundaries.
 *
 * `postMessage` rather than a SharedArrayBuffer ring: this app does not serve
 * COOP/COEP (cross-origin isolation would break cross-origin media), so SAB is
 * unavailable. The copy is also what makes capture survive teardown — audio
 * already handed to the main thread is not lost when the track stops.
 */

const CHUNK_SAMPLES = 1600; // 100ms at 16kHz

class TranscriptionTapProcessor extends AudioWorkletProcessor {
  #buffer = new Float32Array(CHUNK_SAMPLES);
  #filled = 0;
  #stopped = false;

  constructor() {
    super();
    this.port.onmessage = (event) => {
      if (event.data === "stop") {
        this.#flush();
        this.#stopped = true;
        this.port.close();
      }
    };
  }

  #flush() {
    if (this.#filled === 0) return;
    // slice() copies — the buffer is reused immediately below.
    this.port.postMessage(this.#buffer.slice(0, this.#filled));
    this.#filled = 0;
  }

  process(inputs) {
    if (this.#stopped) return false;

    const channel = inputs[0]?.[0];
    // No input yet (or a muted track) — stay alive, the track may come back.
    if (!channel) return true;

    for (let i = 0; i < channel.length; i++) {
      this.#buffer[this.#filled++] = channel[i];
      if (this.#filled === CHUNK_SAMPLES) this.#flush();
    }

    return true;
  }
}

registerProcessor("TranscriptionTap", TranscriptionTapProcessor);
