/**
 * Per-listener normalization of incoming voices: a slow AGC that levels loud
 * and quiet speakers toward one target, and a limiter that catches what the
 * AGC is too slow for. Receive-side by design — LiveKit is an SFU and never
 * transcodes Opus, so the listener's client is the only place every voice can
 * be levelled without touching what anyone else hears.
 *
 * Node chain, inserted into livekit's shared web-audio graph via
 * `RemoteAudioTrack.setWebAudioPlugins([meter, gain, limiter])`:
 *
 *   SDK source ─> meter (worklet, pass-through) ─> gain (AGC) ─> limiter ─> SDK volume ─> out
 *
 * The meter measures PRE-gain, so the controller is feed-forward: it reacts
 * to what the speaker sent, never to its own correction. The SDK's own volume
 * gain (output volume × per-user slider) sits AFTER the limiter — manual
 * boost deliberately scales the finished, levelled signal, and the per-user
 * slider therefore keeps working as a trim on top (§0.5 of the plan:
 * multiply, never replace). Exactly one writer touches our GainNode's
 * AudioParam: the controller. Nothing else may write it, or automation masks
 * the write silently.
 *
 * All tuning math lives in exported pure functions so a sign error in the dB
 * conversion is caught by a unit test, not by two people on two machines.
 */

/** RMS level the AGC steers speech toward. −24 dBFS leaves ~12–18 dB of
 *  speech crest factor below the limiter threshold, so the limiter only works
 *  transients instead of being a permanent compressor. */
export const NORMALIZER_TARGET_DB = -24;

/** The AGC will never attenuate more than this (a genuinely loud talker is
 *  still allowed to sound louder than the room). */
export const NORMALIZER_MAX_CUT_DB = -12;

/** Boost clamp at strength 100. The strength slider scales this linearly. */
export const NORMALIZER_MAX_BOOST_DB = 18;

/**
 * Ceiling on manual gain × AGC boost combined (§2.3). Output volume (max 3×)
 * times per-user volume (max 3×) is already +19 dB; an unchecked +18 dB AGC
 * on top would be +37 dB into the limiter. As manual gain rises, the boost
 * budget shrinks; past the ceiling the AGC can only cut.
 */
export const NORMALIZER_TOTAL_GAIN_CEILING_DB = 24;

/** Speech gate: open instantly at −45 dBFS, close only after the signal has
 *  stayed below −55 dBFS for the hold time. The band between is hysteresis —
 *  a quiet talker in a noisy room must not chatter the gate — and the hold
 *  bridges the gaps between words. While the gate is closed the AGC HOLDS its
 *  gain rather than adapting; without that, silence gets boosted toward the
 *  target and every quiet participant becomes audible hiss. */
export const NORMALIZER_GATE_OPEN_DB = -45;
export const NORMALIZER_GATE_CLOSE_DB = -55;
export const NORMALIZER_GATE_HOLD_MS = 400;

/** Asymmetric smoothing (seconds, `setTargetAtTime` time constants): gain
 *  comes DOWN fast — a suddenly loud talker is the complaint that hurts —
 *  and goes UP slowly, so the floor between sentences is not pumped. */
export const NORMALIZER_TAU_DOWN_S = 0.3;
export const NORMALIZER_TAU_UP_S = 1.5;

/** Limiter curve. With speech RMS steered to the −24 dBFS target, peaks
 *  (crest factor 12–18 dB) sit at or below this threshold, so the limiter
 *  works transients rather than running as a permanent compressor (§2.4). */
export const NORMALIZER_LIMITER_THRESHOLD_DB = -6;
export const NORMALIZER_LIMITER_RATIO = 12;

/**
 * `DynamicsCompressorNode` is NOT transparent below threshold: the Web Audio
 * spec mandates fixed makeup gain of `(1 / |curve(1)|)^0.6`, applied to
 * everything, always. For our curve that is ≈ +3.3 dB — enough that an
 * uncompensated A/B toggle reads as "normalization makes everyone louder"
 * and the §2.3 budget sits ~3 dB closer to full scale than designed. The
 * AGC gain node pre-compensates by this amount (the single-writer rule
 * keeps the compensation inside the one param we already own).
 *
 * Derivation, knee ignored (a soft knee only bends the curve near the
 * threshold; the makeup formula uses the curve at unity): a 0 dBFS input
 * leaves the compressor at `threshold + (0 − threshold) / ratio` dB, and
 * the spec's 0.6 exponent scales that back toward unity.
 */
export function limiterMakeupDb(thresholdDb: number, ratio: number): number {
  const outAtUnityDb = thresholdDb + (0 - thresholdDb) / ratio;
  return -0.6 * outAtUnityDb;
}

export const NORMALIZER_LIMITER_MAKEUP_DB = limiterMakeupDb(
  NORMALIZER_LIMITER_THRESHOLD_DB,
  NORMALIZER_LIMITER_RATIO,
);

/** Default strength for the settings slider (0–100). */
export const NORMALIZER_DEFAULT_STRENGTH = 50;

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number): number {
  return linear <= 0 ? -Infinity : 20 * Math.log10(linear);
}

/** Settings-slider hygiene: anything non-finite becomes the default, the
 *  rest clamps to 0–100. The stored value flows into gain math, so garbage
 *  here would be audible, not just cosmetic. */
export function clampStrength(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return NORMALIZER_DEFAULT_STRENGTH;
  }
  return Math.max(0, Math.min(100, value));
}

/** Strength scales only how far the AGC may BOOST. The cut side stays fixed:
 *  taming a loud talker is wanted at every strength, and the failure mode of
 *  over-boosting (noise pumping, echo pressure) is the risky half. */
export function maxBoostForStrength(strength: number): number {
  return (clampStrength(strength) / 100) * NORMALIZER_MAX_BOOST_DB;
}

/**
 * The boost budget after manual gain is accounted for (§2.3). `manualGain`
 * is linear (output volume × per-user volume, 1.0 = unity). Never negative:
 * running out of budget stops boosting, it does not start cutting — cuts are
 * the AGC's decision, not the budget's.
 */
export function boostBudgetDb(manualGain: number, maxBoostDb: number): number {
  const manualDb = Math.max(0, linearToDb(Math.max(manualGain, 1e-6)));
  return Math.max(
    0,
    Math.min(maxBoostDb, NORMALIZER_TOTAL_GAIN_CEILING_DB - manualDb),
  );
}

/** Where the AGC wants to sit for a measured level, before smoothing. */
export function desiredGainDb(measuredDb: number, maxBoostDb: number): number {
  return Math.max(
    NORMALIZER_MAX_CUT_DB,
    Math.min(maxBoostDb, NORMALIZER_TARGET_DB - measuredDb),
  );
}

export interface GateState {
  open: boolean;
  /** ms accumulated below the close threshold while open. */
  belowMs: number;
}

export const initialGateState: GateState = { open: false, belowMs: 0 };

/**
 * One tick of the speech gate. Pure so the hysteresis and hold can be
 * unit-tested; the controller feeds it real elapsed time between meter
 * messages.
 */
export function nextGateState(
  state: GateState,
  measuredDb: number,
  dtMs: number,
): GateState {
  if (measuredDb >= NORMALIZER_GATE_OPEN_DB) {
    return { open: true, belowMs: 0 };
  }
  if (measuredDb >= NORMALIZER_GATE_CLOSE_DB) {
    // Hysteresis band: no state change, and the hold timer resets — the
    // signal is not "gone", it is just a quiet talker.
    return { open: state.open, belowMs: 0 };
  }
  if (!state.open) {
    return state;
  }
  const belowMs = state.belowMs + Math.max(0, dtMs);
  return belowMs >= NORMALIZER_GATE_HOLD_MS
    ? { open: false, belowMs: 0 }
    : { open: true, belowMs };
}

/** Fast when reducing gain, slow when raising it. */
export function smoothingTauS(currentDb: number, desiredDb: number): number {
  return desiredDb < currentDb ? NORMALIZER_TAU_DOWN_S : NORMALIZER_TAU_UP_S;
}

/** Where the meter worklet is served from — self-hosted, never a CDN (the
 *  desktop shell's CSP blocks external script origins outright). */
function workletUrl(): string {
  return new URL(
    `${import.meta.env.BASE_URL}normalizer/NormalizerMeterWorklet.js`,
    window.location.origin,
  ).href;
}

/** Contexts that already have the meter module — `addModule` with a name
 *  that is already registered throws (same guard as voiceAudioPipeline). */
const workletLoaded = new WeakSet<AudioContext>();

/**
 * Load the meter worklet into the shared call context, once per context.
 * Rejection is the caller's signal to fall back to the raw path — one failed
 * asset fetch must degrade to "no normalization", never to broken audio.
 */
export async function ensureNormalizerWorklet(
  context: AudioContext,
): Promise<void> {
  if (workletLoaded.has(context)) return;
  await context.audioWorklet.addModule(workletUrl());
  workletLoaded.add(context);
}

/**
 * The per-track controller: owns the three nodes handed to
 * `setWebAudioPlugins` and drives the AGC from meter messages.
 *
 * Lifecycle contract (§2.5): whoever constructs this must call `dispose()`
 * when the track ends, the call is left, or normalization is switched off.
 * `dispose()` is synchronous and idempotent.
 */
export class TrackNormalizer {
  readonly nodes: AudioNode[];

  #context: AudioContext;
  #meter: AudioWorkletNode;
  #gain: GainNode;
  #limiter: DynamicsCompressorNode;

  #gate: GateState = initialGateState;
  #currentGainDb = 0;
  #maxBoostDb: number;
  #manualGain: number;
  #lastMeterAt: number | undefined;
  #disposed = false;

  constructor(
    context: AudioContext,
    opts: { strength: number; manualGain: number },
  ) {
    this.#context = context;
    this.#maxBoostDb = maxBoostForStrength(opts.strength);
    this.#manualGain = opts.manualGain;

    // ensureNormalizerWorklet must have resolved for this context first.
    this.#meter = new AudioWorkletNode(context, "NormalizerMeter", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
    });
    this.#gain = context.createGain();
    // Starts at the makeup pre-compensation, not unity, so the chain is
    // acoustically transparent from the first sample (see limiterMakeupDb).
    this.#gain.gain.value = dbToLinear(-NORMALIZER_LIMITER_MAKEUP_DB);

    // Limiter, not a compressor (§2.4 — see the threshold constant). Chrome's
    // DynamicsCompressorNode adds ~6 ms fixed lookahead delay; accepted.
    this.#limiter = context.createDynamicsCompressor();
    this.#limiter.threshold.value = NORMALIZER_LIMITER_THRESHOLD_DB;
    this.#limiter.knee.value = 4;
    this.#limiter.ratio.value = NORMALIZER_LIMITER_RATIO;
    this.#limiter.attack.value = 0.003;
    this.#limiter.release.value = 0.25;

    this.#meter.port.onmessage = (event: MessageEvent<number>) => {
      this.#onMeter(event.data);
    };

    this.nodes = [this.#meter, this.#gain, this.#limiter];
  }

  /** Live-tunable from the settings slider; applies from the next tick. */
  setStrength(strength: number): void {
    this.#maxBoostDb = maxBoostForStrength(strength);
  }

  /** Current manual gain (output volume × per-user volume, linear), so the
   *  boost budget can shrink as the user turns things up (§2.3). */
  setManualGain(manualGain: number): void {
    this.#manualGain = Number.isFinite(manualGain)
      ? Math.max(0, manualGain)
      : 1;
  }

  #onMeter(rms: number): void {
    if (this.#disposed || typeof rms !== "number") return;

    const now = performance.now();
    // First message, and hidden-tab gaps, both get a sane dt.
    const dtMs = Math.min(
      500,
      Math.max(
        10,
        this.#lastMeterAt === undefined ? 50 : now - this.#lastMeterAt,
      ),
    );
    this.#lastMeterAt = now;

    const measuredDb = linearToDb(rms);
    this.#gate = nextGateState(this.#gate, measuredDb, dtMs);
    // Gate closed: HOLD the current gain. Adapting on silence boosts the
    // noise floor toward the target and turns pauses into hiss.
    if (!this.#gate.open) return;

    const budget = boostBudgetDb(this.#manualGain, this.#maxBoostDb);
    const desired = desiredGainDb(measuredDb, budget);
    const tau = smoothingTauS(this.#currentGainDb, desired);
    this.#currentGainDb = desired;
    // `#currentGainDb` stays in AGC domain; the limiter's fixed makeup gain
    // is compensated here, as a constant offset on the one param we write.
    this.#gain.gain.setTargetAtTime(
      dbToLinear(desired - NORMALIZER_LIMITER_MAKEUP_DB),
      this.#context.currentTime,
      tau,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    // Tell the processor to return false and die. Without this it runs on
    // the audio thread until the context closes — actively-processing
    // worklet nodes are exempt from GC, so a long call with churn strands
    // one near-no-op processor per toggle/reconnect/leave (battery).
    this.#meter.port.postMessage("stop");
    this.#meter.port.onmessage = null;
    this.#meter.port.close();
    this.#meter.disconnect();
    this.#gain.disconnect();
    this.#limiter.disconnect();
  }
}
