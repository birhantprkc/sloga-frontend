/**
 * Pure decisions for the Android screen-leg START path (screen-leg plan §7.2).
 *
 * Split out of `state.tsx` for the same reason as `mlsRosterPolicy` and
 * `mlsCallModePolicy`: the interesting cases here are races around two
 * USER-PACED dialogs (the tier sheet and the OS consent prompt), and they are
 * untestable while the decision lives inside a class that needs a live Room, a
 * client and a native bridge to construct.
 *
 * The rule both functions serve: a start attempt owns the leg only until
 * something else claims it. Until `connect()` resolves the leg is not
 * `active()`, so the §7.4 stop hooks cannot see it — which is precisely why
 * the attempt has to keep checking whether it is still the current one.
 */

/** A leg send key as it crosses the bridge — §5.2 minus the epoch. */
export interface LegSendKey {
  keyB64: string;
  keyIndex: number;
}

export interface StartAttemptWorld {
  /** Generation this attempt claimed when it began. */
  generation: number;
  /** Generation now — bumped by every stop hook and every competing start. */
  currentGeneration: number;
  /** Whether the call room differs from the one the attempt started in. */
  roomChanged: boolean;
  /** Publish-gate reasons currently held; publishing flows only at zero. */
  publishGateSize: number;
}

/**
 * Has the world moved out from under this start attempt?
 *
 * TRUE means abandon — and, once `connect()` has resolved, TEAR DOWN rather
 * than merely return: past that point the OS is capturing and the leg is
 * publishing, so "give up quietly" is how a share outlives its own call.
 */
export function startAttemptStale(world: StartAttemptWorld): boolean {
  return (
    world.generation !== world.currentGeneration ||
    world.roomChanged ||
    world.publishGateSize > 0
  );
}

/**
 * The key the leg must be re-keyed to immediately after `connect()`, or
 * undefined when it is already on the right one.
 *
 * A rotation that lands while `connect()` is in flight reaches
 * `onLocalScreenKey` when the leg is not yet `active()`, and is dropped there.
 * The provider's `lastLocalScreenKey` is the authoritative record of "what key
 * should the leg be using now", so the attempt reconciles against it once the
 * sender exists.
 *
 * Compares the MATERIAL as well as the index: an index is only unique within
 * an epoch, so two epochs can legitimately reuse one and comparing indices
 * alone would silently skip a required rotation.
 */
export function keyToPushAfterConnect(
  connectedWith: LegSendKey | undefined,
  current: LegSendKey | undefined,
): LegSendKey | undefined {
  // A plaintext leg has no send key and must not acquire one here: handing it
  // a key would be a silent, unannounced upgrade the rest of the call has not
  // agreed to.
  if (!connectedWith) return undefined;
  // No current key means the provider has nothing better to offer; the
  // rotation listener owns the fail-closed path if one arrives later.
  if (!current) return undefined;
  if (
    current.keyIndex === connectedWith.keyIndex &&
    current.keyB64 === connectedWith.keyB64
  )
    return undefined;
  return current;
}
