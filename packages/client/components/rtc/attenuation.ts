import { type Participant, type Room, RoomEvent } from "livekit-client";

import { tauriInvoke } from "@revolt/common";
import type { Voice as VoiceSettings } from "@revolt/state/stores/Voice";

/**
 * Global attenuation ("duck other apps while someone speaks").
 *
 * The renderer owns WHEN: LiveKit's active-speaker list says who is
 * talking, the settings say whose speech counts and how much to lower, and a
 * short hold-off keeps other apps from pumping between words. Native
 * (`attenuation_apply` in the Tauri shell) owns HOW: per-application session
 * volumes on the default output, restored to their exact previous levels.
 *
 * Desktop only — the probe returns `supported: false` elsewhere and every
 * call here becomes a no-op, so the room wiring can be unconditional.
 */

/** Hold-off after the last active speaker before other apps come back up. */
const RELEASE_MS = 600;

export interface AttenuationStatus {
  supported: boolean;
  active: boolean;
}

/** Whether this shell can duck other applications at all. */
export async function attenuationSupported(): Promise<boolean> {
  const invoke = tauriInvoke();
  if (!invoke) return false;
  try {
    const status = await invoke<AttenuationStatus>("attenuation_status");
    return !!status?.supported;
  } catch {
    return false;
  }
}

export class Attenuation {
  #settings: VoiceSettings;
  #room: Room | undefined;
  #localSpeaking = false;
  #remoteSpeaking = false;
  /** Strength (0–1) last sent to native; 0 = nothing ducked. */
  #applied = 0;
  #release: ReturnType<typeof setTimeout> | undefined;
  #onSpeakers = (speakers: Participant[]) => {
    this.#localSpeaking = speakers.some((p) => p.isLocal);
    this.#remoteSpeaking = speakers.some((p) => !p.isLocal);
    this.#evaluate();
  };

  constructor(settings: VoiceSettings) {
    this.#settings = settings;
  }

  /** Follow a room's active speakers. Detaches from any previous room. */
  attach(room: Room) {
    this.detach();
    this.#room = room;
    room.on(RoomEvent.ActiveSpeakersChanged, this.#onSpeakers);
    this.#onSpeakers(room.activeSpeakers);
  }

  /** Stop following and put everything back immediately. */
  detach() {
    this.#room?.off(RoomEvent.ActiveSpeakersChanged, this.#onSpeakers);
    this.#room = undefined;
    this.#localSpeaking = false;
    this.#remoteSpeaking = false;
    this.#cancelRelease();
    if (this.#applied > 0) this.#apply(0);
  }

  /**
   * Re-evaluate after a settings change: a new strength lands on an active
   * duck immediately, and turning the feature off releases at once.
   */
  refresh() {
    this.#evaluate();
  }

  #evaluate() {
    const strength = Math.min(
      1,
      Math.max(0, this.#settings.attenuationStrength / 100),
    );
    const speaking =
      (this.#settings.attenuateWhenISpeak && this.#localSpeaking) ||
      (this.#settings.attenuateWhenOthersSpeak && this.#remoteSpeaking);
    const want = this.#room && strength > 0 && speaking ? strength : 0;

    if (want > 0) {
      this.#cancelRelease();
      if (this.#applied !== want) this.#apply(want);
      return;
    }

    if (this.#applied === 0) return;
    // Feature switched off outright: no reason to keep others quiet.
    if (strength === 0) {
      this.#cancelRelease();
      this.#apply(0);
      return;
    }
    if (!this.#release) {
      this.#release = setTimeout(() => {
        this.#release = undefined;
        this.#apply(0);
      }, RELEASE_MS);
    }
  }

  #cancelRelease() {
    if (this.#release) clearTimeout(this.#release);
    this.#release = undefined;
  }

  #apply(strength: number) {
    this.#applied = strength;
    const invoke = tauriInvoke();
    if (!invoke) return;
    void invoke("attenuation_apply", { strength }).catch(() => {
      // Unsupported shell or a session that vanished mid-call — nothing to
      // do; native restores what it can on its own next call.
    });
  }
}
