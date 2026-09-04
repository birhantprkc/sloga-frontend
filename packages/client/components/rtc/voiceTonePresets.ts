/**
 * Voice shaper: tone-shaping presets for the local microphone.
 *
 * A preset is a short chain of native Web Audio nodes — a few biquad EQ
 * stages, an optional compressor, and a trim gain — that the mic pipeline
 * (`voiceAudioPipeline.ts`) inserts between the noise filter and the input
 * gain. Everything here is pure data plus small helpers so the presets can
 * be specified and checked without an AudioContext; the only DOM-touching
 * function is `createToneStage`, which takes the context as an argument.
 *
 * Exactly ONE preset is active at a time. LiveKit gives a track a single
 * processor slot, and the pipeline owns that slot for denoise + shaper +
 * gain together, so "one preset" is not a UI nicety — stacking two chains
 * would have to happen inside the same graph, and nothing here supports it.
 * `VoiceTonePresetId` is a closed union and the settings store rejects
 * anything outside it.
 *
 * Level matching: `DynamicsCompressorNode` applies a fixed spec-mandated
 * makeup gain (see `limiterMakeupDb` in audioNormalizer.ts), so a preset
 * with a compressor would read as "louder" for reasons unrelated to tone.
 * The trim node cancels that makeup and then applies the preset's own
 * designed `trimDb`, so switching presets changes character, not volume.
 */
import { dbToLinear, limiterMakeupDb } from "./audioNormalizer.ts";

export const VOICE_TONE_PRESET_IDS = [
  "off",
  "warm",
  "bright",
  "deep",
  "radio",
  "podcast",
] as const;

export type VoiceTonePresetId = (typeof VOICE_TONE_PRESET_IDS)[number];

export const VOICE_TONE_PRESET_DEFAULT: VoiceTonePresetId = "off";

export function isVoiceTonePresetId(
  value: unknown,
): value is VoiceTonePresetId {
  return (
    typeof value === "string" &&
    (VOICE_TONE_PRESET_IDS as readonly string[]).includes(value)
  );
}

/** One biquad stage. `gainDb` only applies to the shelf and peaking types. */
export interface ToneEqStage {
  type: BiquadFilterType;
  frequencyHz: number;
  q?: number;
  gainDb?: number;
}

export interface ToneCompressor {
  thresholdDb: number;
  ratio: number;
  kneeDb: number;
  attackS: number;
  releaseS: number;
}

export interface VoiceTonePreset {
  id: VoiceTonePresetId;
  eq: readonly ToneEqStage[];
  compressor?: ToneCompressor;
  /** Designed level offset after the compressor's makeup is cancelled. */
  trimDb: number;
}

/** Sanity bounds the specs pin every preset to (Web Audio param ranges,
 *  narrowed to what a voice preset has any business using). */
export const TONE_EQ_MIN_HZ = 20;
export const TONE_EQ_MAX_HZ = 20000;
export const TONE_EQ_MAX_ABS_GAIN_DB = 12;
export const TONE_TRIM_MAX_ABS_DB = 6;

const PRESETS: { readonly [K in VoiceTonePresetId]: VoiceTonePreset } = {
  off: { id: "off", eq: [], trimDb: 0 },

  // Rounder low end, a touch less edge. Softens thin headset mics.
  warm: {
    id: "warm",
    eq: [
      { type: "lowshelf", frequencyHz: 200, gainDb: 3 },
      { type: "peaking", frequencyHz: 3000, q: 1, gainDb: -2 },
      { type: "highshelf", frequencyHz: 8000, gainDb: -1.5 },
    ],
    trimDb: 0,
  },

  // Cuts rumble, lifts presence and air. Helps a muffled or boomy mic.
  bright: {
    id: "bright",
    eq: [
      { type: "highpass", frequencyHz: 90, q: 0.7 },
      { type: "peaking", frequencyHz: 3500, q: 1.2, gainDb: 3 },
      { type: "highshelf", frequencyHz: 8000, gainDb: 2.5 },
    ],
    trimDb: -1,
  },

  // Fuller chest tone and a rolled-off top.
  deep: {
    id: "deep",
    eq: [
      { type: "peaking", frequencyHz: 120, q: 1, gainDb: 2 },
      { type: "lowshelf", frequencyHz: 180, gainDb: 5 },
      { type: "highshelf", frequencyHz: 6000, gainDb: -2 },
    ],
    trimDb: -2,
  },

  // Narrow band, squashed hard: the walkie-talkie / dispatch sound.
  radio: {
    id: "radio",
    eq: [
      { type: "highpass", frequencyHz: 300, q: 0.9 },
      { type: "lowpass", frequencyHz: 3400, q: 0.9 },
      { type: "peaking", frequencyHz: 1800, q: 1.5, gainDb: 4 },
    ],
    compressor: {
      thresholdDb: -24,
      ratio: 6,
      kneeDb: 6,
      attackS: 0.005,
      releaseS: 0.15,
    },
    trimDb: 2,
  },

  // Broadcast polish: clear the mud, add presence, even out the dynamics.
  podcast: {
    id: "podcast",
    eq: [
      { type: "highpass", frequencyHz: 80, q: 0.7 },
      { type: "peaking", frequencyHz: 250, q: 1, gainDb: -2 },
      { type: "peaking", frequencyHz: 4000, q: 1.2, gainDb: 2.5 },
      { type: "highshelf", frequencyHz: 10000, gainDb: 1.5 },
    ],
    compressor: {
      thresholdDb: -20,
      ratio: 3,
      kneeDb: 10,
      attackS: 0.01,
      releaseS: 0.2,
    },
    trimDb: 3,
  },
};

export function voiceTonePreset(id: VoiceTonePresetId): VoiceTonePreset {
  return PRESETS[id];
}

/** Makeup gain the compressor will silently add (0 when there is none). */
export function toneCompressorMakeupDb(preset: VoiceTonePreset): number {
  const c = preset.compressor;
  return c ? limiterMakeupDb(c.thresholdDb, c.ratio) : 0;
}

/** Linear gain for the preset's trim node: cancel the compressor's makeup,
 *  then apply the designed trim. */
export function toneTrimLinear(preset: VoiceTonePreset): number {
  return dbToLinear(preset.trimDb - toneCompressorMakeupDb(preset));
}

/** True when the preset would change the signal at all. `off` has no
 *  nodes, so the pipeline wires straight past it and pays nothing. */
export function toneStageIsActive(preset: VoiceTonePreset): boolean {
  return preset.eq.length > 0 || !!preset.compressor || preset.trimDb !== 0;
}

/**
 * The minimal AudioContext surface the stage builder needs. Narrowed so the
 * specs can hand in a fake and check the graph without a browser.
 */
export interface ToneStageContext {
  createBiquadFilter(): BiquadFilterNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
  createGain(): GainNode;
}

/**
 * Build the preset's nodes, in signal order, UNCONNECTED. The caller chains
 * them (`connectChain`) because it also owns the neighbours on either side.
 * Returns an empty list for `off`.
 */
export function createToneStage(
  ctx: ToneStageContext,
  preset: VoiceTonePreset,
): AudioNode[] {
  if (!toneStageIsActive(preset)) return [];
  const nodes: AudioNode[] = [];
  for (const stage of preset.eq) {
    const node = ctx.createBiquadFilter();
    node.type = stage.type;
    node.frequency.value = stage.frequencyHz;
    if (stage.q !== undefined) node.Q.value = stage.q;
    if (stage.gainDb !== undefined) node.gain.value = stage.gainDb;
    nodes.push(node);
  }
  const c = preset.compressor;
  if (c) {
    const node = ctx.createDynamicsCompressor();
    node.threshold.value = c.thresholdDb;
    node.ratio.value = c.ratio;
    node.knee.value = c.kneeDb;
    node.attack.value = c.attackS;
    node.release.value = c.releaseS;
    nodes.push(node);
  }
  const trim = ctx.createGain();
  trim.gain.value = toneTrimLinear(preset);
  nodes.push(trim);
  return nodes;
}

/**
 * Connect `head → nodes[0] → … → nodes[n-1] → tail` and return the last node
 * before `tail` (so a caller can keep chaining). With no nodes, `head` is
 * connected straight to `tail`.
 */
export function connectChain(
  head: AudioNode,
  nodes: readonly AudioNode[],
  tail: AudioNode,
): AudioNode {
  let cursor = head;
  for (const node of nodes) {
    cursor.connect(node);
    cursor = node;
  }
  cursor.connect(tail);
  return cursor;
}
