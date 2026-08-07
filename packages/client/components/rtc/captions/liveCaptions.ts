import { ReactiveMap } from "@solid-primitives/map";

// Type-only, so nothing here pulls the engine implementations (and through
// them `@capacitor/core` and the Web Speech globals) into this module. The
// engine arrives through the constructor instead, which is what lets
// `liveCaptions.test.ts` drive this class under `node --test` with no shell.
import type { CaptionEngine, CaptionResult } from "./speechCaptionEngine.ts";

/** A caption currently displayed for one call participant. */
export interface CaptionEntry {
  /** Recognized text in the speaker's own language. */
  text: string;
  /** True once the utterance is finalized (interim results update in place). */
  isFinal: boolean;
  /** BCP-47 language the speaker was recognized in (for translation). */
  sourceLang: string;
}

/** Relays one finalized caption to the other participants of the call. */
export type CaptionSender = (text: string, lang: string) => void;

/** Clear a finalized caption this long after its last update. */
const FINAL_LINGER_MS = 6000;
/** Clear a stalled interim caption if no further update arrives. */
const INTERIM_TIMEOUT_MS = 8000;
/**
 * Hard cap on caption length (outgoing and ingested). Bounds a hostile/oversized
 * remote caption from overflowing the tile, and keeps text under the
 * translate-endpoint limit. Utterances longer than this are simply truncated.
 * The server clamps to the same number.
 */
const MAX_CAPTION_CHARS = 240;

/**
 * Live call captions: runs the local speech recognizer, relays the speaker's
 * finalized transcript through the server, and ingests other participants'
 * transcripts into a reactive per-identity map the UI renders (translating on
 * the receiving end via the existing message-translation path).
 *
 * TRANSPORT: captions do NOT ride a LiveKit data channel, and cannot. The
 * voice join token is minted `can_publish_data: false`, so the SFU silently
 * discards published packets — `publishData()` resolves without error and
 * nothing reaches the peer. That is why the original build appeared to work in
 * solo tests (the local self-mirror below) while no remote participant ever
 * saw a caption. Finalized lines now go over REST and come back as a
 * `CallCaption` event fanned to the call's participants.
 *
 * FINALS ONLY: interim recognizer results stay on the speaker's own screen.
 * They would otherwise cost one request per keystroke-rate update, and the
 * receiver debounces interims 450ms before translating anyway.
 *
 * PRIVACY: recognition sends mic audio to the browser's speech vendor, and the
 * transcript now passes through the server in plaintext (it did not before —
 * the data channel was peer-to-SFU). The controller therefore never publishes
 * on an E2EE call: the caller gates `setLocalPublishing` on call mode.
 */
export class LiveCaptions {
  /** identity -> latest caption; reactive so participant tiles re-render. */
  readonly entries = new ReactiveMap<string, CaptionEntry>();

  #engine: CaptionEngine | undefined;
  #engineFactory: () => CaptionEngine;
  #localIdentity = "";
  #localLang = "en-US";
  #publishing = false;
  #send: CaptionSender | undefined;
  #lastSentText = "";
  #clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * @param engineFactory Supplies the shell's speech recognizer. Injected
   * rather than imported so this module stays free of shell globals and
   * specs can drive it with a fake; called lazily on first use.
   */
  constructor(engineFactory: () => CaptionEngine) {
    this.#engineFactory = engineFactory;
  }

  /** This device's LiveKit identity — lets the narrator skip my own captions. */
  get localIdentity(): string {
    return this.#localIdentity;
  }

  #clampText(text: string): string {
    return text.length > MAX_CAPTION_CHARS
      ? text.slice(0, MAX_CAPTION_CHARS)
      : text;
  }

  /**
   * Bind to a connected call. Local broadcasting stays off until
   * `setLocalPublishing(true, …)`.
   *
   * No transport listener is registered here: the `CallCaption` client event
   * is app-lifetime, so the store subscribes once and calls
   * `handleRemoteCaption`. A connect/disconnect subscription would go dead
   * after the first call — the same reasoning as the soundboard.
   */
  attach(localIdentity: string, send: CaptionSender) {
    this.detach();
    this.#localIdentity = localIdentity;
    this.#send = send;
  }

  /** Unbind and clear all caption state. Safe to call repeatedly. */
  detach() {
    this.stopLocal();
    for (const timer of this.#clearTimers.values()) clearTimeout(timer);
    this.#clearTimers.clear();
    this.entries.clear();
    this.#send = undefined;
    this.#lastSentText = "";
  }

  /**
   * Enable/disable broadcasting the local speaker's captions. `lang` is the
   * speaker's spoken language (BCP-47). No-op if the engine is unsupported.
   */
  setLocalPublishing(enabled: boolean, lang: string) {
    this.#localLang = lang || "en-US";
    if (enabled) this.#startLocal();
    else this.stopLocal();
  }

  #startLocal() {
    const engine = (this.#engine ??= this.#engineFactory());
    if (!engine.supported) return;
    // start() re-targets the language if already running.
    engine.start(this.#localLang, (result) => this.#onLocalResult(result));
    this.#publishing = true;
  }

  stopLocal() {
    if (!this.#publishing) return;
    this.#publishing = false;
    this.#engine?.stop();
    this.#lastSentText = "";
    this.#clearEntry(this.#localIdentity);
  }

  #onLocalResult(result: CaptionResult) {
    // Recognizers deliver results ASYNCHRONOUSLY and can emit a final AFTER
    // stop() — Web Speech routinely flushes the in-flight utterance. Without
    // this guard, muting the mic or dropping onto an E2EE call mid-sentence
    // would still relay that sentence, defeating both gates in
    // `CaptionPublisher`. Checked before the local mirror too: `stopLocal`
    // just cleared my entry, and a late result would put it back.
    if (!this.#publishing) return;

    const text = this.#clampText(result.text);
    // Mirror my own caption locally — including interims, which never leave
    // this machine — so I can see what is being relayed.
    this.#apply(this.#localIdentity, {
      text,
      isFinal: result.isFinal,
      sourceLang: this.#localLang,
    });

    if (!result.isFinal) return;
    if (!text.trim()) return;
    // Some recognizers repeat a final verbatim; don't spend a request on it.
    if (text === this.#lastSentText) return;
    this.#lastSentText = text;
    this.#send?.(text, this.#localLang);
  }

  /**
   * Ingest a caption relayed by the server. The caller is responsible for
   * scoping to the active call — the private topic this arrives on reaches
   * every session of this user, including ones not in the call.
   *
   * Always final: the server only relays finalized utterances.
   */
  handleRemoteCaption(detail: {
    identity: string;
    text: string;
    lang: string;
  }): void {
    if (!detail.identity || typeof detail.text !== "string") return;
    // Never let a relayed caption overwrite my own tile: my recognizer output
    // is authoritative for me, and this is the one entry a sender does not
    // control server-side.
    if (detail.identity === this.#localIdentity) return;
    this.#apply(detail.identity, {
      text: detail.text,
      isFinal: true,
      sourceLang: typeof detail.lang === "string" ? detail.lang : "und",
    });
  }

  #apply(identity: string, entry: CaptionEntry) {
    const text = this.#clampText(entry.text);
    if (!text.trim()) {
      this.#clearEntry(identity);
      return;
    }
    this.entries.set(identity, { ...entry, text });
    const prev = this.#clearTimers.get(identity);
    if (prev) clearTimeout(prev);
    this.#clearTimers.set(
      identity,
      setTimeout(
        () => this.#clearEntry(identity),
        entry.isFinal ? FINAL_LINGER_MS : INTERIM_TIMEOUT_MS,
      ),
    );
  }

  #clearEntry(identity: string) {
    const timer = this.#clearTimers.get(identity);
    if (timer) {
      clearTimeout(timer);
      this.#clearTimers.delete(identity);
    }
    this.entries.delete(identity);
  }
}
