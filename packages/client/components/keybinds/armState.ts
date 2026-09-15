/**
 * What the native keybind hook actually armed, published as a module-level
 * signal.
 *
 * `KeybindsWorker` (`@revolt/client/KeybindsWorker`) writes it after every
 * `keybinds_arm`; the settings page reads it to mark a row `unsupported` or
 * `refused` instead of showing it as bound and never firing. That is the
 * obligation `KeybindsArmResult` in `./globalKeybinds.ts` puts on the
 * renderer, and this is where it is discharged.
 *
 * # Why a module singleton and not context
 *
 * Same shape and same reason as `@revolt/rtc/incomingCall`, which is this
 * codebase's precedent for state that has to be reachable outside the
 * component tree: the producer and the consumer are in completely different
 * subtrees — the worker mounts at app level inside `<VoiceContext>`, the
 * settings page mounts and unmounts under a route — so a provider would have
 * to wrap the whole app to join them, and the state would be lost every time
 * the page closed. A signal at module scope is read reactively from both.
 *
 * There is exactly one native hook per window, so there is exactly one honest
 * value: a second instance of this state would be a second answer to
 * "is `toggle-mute` armed", and only one of them could be right.
 *
 * # 🔴 The setter is exported, and only the worker may call it
 *
 * `incomingCall.ts` keeps its setter private behind
 * `presentIncomingCall`/`dismissIncomingCall` because those carry side
 * effects. There is nothing to wrap here — the worker already owns the whole
 * derivation ({@link armStateFromResult}) — so the setter is exported raw.
 * 🔴 The settings page must NOT call it. Every field is an observation of
 * what native reported; a page that wrote one would be publishing a claim
 * about the native layer that nothing verified, which is precisely the
 * failure `KeybindArmState.nativeAvailable` is shaped to prevent.
 *
 * # Import direction
 *
 * The type and the initial value live in `./keybindWorkerPolicy.ts`, not
 * here, and this module imports them rather than the reverse. That file is a
 * pure leaf `node --test` can load; this one calls `createSignal` at module
 * scope, so a dependency in the other direction would cost the policy its
 * testability and put a side-effecting init on the import path of every
 * consumer — the hazard `./suppress.ts` records two blank-`#root` failures
 * for. {@link KeybindArmState} is re-exported so the settings page can read
 * the value and its type from one specifier.
 */
import { createSignal } from "solid-js";

import {
  type KeybindArmState,
  UNPROBED_KEYBIND_ARM_STATE,
} from "./keybindWorkerPolicy.ts";

export type { KeybindArmState };

/**
 * Starts UNPROBED, never "armed nothing".
 *
 * The difference is the whole point of `probed`: an empty `armed` before the
 * first arm means "not tried yet", and the same empty list after one means
 * "nothing took". A page that could not tell those apart would either warn
 * about every row for the frame before the arm resolves, or show every row as
 * fine on a shell where none of them work.
 */
const [keybindArmState, setKeybindArmState] = createSignal<KeybindArmState>(
  UNPROBED_KEYBIND_ARM_STATE,
);

export { keybindArmState, setKeybindArmState };
