/**
 * Specs for the voice shaper presets and the graph they build.
 *
 * Run with:
 *   node --conditions=browser --test components/rtc/voiceTonePresets.test.ts
 *
 * The graph checks run against a fake AudioContext: every node records what
 * it was connected to, so the specs can assert signal order and parameter
 * values without a browser.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { dbToLinear, limiterMakeupDb } from "./audioNormalizer.ts";
import {
  TONE_EQ_MAX_ABS_GAIN_DB,
  TONE_EQ_MAX_HZ,
  TONE_EQ_MIN_HZ,
  TONE_TRIM_MAX_ABS_DB,
  VOICE_TONE_PRESET_DEFAULT,
  VOICE_TONE_PRESET_IDS,
  connectChain,
  createToneStage,
  isVoiceTonePresetId,
  toneCompressorMakeupDb,
  toneStageIsActive,
  toneTrimLinear,
  voiceTonePreset,
} from "./voiceTonePresets.ts";

// ---------------------------------------------------------------- fakes --

class FakeParam {
  value = 0;
}

class FakeNode {
  readonly kind: string;
  readonly outputs: FakeNode[] = [];
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(target: FakeNode) {
    this.outputs.push(target);
    return target;
  }
  disconnect() {
    this.outputs.length = 0;
  }
}

class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency = new FakeParam();
  Q = new FakeParam();
  gain = new FakeParam();
  constructor() {
    super("biquad");
  }
}

class FakeCompressor extends FakeNode {
  threshold = new FakeParam();
  ratio = new FakeParam();
  knee = new FakeParam();
  attack = new FakeParam();
  release = new FakeParam();
  constructor() {
    super("compressor");
  }
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
  constructor() {
    super("gain");
  }
}

function fakeContext() {
  const created: FakeNode[] = [];
  const track = <T extends FakeNode>(n: T) => (created.push(n), n);
  return {
    created,
    createBiquadFilter: () =>
      track(new FakeBiquad()) as unknown as BiquadFilterNode,
    createDynamicsCompressor: () =>
      track(new FakeCompressor()) as unknown as DynamicsCompressorNode,
    createGain: () => track(new FakeGain()) as unknown as GainNode,
  };
}

/** Walk `from` along single outputs until `to`; returns the path of kinds. */
function pathKinds(from: FakeNode, to: FakeNode): string[] {
  const kinds: string[] = [];
  let cursor = from;
  for (let hops = 0; hops < 32; hops++) {
    if (cursor === to) return kinds;
    assert.equal(
      cursor.outputs.length,
      1,
      `${cursor.kind} must have one output`,
    );
    cursor = cursor.outputs[0];
    kinds.push(cursor.kind);
  }
  assert.fail("chain never reached its tail");
}

// -------------------------------------------------------------- catalog --

describe("preset catalog", () => {
  test("ids are unique, 'off' is first and is the default", () => {
    assert.equal(
      new Set(VOICE_TONE_PRESET_IDS).size,
      VOICE_TONE_PRESET_IDS.length,
    );
    assert.equal(VOICE_TONE_PRESET_IDS[0], "off");
    assert.equal(VOICE_TONE_PRESET_DEFAULT, "off");
  });

  test("every id resolves to a preset carrying that id", () => {
    for (const id of VOICE_TONE_PRESET_IDS) {
      assert.equal(voiceTonePreset(id).id, id);
    }
  });

  test("isVoiceTonePresetId accepts the catalog and nothing else", () => {
    for (const id of VOICE_TONE_PRESET_IDS) assert.ok(isVoiceTonePresetId(id));
    for (const bad of ["", "OFF", "warm ", "chipmunk", 1, null, undefined, {}])
      assert.equal(isVoiceTonePresetId(bad), false, String(bad));
  });

  test("'off' is a true no-op and every other preset does something", () => {
    assert.equal(toneStageIsActive(voiceTonePreset("off")), false);
    for (const id of VOICE_TONE_PRESET_IDS) {
      if (id === "off") continue;
      assert.ok(toneStageIsActive(voiceTonePreset(id)), id);
    }
  });

  test("every stage sits inside the voice-preset bounds", () => {
    for (const id of VOICE_TONE_PRESET_IDS) {
      const preset = voiceTonePreset(id);
      for (const stage of preset.eq) {
        assert.ok(
          stage.frequencyHz >= TONE_EQ_MIN_HZ &&
            stage.frequencyHz <= TONE_EQ_MAX_HZ,
          `${id} ${stage.type} frequency`,
        );
        if (stage.q !== undefined)
          assert.ok(stage.q > 0, `${id} ${stage.type} Q`);
        if (stage.gainDb !== undefined) {
          assert.ok(
            Math.abs(stage.gainDb) <= TONE_EQ_MAX_ABS_GAIN_DB,
            `${id} gain`,
          );
          // gain only has meaning on shelf/peaking; a pass filter with a
          // gain is a spec typo.
          assert.ok(
            ["lowshelf", "highshelf", "peaking"].includes(stage.type),
            `${id} ${stage.type} carries a gain`,
          );
        }
      }
      const c = preset.compressor;
      if (c) {
        assert.ok(
          c.thresholdDb >= -100 && c.thresholdDb <= 0,
          `${id} threshold`,
        );
        assert.ok(c.ratio >= 1 && c.ratio <= 20, `${id} ratio`);
        assert.ok(c.kneeDb >= 0 && c.kneeDb <= 40, `${id} knee`);
        assert.ok(c.attackS >= 0 && c.attackS <= 1, `${id} attack`);
        assert.ok(c.releaseS >= 0 && c.releaseS <= 1, `${id} release`);
      }
      assert.ok(Math.abs(preset.trimDb) <= TONE_TRIM_MAX_ABS_DB, `${id} trim`);
    }
  });
});

// ---------------------------------------------------------- level match --

describe("level matching", () => {
  test("presets without a compressor have no makeup to cancel", () => {
    for (const id of ["off", "warm", "bright", "deep"] as const) {
      assert.equal(toneCompressorMakeupDb(voiceTonePreset(id)), 0);
      assert.equal(
        toneTrimLinear(voiceTonePreset(id)),
        dbToLinear(voiceTonePreset(id).trimDb),
      );
    }
  });

  test("a compressor's spec makeup is cancelled before the designed trim", () => {
    for (const id of ["radio", "podcast"] as const) {
      const preset = voiceTonePreset(id);
      const c = preset.compressor!;
      const makeup = limiterMakeupDb(c.thresholdDb, c.ratio);
      assert.ok(makeup > 0, `${id} makeup should be positive`);
      assert.equal(toneCompressorMakeupDb(preset), makeup);
      assert.equal(toneTrimLinear(preset), dbToLinear(preset.trimDb - makeup));
    }
  });

  test("no preset nets more than the trim ceiling after makeup", () => {
    for (const id of VOICE_TONE_PRESET_IDS) {
      const preset = voiceTonePreset(id);
      const netDb = preset.trimDb; // makeup is cancelled exactly
      assert.ok(Math.abs(netDb) <= TONE_TRIM_MAX_ABS_DB, id);
    }
  });
});

// ------------------------------------------------------------- the graph --

describe("createToneStage", () => {
  test("'off' builds nothing", () => {
    const ctx = fakeContext();
    assert.deepEqual(createToneStage(ctx, voiceTonePreset("off")), []);
    assert.equal(ctx.created.length, 0);
  });

  test("EQ-only preset: biquads in catalog order, then the trim gain", () => {
    const ctx = fakeContext();
    const preset = voiceTonePreset("warm");
    const nodes = createToneStage(ctx, preset) as unknown as FakeNode[];
    assert.deepEqual(
      nodes.map((n) => n.kind),
      [...preset.eq.map(() => "biquad"), "gain"],
    );
    preset.eq.forEach((stage, i) => {
      const node = nodes[i] as unknown as FakeBiquad;
      assert.equal(node.type, stage.type);
      assert.equal(node.frequency.value, stage.frequencyHz);
      if (stage.q !== undefined) assert.equal(node.Q.value, stage.q);
      if (stage.gainDb !== undefined)
        assert.equal(node.gain.value, stage.gainDb);
    });
    const trim = nodes.at(-1) as unknown as FakeGain;
    assert.equal(trim.gain.value, toneTrimLinear(preset));
  });

  test("compressor preset: EQ, then compressor, then trim, params applied", () => {
    const ctx = fakeContext();
    const preset = voiceTonePreset("podcast");
    const nodes = createToneStage(ctx, preset) as unknown as FakeNode[];
    assert.deepEqual(
      nodes.map((n) => n.kind),
      [...preset.eq.map(() => "biquad"), "compressor", "gain"],
    );
    const comp = nodes.at(-2) as unknown as FakeCompressor;
    const c = preset.compressor!;
    assert.equal(comp.threshold.value, c.thresholdDb);
    assert.equal(comp.ratio.value, c.ratio);
    assert.equal(comp.knee.value, c.kneeDb);
    assert.equal(comp.attack.value, c.attackS);
    assert.equal(comp.release.value, c.releaseS);
    const trim = nodes.at(-1) as unknown as FakeGain;
    assert.equal(trim.gain.value, toneTrimLinear(preset));
  });

  test("nodes come back unconnected — the caller owns the wiring", () => {
    const ctx = fakeContext();
    const nodes = createToneStage(
      ctx,
      voiceTonePreset("radio"),
    ) as unknown as FakeNode[];
    for (const n of nodes) assert.equal(n.outputs.length, 0);
  });
});

describe("connectChain", () => {
  test("no nodes: head goes straight to tail and head is returned", () => {
    const head = new FakeNode("head");
    const tail = new FakeNode("tail");
    const last = connectChain(
      head as unknown as AudioNode,
      [],
      tail as unknown as AudioNode,
    );
    assert.equal(last, head as unknown as AudioNode);
    assert.deepEqual(pathKinds(head, tail), ["tail"]);
  });

  test("a full preset threads head → stage → tail in order", () => {
    const ctx = fakeContext();
    const head = new FakeNode("head");
    const tail = new FakeNode("tail");
    const nodes = createToneStage(ctx, voiceTonePreset("radio"));
    const last = connectChain(
      head as unknown as AudioNode,
      nodes,
      tail as unknown as AudioNode,
    );
    assert.equal(last, nodes.at(-1));
    assert.deepEqual(pathKinds(head, tail), [
      "biquad",
      "biquad",
      "biquad",
      "compressor",
      "gain",
      "tail",
    ]);
  });

  test("swapping presets: the old stage is fully detached, only one chain remains", () => {
    // Mirrors what the pipeline does on setTonePreset: disconnect the old
    // nodes, build the new ones, rewire. A stale connection here would mean
    // two shapers running in parallel — exactly what the single-slot rule
    // forbids.
    const ctx = fakeContext();
    const head = new FakeNode("head");
    const tail = new FakeNode("tail");
    const first = createToneStage(ctx, voiceTonePreset("deep"));
    connectChain(
      head as unknown as AudioNode,
      first,
      tail as unknown as AudioNode,
    );

    head.disconnect();
    for (const n of first) n.disconnect();
    const second = createToneStage(ctx, voiceTonePreset("bright"));
    connectChain(
      head as unknown as AudioNode,
      second,
      tail as unknown as AudioNode,
    );

    for (const n of first as unknown as FakeNode[])
      assert.equal(n.outputs.length, 0);
    assert.equal(head.outputs.length, 1);
    assert.deepEqual(pathKinds(head, tail), [
      "biquad",
      "biquad",
      "biquad",
      "gain",
      "tail",
    ]);
  });
});
