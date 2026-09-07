// Unit spec for the local publication encryption verdict (the "Encrypted"
// chip over a NONE-declared microphone, 2026-09-06).
//   node --test components/rtc/localPublicationEncryption.test.ts   (Node >=23.6 strips types)
// Focus: only an explicit GCM passes; NONE, an unknown type and a missing
// field all name the publication; and the livekit ordering that produces
// the defect — encryption stamped when the request is built, publication
// registered when the SFU answers, republish covering only what is
// registered — is modeled end to end so the verdict is checked against the
// exact shape the live log showed.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type LocalPublicationEncryption,
  ENCRYPTION_TYPE_GCM,
  ENCRYPTION_TYPE_NONE,
  localPublicationsEncrypted,
  unencryptedLocalPublications,
} from "./localPublicationEncryption.ts";

const pub = (
  trackSid: string,
  encryption: number | undefined,
  source = "microphone",
): LocalPublicationEncryption => ({ trackSid, source, encryption });

// ---- Enum pins -------------------------------------------------------------

test("the mirrored enum values match @livekit/protocol (NONE=0, GCM=1)", () => {
  assert.equal(ENCRYPTION_TYPE_NONE, 0);
  assert.equal(ENCRYPTION_TYPE_GCM, 1);
});

// ---- unencryptedLocalPublications -----------------------------------------

test("an explicit GCM declaration passes", () => {
  assert.deepEqual(unencryptedLocalPublications([pub("TR_a", 1)]), []);
  assert.equal(localPublicationsEncrypted([pub("TR_a", 1)]), true);
});

test("an explicit NONE names the publication", () => {
  assert.deepEqual(unencryptedLocalPublications([pub("TR_mic", 0)]), [
    "TR_mic",
  ]);
  assert.equal(localPublicationsEncrypted([pub("TR_mic", 0)]), false);
});

test("a missing field is NOT trusted for a local publication (fail-closed)", () => {
  // The remote policy tolerates `undefined` because info can lag; ours is
  // the SFU's answer to our own request and is present from the start.
  assert.deepEqual(unencryptedLocalPublications([pub("TR_mic", undefined)]), [
    "TR_mic",
  ]);
});

test("any non-GCM type names the publication", () => {
  // Encryption_Type.CUSTOM (2) — the app never sets it; a stray value must
  // still be re-declared rather than read as encrypted.
  assert.deepEqual(unencryptedLocalPublications([pub("TR_cam", 2)]), [
    "TR_cam",
  ]);
});

test("verdicts are per publication, in publication order", () => {
  assert.deepEqual(
    unencryptedLocalPublications([
      pub("TR_mic", 0),
      pub("TR_cam", 1, "camera"),
      pub("TR_screen", undefined, "screen_share"),
    ]),
    ["TR_mic", "TR_screen"],
  );
});

test("no publications ⇒ vacuously encrypted (everyone muted)", () => {
  assert.equal(localPublicationsEncrypted([]), true);
  assert.deepEqual(unencryptedLocalPublications([]), []);
});

// ---- The livekit ordering that produces the defect -------------------------
//
// A small model of livekit-client 2.15.13's LocalParticipant, faithful in
// the three properties that matter (read against the pinned source):
//  1. `publish()` builds AddTrackRequest with `encryption: this.encryptionType`
//     BEFORE awaiting the SFU, and registers the publication only AFTER the
//     answer (`addTrackPublication` follows `engine.addTrack`).
//  2. `setE2EEEnabled(true)` sets `encryptionType = GCM` then republishes
//     exactly the publications registered at that moment.
//  3. The SFU's TrackInfo echoes the request's encryption; a republish gets
//     a new sid.
// The model is not livekit — the session-level test the house split cannot
// run (extensionless imports) is the live two-account leg — but it pins the
// interleaving the fix must survive, so a future "why is this branch here"
// has a red test to answer it.

class ModelParticipant {
  encryptionType = ENCRYPTION_TYPE_NONE;
  publications = new Map<string, LocalPublicationEncryption>();
  #nextSid = 0;
  /** Requests the SFU has not answered yet. */
  #inFlight: Array<{ stamped: number; source: string; resolve: () => void }> =
    [];

  /** Property 1: stamp now, register when the SFU answers. */
  publish(source: string): Promise<void> {
    const stamped = this.encryptionType;
    return new Promise((resolve) => {
      this.#inFlight.push({ stamped, source, resolve });
    });
  }

  /** The SFU answers every outstanding request (property 3). */
  answerAll(): void {
    for (const req of this.#inFlight.splice(0)) {
      const trackSid = `TR_${this.#nextSid++}`;
      this.publications.set(trackSid, {
        trackSid,
        source: req.source,
        encryption: req.stamped,
      });
      req.resolve();
    }
  }

  /** Property 2: flip the type, republish what is registered. */
  async setE2EEEnabled(enabled: boolean): Promise<void> {
    this.encryptionType = enabled ? ENCRYPTION_TYPE_GCM : ENCRYPTION_TYPE_NONE;
    const registered = [...this.publications.values()];
    for (const old of registered) {
      this.publications.delete(old.trackSid);
      const pending = this.publish(old.source ?? "unknown");
      this.answerAll();
      await pending;
    }
  }

  snapshot(): LocalPublicationEncryption[] {
    return [...this.publications.values()];
  }
}

test("model: a publish answered BEFORE the enable is republished as GCM", async () => {
  const p = new ModelParticipant();
  const mic = p.publish("microphone");
  p.answerAll(); // the SFU answered first — the joiner-into-a-call shape
  await mic;
  await p.setE2EEEnabled(true);
  assert.deepEqual(unencryptedLocalPublications(p.snapshot()), []);
});

test("model: a publish still in flight at the enable lands as NONE and stays NONE", async () => {
  const p = new ModelParticipant();
  const mic = p.publish("microphone"); // connect() enables the mic first…
  await p.setE2EEEnabled(true); // …the solo creator enables ~300 ms later…
  p.answerAll(); // …then the SFU answers the mic request, stamped NONE.
  await mic;
  // encryptionType is GCM now, so no later publish notices; the register
  // step never re-reads the type. This is the 40-minute window.
  assert.equal(p.encryptionType, ENCRYPTION_TYPE_GCM);
  assert.deepEqual(unencryptedLocalPublications(p.snapshot()), ["TR_0"]);
  assert.equal(localPublicationsEncrypted(p.snapshot()), false);
});

test("model: the remedy — republish exactly the named sids — converges to GCM", async () => {
  const p = new ModelParticipant();
  const cam = p.publish("camera");
  p.answerAll();
  await cam;
  const mic = p.publish("microphone");
  await p.setE2EEEnabled(true); // camera republished GCM; mic in flight
  p.answerAll();
  await mic;
  const plain = unencryptedLocalPublications(p.snapshot());
  assert.deepEqual(
    p
      .snapshot()
      .filter((x) => plain.includes(x.trackSid))
      .map((x) => x.source),
    ["microphone"],
    "only the in-flight publication is named; the republished camera is not",
  );
  // What the session does with the verdict: unpublish + publish those sids
  // under the CURRENT type (GCM).
  for (const sid of plain) {
    const old = p.publications.get(sid)!;
    p.publications.delete(sid);
    const again = p.publish(old.source ?? "unknown");
    p.answerAll();
    await again;
  }
  assert.deepEqual(unencryptedLocalPublications(p.snapshot()), []);
  assert.equal(localPublicationsEncrypted(p.snapshot()), true);
});
