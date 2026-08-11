import {
  ScreenShieldDetector,
  changedFraction,
} from "./screenShieldDetector";

/**
 * Screenshare privacy shield: a TrackProcessor on the OUTGOING screen track
 * that pixelates the OS notification corner when something abruptly appears
 * there, BEFORE any frame leaves the machine (pipeline is processor →
 * encoder → E2EE → SFU, so the shielded frame is all anyone ever gets —
 * including the server).
 *
 * Detection is deliberately ML-free: a downscaled luma diff of the corner
 * fed to ScreenShieldDetector's stability-gated trigger. Only meaningful on
 * MONITOR shares (window shares don't capture other apps' toasts) — the
 * attach site gates on `displaySurface`.
 *
 * Modeled on FaceFilterProcessor: same init/restart/destroy contract
 * (LiveKit calls `restart` unconditionally on device switch — its absence
 * was a real crash), same per-frame canvas resize (display surfaces change
 * resolution on window resize / monitor switch).
 */

/** Corner monitored/redacted: right 34% × bottom 38% of the frame — covers
 * Windows toast geometry plus a short stack, across common scalings. */
const REGION_W = 0.34;
const REGION_H = 0.38;

/** Downscaled corner sample for the diff (fixed size keeps cost flat at 4K). */
const SAMPLE_W = 64;
const SAMPLE_H = 48;

/** Diff cadence — the detector needs tens of ms resolution, not per-frame. */
const SAMPLE_INTERVAL_MS = 150;

/** Mosaic cell target: region drawn through a canvas this many times smaller. */
const MOSAIC_FACTOR = 24;

export class ScreenShieldProcessor {
  name = "screen-shield-processor";
  processedTrack: MediaStreamTrack | undefined;
  source: MediaStreamTrack | undefined;

  #video: HTMLVideoElement | undefined;
  #canvas: HTMLCanvasElement | undefined;
  #ctx: CanvasRenderingContext2D | undefined;
  #sampleCanvas: HTMLCanvasElement | undefined;
  #sampleCtx: CanvasRenderingContext2D | undefined;
  #mosaicCanvas: HTMLCanvasElement | undefined;
  #mosaicCtx: CanvasRenderingContext2D | undefined;

  #vfcId: number | undefined;
  #rafId: number | undefined;
  #stopped = false;

  #detector = new ScreenShieldDetector();
  #lastSample: Uint8ClampedArray | undefined;
  #lastSampleAtMs = 0;
  #shielding = false;

  async init(opts: { track: MediaStreamTrack }) {
    this.#stopped = false;
    this.source = opts.track;
    this.#detector.reset();
    this.#lastSample = undefined;

    this.#video = document.createElement("video");
    this.#video.srcObject = new MediaStream([opts.track]);
    this.#video.muted = true;
    await this.#video.play();

    this.#canvas = document.createElement("canvas");
    this.#canvas.width = this.#video.videoWidth || 1280;
    this.#canvas.height = this.#video.videoHeight || 720;
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("screen-shield: no 2d context");
    this.#ctx = ctx;

    this.#sampleCanvas = document.createElement("canvas");
    this.#sampleCanvas.width = SAMPLE_W;
    this.#sampleCanvas.height = SAMPLE_H;
    // Frequent getImageData: hint the canvas to stay CPU-side.
    const sampleCtx = this.#sampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    if (!sampleCtx) throw new Error("screen-shield: no sample context");
    this.#sampleCtx = sampleCtx;

    this.#mosaicCanvas = document.createElement("canvas");
    const mosaicCtx = this.#mosaicCanvas.getContext("2d");
    if (!mosaicCtx) throw new Error("screen-shield: no mosaic context");
    this.#mosaicCtx = mosaicCtx;

    const stream = this.#canvas.captureStream(30);
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("screen-shield: captureStream yielded no track");
    this.processedTrack = track;

    this.#scheduleFrame();
  }

  /** Live rebind (LiveKit calls this unconditionally on track restarts). */
  async restart(opts: { track: MediaStreamTrack }) {
    if (!this.#video) {
      await this.init(opts);
      return;
    }
    this.source = opts.track;
    this.#video.srcObject = new MediaStream([opts.track]);
    await this.#video.play();
    this.#detector.reset();
    this.#lastSample = undefined;
    this.#scheduleFrame();
  }

  async destroy() {
    this.#stopped = true;
    this.#cancelFrame();
    this.processedTrack?.stop();
    this.processedTrack = undefined;
    this.#video?.pause();
    this.#video = undefined;
    this.#canvas = undefined;
    this.#ctx = undefined;
    this.#sampleCanvas = undefined;
    this.#sampleCtx = undefined;
    this.#mosaicCanvas = undefined;
    this.#mosaicCtx = undefined;
    this.source = undefined;
    this.#lastSample = undefined;
  }

  #scheduleFrame() {
    this.#cancelFrame();
    const video = this.#video;
    if (!video || this.#stopped) return;
    if ("requestVideoFrameCallback" in video) {
      const tick = () => {
        if (this.#stopped) return;
        this.#drawFrame();
        this.#vfcId = video.requestVideoFrameCallback(tick);
      };
      this.#vfcId = video.requestVideoFrameCallback(tick);
    } else {
      const tick = () => {
        if (this.#stopped) return;
        this.#drawFrame();
        this.#rafId = requestAnimationFrame(tick);
      };
      this.#rafId = requestAnimationFrame(tick);
    }
  }

  #cancelFrame() {
    if (this.#vfcId !== undefined) {
      this.#video?.cancelVideoFrameCallback?.(this.#vfcId);
      this.#vfcId = undefined;
    }
    if (this.#rafId !== undefined) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = undefined;
    }
  }

  #drawFrame() {
    const video = this.#video;
    const canvas = this.#canvas;
    const ctx = this.#ctx;
    if (!video || !canvas || !ctx || video.videoWidth === 0) return;

    // Display surfaces change size (window resize, monitor switch, quality
    // constraint changes) — resync every frame, FaceFilterProcessor-style.
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      // Old-resolution baseline would read as one giant change.
      this.#detector.reset();
      this.#lastSample = undefined;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const rx = Math.floor(canvas.width * (1 - REGION_W));
    const ry = Math.floor(canvas.height * (1 - REGION_H));
    const rw = canvas.width - rx;
    const rh = canvas.height - ry;

    const now = performance.now();
    if (now - this.#lastSampleAtMs >= SAMPLE_INTERVAL_MS) {
      this.#lastSampleAtMs = now;
      this.#shielding = this.#sampleAndDecide(video, rx, ry, rw, rh, now);
    }

    if (this.#shielding) this.#mosaic(rx, ry, rw, rh);
  }

  #sampleAndDecide(
    video: HTMLVideoElement,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    nowMs: number,
  ): boolean {
    const sctx = this.#sampleCtx;
    if (!sctx) return this.#shielding;
    sctx.drawImage(video, rx, ry, rw, rh, 0, 0, SAMPLE_W, SAMPLE_H);
    const current = sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;

    let verdict = this.#shielding;
    if (this.#lastSample) {
      verdict = this.#detector.feed(
        changedFraction(this.#lastSample, current),
        nowMs,
      );
    }
    this.#lastSample = current;
    return verdict;
  }

  /** Mosaic the region on the OUTPUT canvas: draw it small, scale it back up
   * with smoothing off. Reads as deliberate redaction rather than a glitch. */
  #mosaic(rx: number, ry: number, rw: number, rh: number) {
    const canvas = this.#canvas;
    const ctx = this.#ctx;
    const mosaic = this.#mosaicCanvas;
    const mctx = this.#mosaicCtx;
    if (!canvas || !ctx || !mosaic || !mctx) return;

    const mw = Math.max(1, Math.round(rw / MOSAIC_FACTOR));
    const mh = Math.max(1, Math.round(rh / MOSAIC_FACTOR));
    if (mosaic.width !== mw || mosaic.height !== mh) {
      mosaic.width = mw;
      mosaic.height = mh;
    }

    mctx.drawImage(canvas, rx, ry, rw, rh, 0, 0, mw, mh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mosaic, 0, 0, mw, mh, rx, ry, rw, rh);
    ctx.imageSmoothingEnabled = true;
  }
}
