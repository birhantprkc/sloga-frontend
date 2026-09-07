/**
 * Local publication encryption — the PURE decision core for the send-side
 * counterpart of `plaintextCryptorPolicy`: which of OUR OWN publications the
 * SFU has on record as something other than GCM after E2EE was enabled, so
 * the session can re-declare them and the chip can refuse to read green
 * until it has. Dependency-free so `node --test` can load it (the house
 * no-vitest split; extensionless imports do not resolve there, which is why
 * the enum literals are mirrored rather than imported).
 *
 * Why this exists: livekit stamps `AddTrackRequest.encryption` from
 * `LocalParticipant.encryptionType` at the moment the request is BUILT, then
 * awaits the SFU's answer before it registers the publication, and
 * `setE2EEEnabled(true)` republishes only the publications that are
 * registered when it runs. A publish still in flight at that moment — the
 * microphone that `connect()` enables before the MLS session even exists —
 * lands AFTER the enable, declared NONE, and nothing ever corrects it:
 * `encryptionType` is already GCM so no later publish trips the guard, and
 * the E2EE manager reports the local participant "encrypted" from the
 * worker's cryptor state, which says nothing about what the SFU was told.
 * The frames ARE encrypted (the sender transform attaches on publish), but
 * every receiver arms its cryptor from `trackInfo.encryption` — and the
 * plaintext disarm in RoomAudioManager, which exists to keep genuine
 * plaintext publishers audible, reads that NONE as authoritative and turns
 * the cryptor OFF for us. Ciphertext then hits their decoder unchanged:
 * zero loss, zero decoded samples, we are inaudible, while our chip reads
 * "Encrypted". Observed live 2026-09-06 for 40 minutes on the shipped
 * desktop 0.57.0: a solo group creator enables within a few hundred
 * milliseconds of `session.start()`, which is exactly the window the first
 * mic publish still needs on a cold shell.
 *
 * The verdict here is deliberately stricter than the remote policy's: a
 * remote publication with `undefined` is treated as "info may lag" there,
 * but a LOCAL publication's `trackInfo` is the SFU's answer to our own
 * request, present from the moment the publication exists. Anything that is
 * not an explicit GCM is therefore a declaration we cannot vouch for, and
 * the session re-declares it rather than trusting it.
 */

/**
 * `Encryption_Type.NONE` / `Encryption_Type.GCM` from @livekit/protocol,
 * mirrored as literals (pnpm's isolated layout keeps the transitive package
 * unresolvable under bare `node --test`; `plaintextCryptorPolicy.ts` mirrors
 * NONE the same way and its test pins the value). Proto3 pins both on the
 * wire; a change would be a breaking protocol rewrite, not a version bump.
 */
export const ENCRYPTION_TYPE_NONE = 0;
export const ENCRYPTION_TYPE_GCM = 1;

export interface LocalPublicationEncryption {
  /** The SFU-assigned publication sid (`LocalTrackPublication.trackSid`). */
  trackSid: string;
  /** `Track.Source` of the publication, for logging only. */
  source?: string;
  /**
   * `publication.trackInfo?.encryption` exactly as the SFU answered our
   * AddTrack — the value every receiver arms its cryptor from.
   */
  encryption: number | undefined;
}

/**
 * The sids of local publications the SFU does NOT have on record as GCM, in
 * publication order. Only meaningful once LiveKit E2EE mode is ON for the
 * Room — before that every local publication is legitimately NONE (the
 * plaintext-until-first-key window, publishing paused by the negotiating
 * gate). An explicit NONE, any other non-GCM type, and a missing field all
 * count: the session's remedy is a republish, which is harmless when the
 * declaration was merely late and essential when it was wrong.
 */
export function unencryptedLocalPublications(
  publications: readonly LocalPublicationEncryption[],
): string[] {
  const plain: string[] = [];
  for (const pub of publications) {
    if (pub.encryption !== ENCRYPTION_TYPE_GCM) plain.push(pub.trackSid);
  }
  return plain;
}

/** Chip input: every local publication is on record as GCM (vacuous if none). */
export function localPublicationsEncrypted(
  publications: readonly LocalPublicationEncryption[],
): boolean {
  return unencryptedLocalPublications(publications).length === 0;
}
