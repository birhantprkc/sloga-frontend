import { createSignal } from "solid-js";

/**
 * Global "someone else owns the keyboard right now" switch.
 *
 * Set while a remote-control session has the capture surface live: every
 * keystroke the controller types is meant for the SHARER'S machine, and
 * must not also drive this client.
 *
 * # Why this module exists at all, rather than the flag living in the RC store
 *
 * `keybindActions.ts` today imports exactly one thing. Reaching `@revolt/rtc`
 * from it to ask whether control is active closes an import cycle —
 * `keybinds → rtc → modal → keybinds` — and this codebase has two recorded
 * blank-`#root` failures caused by module-init ordering. So the flag lives in
 * a dependency-free leaf that both sides import instead.
 *
 * # Why it is not enough to `stopPropagation` at the capture surface
 *
 * Keyboard events target `document.activeElement`. Any click on the call
 * chrome, any Solid remount (toggling focus swaps the tile between two
 * different `TrackLoop`s), or the theater-exit button moves focus off the
 * capture div — at which point the div is not in the event path and its
 * listeners never run, while the `document.body` keybind listeners still do.
 * The suppression check inside `keybindFilter` is what makes correctness
 * independent of both listener order and DOM focus. Both layers are real:
 * `stopPropagation` stops Sloga's own delegated `onClick`/`contextmenu`
 * handlers, this stops the keybinds.
 *
 * # Scope: EVERY keybind, not just the composer one
 *
 * `CHAT_FOCUS_COMPOSITION` is the notorious one (bound to `/^[^ ]$/`, so
 * typing "hello" at the sharer's Notepad focuses this client's composer on
 * the "h" and posts "ello" to the channel). But it is not the only hijack:
 * a remote **Escape** — dismissing a dialog on the sharer's machine, one of
 * the most common keys there is — fires `CLOSE_FLOATING` / `CLOSE_MODAL` /
 * `CLOSE_SIDEBAR` / `CHAT_JUMP_END`, and remote **Ctrl+Alt+Arrow** /
 * **Alt+Arrow** navigate this client to a different server or channel. That
 * last one changes the route, which flips the call card to PiP, which
 * unmounts the capture surface *mid-session with keys held*. So the
 * suppression is unconditional.
 */
const [keybindsSuppressed, setKeybindsSuppressed] = createSignal(false);

export { keybindsSuppressed, setKeybindsSuppressed };

/**
 * Registered by `KeybindContext` so a suppression owner can clear the
 * handler's `activeKeys` set.
 *
 * `activeKeys` is closure-local to `KeybindContext` and persists for the life
 * of the window, so a `keyup` that never reaches `document.body` latches its
 * key forever: hold Escape, start capturing (the keyup is swallowed),
 * and every subsequent keystroke in this client re-fires `CLOSE_FLOATING`
 * because the effect re-runs on any `activeKeys` mutation. Only a reload
 * recovers. Cleared on both edges of a session, so neither the keys held
 * going in nor the ones held coming out can latch.
 */
let clearActiveKeys: (() => void) | undefined;

/** Called by `KeybindContext`; not part of the public surface. */
export function registerActiveKeyReset(reset: () => void) {
  clearActiveKeys = reset;
  return () => {
    if (clearActiveKeys === reset) clearActiveKeys = undefined;
  };
}

/**
 * Suppress (or release) Sloga's own keybinds, clearing any latched keys on
 * both edges. Idempotent.
 */
export function setKeybindSuppression(suppressed: boolean) {
  setKeybindsSuppressed(suppressed);
  clearActiveKeys?.();
}
