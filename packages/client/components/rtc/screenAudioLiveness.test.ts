// Unit spec for the screen-audio device watchdog rule — run with Node's
// built-in runner:
//   node --test components/rtc/screenAudioLiveness.test.ts   (Node >=23.6 strips types)
// Focus: the device-gone check must trip when the matched input vanishes,
// stay quiet while it is present, and never trip on a blank label.
import assert from "node:assert/strict";
import { test } from "node:test";

import { screenAudioDeviceGone } from "./screenAudioLiveness.ts";

const SLOGA = "Sloga Screen Audio (14338)";
const MIC = "Built-in Audio Analog Stereo";

test("quiet while the matched input is still enumerated", () => {
  const devices = [
    { kind: "audioinput", label: MIC },
    { kind: "audioinput", label: SLOGA },
    { kind: "audiooutput", label: "HDMI" },
  ];
  assert.equal(screenAudioDeviceGone(devices, SLOGA), false);
});

test("trips when the matched input has vanished", () => {
  // The field shape: only the microphone left, the virtual source gone.
  const devices = [
    { kind: "audioinput", label: MIC },
    { kind: "audiooutput", label: "HDMI" },
  ];
  assert.equal(screenAudioDeviceGone(devices, SLOGA), true);
});

test("an output with the same label does not count as the input", () => {
  const devices = [{ kind: "audiooutput", label: SLOGA }];
  assert.equal(screenAudioDeviceGone(devices, SLOGA), true);
});

test("exact label only — a suffix mismatch is a vanished device", () => {
  const devices = [{ kind: "audioinput", label: `${SLOGA} (2)` }];
  assert.equal(screenAudioDeviceGone(devices, SLOGA), true);
});

test("a blank label never trips the watchdog", () => {
  assert.equal(screenAudioDeviceGone([], ""), false);
  assert.equal(
    screenAudioDeviceGone([{ kind: "audioinput", label: MIC }], ""),
    false,
  );
});

test("an empty enumeration with a real label is a vanished device", () => {
  assert.equal(screenAudioDeviceGone([], SLOGA), true);
});
