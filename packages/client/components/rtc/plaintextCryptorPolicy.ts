/**
 * Plaintext cryptor disarm — the PURE decision core for keeping livekit's
 * frame cryptor OFF a participant who is publishing plaintext, extracted so
 * `node --test` can load it (the house no-vitest split; this module must stay
 * dependency-free).
 *
 * Why this exists: the Room is deliberately constructed E2EE-capable even for
 * calls that negotiate plaintext (`setE2EEEnabled()` throws if the `e2ee`
 * option was omitted at construction — see the connect() comment in
 * state.tsx). That capability is NOT inert on the receive path: livekit
 * installs its decode transform on EVERY subscribed remote track (its
 * `setupE2EEReceiver` checks neither `trackInfo.encryption` nor whether E2EE
 * was ever enabled), and arms the per-participant cryptor from
 * `trackInfo.encryption !== Encryption_Type.NONE` — a comparison that reads a
 * MISSING field (`undefined !== 0`) as "encrypted". An armed cryptor fed
 * plaintext destroys every frame with no error and no event (the worker's
 * decode path returns without enqueueing when no key exists at the frame's
 * claimed key index): packets arrive with zero loss, zero samples decode,
 * `concealedSamples` climbs, the peer is inaudible. Measured live 2026-08-30 —
 * a Windows desktop unable to hear a Linux/Electron peer, whose calls are
 * plaintext by design (`platformMediaE2EESupported()` is false there).
 *
 * Rather than depending on WHICH of livekit's two guards misfires, the app
 * asserts the state it already knows: any remote participant whose
 * publications declare plaintext gets their cryptor explicitly disarmed. The
 * caller must RE-assert on every sweep — livekit re-arms from its own
 * TrackPublished handler and its ConnectionStateChanged→Connected sweep, so a
 * disarm-once would quietly lose to the next one of those.
 */

/**
 * `Encryption_Type.NONE` from @livekit/protocol, mirrored as a literal so this
 * module stays loadable under bare `node --test` (pnpm's isolated layout
 * keeps the transitive package unresolvable there, so the real enum CANNOT be
 * imported for a drift pin). The literal is safe regardless: proto3 pins
 * NONE = 0 on the wire forever — changing it would be a breaking protocol
 * rewrite, not a version bump.
 */
export const ENCRYPTION_TYPE_NONE = 0;

export interface RemotePublicationEncryption {
  /** SFU identity (device-qualified) of the participant that published. */
  participantIdentity: string;
  /**
   * `publication.trackInfo?.encryption` exactly as the server delivered it;
   * `undefined` when the publication metadata has not carried the field —
   * which is precisely the value livekit's own arming rule misreads.
   */
  encryption: number | undefined;
}

/**
 * The identities whose cryptor must be forced OFF, in first-seen order.
 *
 * A participant qualifies when at least one of their publications EXPLICITLY
 * declares `NONE` and none declares an encrypted type:
 *
 * - An explicit `NONE` is authoritative plaintext — the exact value measured
 *   on the silent Linux peer's publication.
 * - Any explicitly encrypted publication vetoes the whole participant:
 *   disarming there would feed ciphertext straight to the decoder on a real
 *   E2EE call. Never fight livekit over a participant it armed CORRECTLY.
 * - `undefined` alone is no evidence either way — on a genuinely encrypted
 *   call the info can lag the publication, so it must never trigger a disarm;
 *   it merely fails to veto one when a sibling publication declares `NONE`.
 */
export function cryptorDisarmIdentities(
  publications: readonly RemotePublicationEncryption[],
): string[] {
  const evidence = new Map<
    string,
    { plaintext: boolean; encrypted: boolean }
  >();
  for (const pub of publications) {
    let entry = evidence.get(pub.participantIdentity);
    if (!entry) {
      entry = { plaintext: false, encrypted: false };
      evidence.set(pub.participantIdentity, entry);
    }
    if (pub.encryption === ENCRYPTION_TYPE_NONE) entry.plaintext = true;
    else if (pub.encryption !== undefined) entry.encrypted = true;
  }
  const disarm: string[] = [];
  for (const [identity, entry] of evidence) {
    if (entry.plaintext && !entry.encrypted) disarm.push(identity);
  }
  return disarm;
}

/** A bound `setParticipantCryptorEnabled` — call with (enabled, identity). */
export type CryptorControl = (
  enabled: boolean,
  participantIdentity: string,
) => void;

/** Where a disarm call can land on this Room, or why it can't. */
export type CryptorControlProbe =
  /** The @internal surface is present; `control` is bound to the manager. */
  | { kind: "control"; control: CryptorControl }
  /**
   * No `e2eeManager` on the Room — it was built without the `e2ee` option, so
   * no transform was ever installed and there is nothing to disarm. Silent
   * no-op for the caller.
   */
  | { kind: "no-manager" }
  /**
   * A manager EXISTS (so transforms are being installed) but the setter is
   * gone — an SDK bump removed/renamed the @internal surface. The caller must
   * warn loudly: plaintext peers may be inaudible and we can no longer
   * correct it.
   */
  | { kind: "unsupported" };

/**
 * Duck-type livekit's E2EE manager off a Room-shaped object. Both
 * `room.e2eeManager` (private in the typings) and
 * `setParticipantCryptorEnabled` (@internal) are unsupported surfaces, so
 * probe at runtime instead of trusting a cast — the same posture as the
 * `setWebAudioPlugins` fail-safe in RoomAudioManager.
 */
export function resolveCryptorControl(room: unknown): CryptorControlProbe {
  if (typeof room !== "object" || room === null) return { kind: "no-manager" };
  const manager = (room as { e2eeManager?: unknown }).e2eeManager;
  if (typeof manager !== "object" || manager === null)
    return { kind: "no-manager" };
  const setter = (
    manager as { setParticipantCryptorEnabled?: unknown }
  ).setParticipantCryptorEnabled;
  if (typeof setter !== "function") return { kind: "unsupported" };
  return {
    kind: "control",
    control: (enabled, participantIdentity) =>
      (setter as CryptorControl).call(manager, enabled, participantIdentity),
  };
}
