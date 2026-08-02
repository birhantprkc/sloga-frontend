/**
 * Visibility/interruption policy for the "play while you wait" call minigame
 * (Slogaball). Pure — no Solid, no DOM — so it runs under `node --test`
 * without the `--conditions=browser` dance the reactive files need:
 *   node --test components/ui/components/features/voice/minigame/minigamePolicy.test.ts
 *
 * The chip, the overlay and the lazy engine chunk all sit behind
 * `minigameChipVisible`, so the ENABLE_CALL_MINIGAME flag passed in here is
 * the single point that darkens the lot.
 */

/** Everything the chip-visibility rule reads, already unwrapped from signals. */
export interface MinigameVisibilityInputs {
  /** `CONFIGURATION.ENABLE_CALL_MINIGAME` — build-time gate, default off. */
  enabled: boolean;
  /** `voice.state() === "CONNECTED"`. */
  connected: boolean;
  /**
   * `channel.voiceParticipants.size` — the CHANNEL roster (WS-driven and
   * reactive; includes self once connected). NOT `room.remoteParticipants`,
   * which is not reactive and needs the store's version-bump workaround.
   */
  participants: number;
  /** Theater mode hides all chrome, and the game is chrome too. */
  immersive: boolean;
  /**
   * Something is focused — a share or camera worth watching. That is not
   * "waiting", even if the roster somehow says you are alone (e.g. your own
   * share focused while the last person drops).
   */
  focused: boolean;
}

/** The chip (and therefore the game) exists only while waiting ALONE. */
export function minigameChipVisible(i: MinigameVisibilityInputs): boolean {
  return (
    i.enabled &&
    i.connected &&
    i.participants <= 1 &&
    !i.immersive &&
    !i.focused
  );
}

/**
 * The WoW-Peggle rule: the moment somebody actually shows up, the game gets
 * out of the way — pause and collapse, don't make the player close anything.
 * Kept separate from visibility so the overlay parks exactly on the alone→
 * accompanied edge rather than also collapsing on e.g. a focus change, where
 * losing game state would be rude.
 */
export function minigameInterruptedByJoin(participants: number): boolean {
  return participants > 1;
}
