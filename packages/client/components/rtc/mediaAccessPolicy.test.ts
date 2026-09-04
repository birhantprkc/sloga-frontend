// Unit spec for the media-access policy — run with Node's built-in runner:
//   node --test components/rtc/mediaAccessPolicy.test.ts   (Node >=23.6 strips types)
// Focus: an empty-looking device picker must say WHY it is empty, and the
// capture errors that mean "blocked" are told apart from "no such device".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deviceListVerdict,
  isPermissionDeniedError,
  permissionNameFor,
} from "./mediaAccessPolicy.ts";

const placeholder = { deviceId: "" };
const real = { deviceId: "abc123" };

test("a selectable device wins over every permission signal", () => {
  for (const permission of ["granted", "denied", "prompt", "unknown"] as const)
    assert.equal(
      deviceListVerdict({ devices: [placeholder, real], permission }),
      "ok",
      permission,
    );
});

test("placeholders under a denied permission read as denied", () => {
  // The original bug: pre-permission enumeration yields rows with empty ids,
  // the pickers hide them, and the user sees nothing at all.
  assert.equal(
    deviceListVerdict({
      devices: [placeholder, placeholder],
      permission: "denied",
    }),
    "denied",
  );
  assert.equal(
    deviceListVerdict({ devices: [], permission: "denied" }),
    "denied",
  );
});

test("placeholders before the prompt, or where the API cannot answer, ask for permission", () => {
  assert.equal(
    deviceListVerdict({ devices: [placeholder], permission: "prompt" }),
    "needs-permission",
  );
  assert.equal(
    deviceListVerdict({ devices: [placeholder], permission: "unknown" }),
    "needs-permission",
  );
  // No devices AND no answer from the API: still not a hardware verdict —
  // Firefox lists nothing before its prompt.
  assert.equal(
    deviceListVerdict({ devices: [], permission: "unknown" }),
    "needs-permission",
  );
});

test("granted and still empty means no hardware", () => {
  assert.equal(
    deviceListVerdict({ devices: [], permission: "granted" }),
    "none",
  );
  assert.equal(
    deviceListVerdict({ devices: [placeholder], permission: "granted" }),
    "none",
  );
});

test("output devices are gated by the microphone permission", () => {
  assert.equal(permissionNameFor("audioinput"), "microphone");
  assert.equal(permissionNameFor("audiooutput"), "microphone");
  assert.equal(permissionNameFor("videoinput"), "camera");
});

test("blocked-access errors are recognised by name, nothing else is", () => {
  assert.equal(isPermissionDeniedError({ name: "NotAllowedError" }), true);
  assert.equal(
    isPermissionDeniedError({ name: "PermissionDeniedError" }),
    true,
  );
  // "No such device" and constraint failures must keep their own handling.
  assert.equal(isPermissionDeniedError({ name: "NotFoundError" }), false);
  assert.equal(
    isPermissionDeniedError({ name: "OverconstrainedError" }),
    false,
  );
  assert.equal(isPermissionDeniedError(new Error("boom")), false);
  assert.equal(isPermissionDeniedError(undefined), false);
  assert.equal(isPermissionDeniedError(null), false);
  assert.equal(isPermissionDeniedError("NotAllowedError"), false);
});
