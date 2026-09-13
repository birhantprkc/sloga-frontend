import {
  type JSXElement,
  createContext,
  createEffect,
  onCleanup,
  useContext,
} from "solid-js";

import { ReactiveSet } from "@solid-primitives/set";

import {
  ACTION_PRIORITY,
  DISMISSAL_PRIORITY,
  KeybindAction,
  keybindFilter,
} from "./keybindActions";
import { DEFAULT_MAC_SEQUENCES, DEFAULT_SEQUENCES } from "./keybindSequences";
import { registerActiveKeyReset } from "./suppress";

type KeybindContext = {
  createKeybind: (keybind: KeybindAction, callback: () => void) => void;
  dismissTopmost: () => boolean;
};

const keybindContext = createContext<KeybindContext>(null! as KeybindContext);

export function KeybindContext(props: { children: JSXElement }) {
  /**
   * Last event target, used for filtering
   */
  let target: HTMLElement | null;

  /**
   * Keep track of pressed keys to match sequences
   */
  const activeKeys = new ReactiveSet<string>();

  /**
   * Keep track of which keybinds are currently bound
   * to filter the firing keybindings list
   */
  const currentlyBound = ACTION_PRIORITY.reduce(
    (d, k) => ({ ...d, [k]: 0 }),
    {} as Record<KeybindAction, number>,
  );

  /**
   * The callbacks behind `currentlyBound`, in registration order.
   *
   * `currentlyBound` is only a counter, so it can say *that* something is
   * bound but never *what* to call. This map carries the callbacks themselves
   * so an overlay can be dismissed programmatically — see `dismissTopmost`.
   * The last entry for an action is the most recently mounted handler, i.e.
   * the topmost one.
   */
  const boundCallbacks = new Map<KeybindAction, Array<() => void>>();

  /**
   * Dismiss the topmost overlay, without going through the keyboard at all.
   *
   * Walks `DISMISSAL_PRIORITY` (the Escape group of `ACTION_PRIORITY` minus
   * the two actions that dismiss nothing) in priority order, takes the first
   * action with a registered handler, and invokes that action's
   * **last-registered** callback.
   *
   * @returns whether anything was dismissed
   *
   * # What "dismissed" means here
   *
   * `true` means an Escape-group handler was bound and was invoked. It does
   * **not** mean a DOM change was observed — the callbacks return `void` and
   * this function has no way to confirm that anything actually closed. A
   * caller that treats `true` as "the overlay is gone" is trusting the
   * handler, not this function.
   *
   * # Why it does not reuse `firing()` / `isFired()`
   *
   * Both filter on the action's key sequence all being present in
   * `activeKeys`. With no keys held that selects nothing, so reusing them
   * would be a permanent, silent no-op. Synthesizing an `Escape` keydown is
   * worse still: `activeKeys` is fed from real `keydown`/`keyup` on
   * `document.body`, so a synthetic press with no matching release latches
   * `"Escape"` for the life of the window (see the comment on the listeners
   * below, and `./suppress`).
   *
   * # Why `keybindFilter` is deliberately not applied
   *
   * `keybindFilter`'s only branch that could apply to the Escape group is its
   * unconditional `keybindsSuppressed()` return — every other branch is
   * scoped to `CHAT_FOCUS_COMPOSITION`, which is not in this group. That
   * suppression exists because, while a remote-control capture surface is
   * live, *the keyboard* belongs to the machine being controlled. The
   * hardware back button is not the keyboard: it is a gesture on this device,
   * it cannot be typed by the remote controller, and it is the only way the
   * local user can close an overlay. Routing it through the suppression check
   * would make every back press a no-op for the caller, which on Android
   * means the press falls through to the Activity default and closes the app
   * — exactly the bug this exists to fix, made worse. So suppression is not
   * consulted; a suppression owner that also wants to swallow back presses
   * must gate its own caller.
   */
  function dismissTopmost(): boolean {
    for (const keybind of DISMISSAL_PRIORITY) {
      const callbacks = boundCallbacks.get(keybind);
      if (!callbacks?.length) continue;

      callbacks[callbacks.length - 1]();
      return true;
    }

    return false;
  }

  /**
   * Sequences for use
   */
  const sequences = navigator.platform.startsWith("Mac")
    ? DEFAULT_MAC_SEQUENCES
    : DEFAULT_SEQUENCES;

  /**
   * Get the currently firing keybind
   */
  function firing() {
    return (
      ACTION_PRIORITY
        // filter to those keybinds that are bound
        .filter((keybind) => currentlyBound[keybind])
        // apply custom filtering logic
        .filter((keybind) =>
          keybindFilter(keybind, activeKeys, currentlyBound, target),
        )
        // check whether the keybind is being pressed
        .filter((keybind) =>
          sequences[keybind].every((key) =>
            key instanceof RegExp
              ? [...activeKeys].findIndex((item) => key.test(item)) !== -1
              : activeKeys.has(key),
          ),
        )
        // return the highest priority keybind
        .shift()
    );
  }

  /**
   * Debug currently pressed sequences
   */
  if (import.meta.env.DEV) {
    createEffect(() =>
      console.debug(
        "[keybinds] Currently pressing",
        [...activeKeys],
        "which selects",
        ACTION_PRIORITY
          // filter to those keybinds that are bound
          .filter((keybind) => currentlyBound[keybind])
          // apply custom filtering logic
          .filter((keybind) =>
            keybindFilter(keybind, activeKeys, currentlyBound, target),
          )
          // check whether the keybind is being pressed
          .reduce(
            (d, keybind) => ({
              ...d,
              [keybind]: sequences[keybind].every((key) =>
                key instanceof RegExp
                  ? [...activeKeys].findIndex((item) => key.test(item)) !== -1
                  : activeKeys.has(key),
              ),
            }),
            {},
          ),
      ),
    );
  }

  /**
   * Check whether a given keybind fired
   * @param keybind Keybind
   */
  function isFired(keybind: KeybindAction) {
    return firing() === keybind;
  }

  /**
   * Handle key down event by adding it to active keys
   */
  function onKeyDown(event: KeyboardEvent) {
    target = event.target as HTMLElement;
    activeKeys.add(event.key);
  }

  /**
   * Handle key up event by removing it from active keys
   */
  function onKeyUp(event: KeyboardEvent) {
    target = event.target as HTMLElement;
    activeKeys.delete(event.key);
  }

  document.body.addEventListener("keydown", onKeyDown);
  document.body.addEventListener("keyup", onKeyUp);

  // `activeKeys` is closure-local and lives as long as this window, so any
  // `keyup` that does not reach `document.body` latches its key FOREVER —
  // and `firing()` then re-evaluates that stale combination on every
  // subsequent keystroke. A remote-control capture surface swallows keyups
  // by design, so it needs a way to clear the set on both edges of a
  // session; without one, holding Escape as capture starts leaves this
  // client closing floating elements on every keypress until a reload.
  onCleanup(registerActiveKeyReset(() => activeKeys.clear()));

  onCleanup(() => {
    document.body.removeEventListener("keydown", onKeyDown);
    document.body.removeEventListener("keyup", onKeyUp);
  });

  return (
    <keybindContext.Provider
      value={{
        createKeybind(keybind, callback) {
          currentlyBound[keybind]++;
          onCleanup(() => currentlyBound[keybind]--);

          let callbacks = boundCallbacks.get(keybind);
          if (!callbacks) {
            callbacks = [];
            boundCallbacks.set(keybind, callbacks);
          }
          callbacks.push(callback);

          onCleanup(() => {
            // Re-read rather than closing over `callbacks`: the array is
            // dropped from the map when it empties, so a stale reference
            // would resurrect a detached one.
            const current = boundCallbacks.get(keybind);
            if (!current) return;

            // Identity, not `pop()` — components unmount out of order, so the
            // entry being cleaned up is not necessarily the last one. When the
            // same function reference was registered more than once the
            // occurrences are interchangeable, so removing the most recent one
            // keeps both the count and the remaining set correct.
            const index = current.lastIndexOf(callback);
            if (index !== -1) current.splice(index, 1);
            if (!current.length) boundCallbacks.delete(keybind);
          });

          createEffect(() => {
            const _ = [...activeKeys]; // track dependency
            if (isFired(keybind)) {
              callback();
            }
          });
        },
        dismissTopmost,
      }}
    >
      {props.children}
    </keybindContext.Provider>
  );
}

/**
 * Wrapper for contextual createKeybind function
 * @param keybind Keybind
 * @param callback Callback
 */
export function createKeybind(keybind: KeybindAction, callback: () => void) {
  const { createKeybind } = useContext(keybindContext);
  createKeybind(keybind, callback);
}

/**
 * Access the keybind context.
 *
 * Returns `null` outside of a `<KeybindContext>` — the context has no default
 * value, so callers must handle that rather than destructuring blindly.
 */
export function useKeybinds(): KeybindContext | null {
  return useContext(keybindContext) ?? null;
}

/**
 * Resolve a `dismissTopmost()` bound to the surrounding keybind context.
 *
 * Call this **during component setup**, like `createKeybind`, and keep the
 * returned function; the returned function is then safe to call at any later
 * time, from any event handler.
 *
 * That split is not stylistic. `useContext` reads Solid's current owner, and
 * an Android back press arrives on a bare window event with no owner on the
 * stack — resolving the context there would silently fall back to the
 * context's empty default and report "nothing to dismiss" forever.
 *
 * Intended for input paths that are not keys at all, principally the Android
 * hardware back button. See `KeybindContext`'s `dismissTopmost` for the
 * rationale, the exclusions, and what the return value does and does not
 * promise.
 *
 * Outside a `<KeybindContext>` the returned function always reports `false`
 * rather than throwing, so a stray back press can never crash the shell.
 *
 * @returns a function reporting whether an Escape-group handler was bound and
 * invoked
 */
export function useDismissTopmost(): () => boolean {
  const context = useKeybinds();
  return () => context?.dismissTopmost() ?? false;
}

/**
 * Declarative keybind component
 */
export function Keybind(props: {
  keybind: KeybindAction;
  onPressed: () => void;
}) {
  createEffect(() => createKeybind(props.keybind, props.onPressed));
  return null;
}
