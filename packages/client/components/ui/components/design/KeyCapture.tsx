import { Show, createEffect, createSignal, onCleanup } from "solid-js";

import { styled } from "styled-system/jsx";

import {
  type Binding,
  type BindingConflict,
} from "../../../keybinds/globalKeybinds.ts";
import { Symbol } from "../utils/Symbol";

import { Ripple } from "./Ripple";
import {
  type ConflictMode,
  decideCapture,
  formatBinding,
} from "./keyCapturePolicy.ts";

/**
 * User-visible copy, supplied by the caller.
 *
 * 🔴 Every string this widget shows that is not a keycap legend comes from
 * here, and that is not a style preference. This repo's lingui `extract` is
 * broken and the catalogs are hand-maintained by a separate lane, so a msgid
 * invented inside a shared control would be a msgid no catalog has — the
 * string would ship as its own untranslated id. The caller already sits in a
 * file with real `<Trans>` usage and can wrap these there.
 *
 * (The keycap legends themselves — "Ctrl", "Esc", "↑" — are produced by
 * `./keyCapturePolicy.ts`'s formatter and are documented as an accepted,
 * marked `TODO(i18n)` at the bottom of that file.)
 */
export type KeyCaptureCopy = {
  /** Accessible name of the capture control, e.g. "Toggle mute keybind". */
  readonly label: string;
  /** Replaces the keycap while listening, e.g. "Press a key…". */
  readonly listening: string;
  /** Replaces the keycap when `value` is `null`, e.g. "Not bound". */
  readonly empty: string;
  /** Accessible name of the clear control, e.g. "Clear keybind". */
  readonly clear: string;
};

/**
 * 🔴 **Pinned cross-file contract.** Two later lanes consume this shape (the
 * settings rows that bind the twelve global actions, and the push-to-talk row
 * that retires the one-off capture in
 * `settings/user/voice/VoiceProcessingOptions.tsx`). The push-to-talk row is
 * also the consumer of `conflictMode`, below.
 *
 * Fully controlled: this component holds no copy of the binding. `value` is
 * the single source of truth and the callbacks are the only way it changes,
 * so the store stays authoritative and a refused capture cannot leave the
 * widget displaying a chord the store never accepted.
 */
export type KeyCaptureProps = {
  /** The binding this control edits; `null` when unbound. */
  readonly value: Binding | null;

  /**
   * A chord was captured and accepted.
   *
   * Not called for a refused chord. May be called with a soft conflict
   * outstanding — `onConflict` fires first in that case, so a handler that
   * wants to block on a warning has the verdict before the value.
   */
  readonly onChange: (binding: Binding) => void;

  /**
   * The binding was cleared — Delete/Backspace while listening, or the clear
   * control. Distinct from `onChange` because `Binding` has no "unbound"
   * value and `null` is the store's, not a chord.
   */
  readonly onClear: () => void;

  /**
   * The conflict verdict for the chord just captured, or `null` to retract a
   * previous one (a fresh capture started, a clean chord committed, or the
   * binding was cleared).
   *
   * Fires for refusals *and* for accepted-with-warning chords; use
   * `isHardConflict` from `./keyCapturePolicy.ts` to tell them apart. The caller
   * owns the message, both because of the i18n rule above and because the
   * honest text differs per row (an `"in-app"` collision means something
   * different for a `"global"`-tier action than an `"in-app"`-tier one).
   */
  readonly onConflict?: (conflict: BindingConflict | null) => void;

  /**
   * The caller's current `voice.pushToTalkKey`, or `undefined` when
   * push-to-talk is off (the key is configured but inert, so there is nothing
   * to collide with).
   *
   * 🔴 Passed in rather than read here on purpose: this control must not
   * import the Voice store. `findBindingConflict` takes the same parameter for
   * the same reason, and the import direction `keybinds/suppress` exists to
   * avoid is the one a `@revolt/state` reach from a design-system leaf would
   * create.
   */
  readonly pushToTalkKey?: string;

  /**
   * Which runtime matcher the CONSUMER of this binding uses, so the conflict
   * verdict describes what will actually be stored and matched.
   *
   * "chord" (default): the consumer matches the whole chord — the twelve
   * keybind rows. "code": the consumer stores and matches `code` alone and
   * discards modifiers — the push-to-talk row. A soft in-app collision is
   * then reported for the bare code, and reserved-ness is judged on the bare
   * code the consumer will keep.
   *
   * Forwarded verbatim to `decideCapture`; this widget adds no logic of its
   * own.
   */
  readonly conflictMode?: ConflictMode;

  /** Block capture entirely. */
  readonly disabled?: boolean;

  readonly copy: KeyCaptureCopy;
};

/**
 * Capture a key chord for a global keybind.
 *
 * Promoted from the 14-line one-off in
 * `settings/user/voice/VoiceProcessingOptions.tsx`, which had five defects
 * this control fixes rather than inherits: a leaked `window` listener (no
 * cleanup), no modifier support (the first keydown won, so Shift+F13 bound
 * `"ShiftLeft"`), no cancel and no clear (Escape bound `"Escape"`), no
 * conflict detection, and a formatter whose arrow branch was dead code. The
 * decisions all live in `./keyCapturePolicy.ts` so they are unit-testable;
 * this file owns listener lifetime and markup only.
 */
export function KeyCapture(props: KeyCaptureProps) {
  const [listening, setListening] = createSignal(false);

  /**
   * Removes **every** listener the live capture installed, unconditionally.
   *
   * 🔴 Defect 1 of the one-off: it added a `window` keydown listener from
   * inside a click handler and removed it only on a successful capture. Any
   * other exit — navigating away, closing settings, unmounting mid-capture —
   * left it attached, and the next keystroke *anywhere in the app* silently
   * rebound push-to-talk.
   *
   * 🔴 This is deliberately a *separate* reference from {@link endCaptureRef}.
   * Ending a capture keeps one listener alive on purpose (the trailing-keyup
   * swallow, below), so routing unmount through the soft path would leak that
   * listener exactly when the component is gone and can never remove it —
   * defect 1 again, by a subtler route.
   */
  let detachAllRef: (() => void) | undefined;

  /** Ends the live capture, possibly leaving the keyup swallow armed. */
  let endCaptureRef: (() => void) | undefined;

  function stopCapture() {
    endCaptureRef?.();
  }

  /** The hard path: drop everything, holding no listener back. */
  function disposeCapture() {
    detachAllRef?.();
    detachAllRef = undefined;
    endCaptureRef = undefined;
    setListening(false);
  }

  // 🔴 The unmount-mid-listen half of defect 1. Solid runs this on disposal of
  // the owner; it takes the hard path, so nothing survives the unmount.
  onCleanup(disposeCapture);

  /**
   * 🔴 `disabled` flipping true mid-listen tears the capture down, and it is
   * an effect rather than a guard inside `onKeyDown` on purpose.
   *
   * `startCapture` and `clear` both gate on the prop, but a capture that was
   * already armed when the prop flipped kept its window listeners and still
   * delivered `onChange`/`onClear` to a parent that had just said "block
   * capture entirely". Worse than the stray callback: the trigger renders
   * `disabled`, so it stops taking clicks, and with the keydown listener still
   * installed in the capture phase every keystroke in the window was being
   * swallowed by a control the user could no longer click out of. Escape and a
   * focus loss were the only exits left.
   *
   * A guard at the top of `onKeyDown` would not be enough. It only runs when a
   * key arrives, so until then the listeners stay installed and the trigger
   * stays stuck rendering `copy.listening`; and it cannot reach the case where
   * a capture has already ended with keys still held — `swallowed` is
   * non-empty, the keyup swallow is armed, and no further keydown is coming to
   * trip the guard. The effect covers all three because it fires on the prop
   * edge itself, and it takes the hard path so no listener is held back.
   */
  createEffect(() => {
    if (props.disabled) disposeCapture();
  });

  function startCapture() {
    if (props.disabled || listening()) return;

    // 🔴 Drop any remnant of a previous capture before installing a new one.
    // A capture that ended with keys still held leaves its keyup swallow
    // attached on purpose, and the refs that can remove it are single-slot:
    // starting a second capture while the first chord is STILL held (click,
    // press, keep holding, click again) would overwrite both refs and orphan
    // that listener with nothing left able to detach it — defect 1 again, by
    // the narrowest route. Disposing first makes the refs unambiguously
    // describe exactly one live capture.
    disposeCapture();

    // A new attempt retracts the previous verdict, so a stale "reserved"
    // warning cannot sit next to a chord the user has since replaced.
    props.onConflict?.(null);

    /**
     * Codes whose `keydown` this capture swallowed, still awaiting a `keyup`.
     *
     * The chord we consume must not reach the app on the way *out* either. If
     * capture ends on the keydown and the listeners go with it, the trailing
     * `keyup` lands on the app's own handlers — and push-to-talk in
     * `@revolt/rtc/state.tsx` matches a bare `e.code` on keyup with no
     * modifier comparison, so it would take a release for a press it never
     * saw. Swallowing exactly the ups whose downs we ate is also the same
     * symmetry the native contract insists on for dispatch: no down, no up.
     */
    const swallowed = new Set<string>();

    function swallow(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
    }

    function onKeyDown(event: KeyboardEvent) {
      swallow(event);
      swallowed.add(event.code);

      const decision = decideCapture(
        event,
        props.pushToTalkKey,
        props.conflictMode,
      );

      switch (decision.kind) {
        // Modifier-only, auto-repeat, or a Meta-held chord `Binding` cannot
        // express. Stay armed and let the user finish the chord.
        case "ignore":
          return;

        // Defect 3: the one-off bound `"Escape"`.
        case "cancel":
          stopCapture();
          return;

        // Defect 3: the one-off had no way to unbind at all.
        case "clear":
          stopCapture();
          props.onConflict?.(null);
          props.onClear();
          return;

        // Defect 4. A hard conflict reports and binds nothing.
        case "refuse":
          stopCapture();
          props.onConflict?.(decision.conflict);
          return;

        // `conflict` is either null or a soft in-app collision, which is a
        // warning and not a block — see `isHardConflict`.
        case "commit":
          stopCapture();
          props.onConflict?.(decision.conflict);
          props.onChange(decision.binding);
          return;
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      // Not a key we ate — leave it alone rather than eating a release the
      // app is owed.
      if (!swallowed.delete(event.code)) return;
      swallow(event);
      // Last held key released after the capture already ended: the swallow
      // has done its job and the final listeners can go.
      //
      // 🔴 `removeBlur` belongs here, not in `endCaptureRef`. The blur handler
      // is what disposes the swallow when the releases are delivered to
      // whatever took focus instead of to us, so it has to outlive the end of
      // the capture for exactly as long as the swallow does — see the note on
      // `endCaptureRef`. This is the ordinary drain, where the swallow is
      // finished and the blur handler is finished with it.
      if (swallowed.size === 0 && !listening()) {
        removeKeyUp();
        removeBlur();
        detachAllRef = undefined;
        endCaptureRef = undefined;
      }
    }

    // A chord can be claimed by the OS or another window (Alt+Tab, the
    // reserved panic combo), in which case no keyup ever arrives here. Ending
    // capture on blur is what stops the control sitting in "listening"
    // forever with live listeners under it.
    //
    // 🔴 Takes the HARD path, not `stopCapture`. The releases of anything held
    // across a focus loss are delivered to whatever took focus, so the
    // trailing-keyup swallow would be waiting for events that are never
    // coming — an inert listener kept alive until unmount, which is the leak
    // this control exists to not have.
    function onWindowBlur() {
      disposeCapture();
    }

    const removeKeyDown = () =>
      window.removeEventListener("keydown", onKeyDown, true);
    const removeKeyUp = () =>
      window.removeEventListener("keyup", onKeyUp, true);
    const removeBlur = () => window.removeEventListener("blur", onWindowBlur);

    // Capture phase on `window`: the in-app keybind registry listens on
    // `document.body`, so a capture-phase listener one level up sees the event
    // first and `stopPropagation` prevents it ever descending there.
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);

    detachAllRef = () => {
      removeKeyDown();
      removeKeyUp();
      removeBlur();
    };

    endCaptureRef = () => {
      removeKeyDown();
      setListening(false);
      // Nothing still held, so there is no trailing release to swallow, and
      // both remaining listeners go with it.
      //
      // 🔴 `removeBlur` is INSIDE this branch. It used to run
      // unconditionally, which dropped the blur handler while the keyup
      // swallow was still armed — the one combination where the blur handler
      // is the only thing that can ever dispose it. `onWindowBlur` already
      // spells out why: the releases of anything held across a focus loss are
      // delivered to whatever took focus, so our `keyup` never arrives,
      // `swallowed` never drains, and the drain above never runs. The listener
      // then survived to unmount and swallowed one later release of the same
      // physical code — capture-phase `preventDefault` + `stopPropagation` on
      // `window`, which is upstream of both the in-app registry
      // (`keybindHandler.tsx`, `document.body`) and push-to-talk
      // (`rtc/state.tsx`, `window` BUBBLE phase), so neither sees it. A key
      // bindable here because push-to-talk was off at capture time is a key
      // push-to-talk may own later, and `#pttKeyup` is the only thing that
      // calls `setMicrophoneEnabled(false)` on release — so the eaten keyup
      // left the mic open after the user let go. Keeping blur alive for
      // exactly the lifetime of the swallow closes it; the ordinary path is
      // unchanged, because this branch still removes it the moment the
      // swallow is not needed.
      if (swallowed.size === 0) {
        removeKeyUp();
        removeBlur();
        detachAllRef = undefined;
        endCaptureRef = undefined;
      }
    };

    setListening(true);
  }

  function clear() {
    if (props.disabled) return;
    props.onConflict?.(null);
    props.onClear();
  }

  return (
    <Root>
      <Trigger
        type="button"
        state={listening() ? "listening" : "idle"}
        aria-label={props.copy.label}
        aria-pressed={listening()}
        disabled={props.disabled}
        onClick={startCapture}
      >
        <Ripple disabled={props.disabled} />
        <Show
          when={!listening()}
          fallback={<Prompt>{props.copy.listening}</Prompt>}
        >
          <Show
            when={props.value}
            fallback={<Prompt>{props.copy.empty}</Prompt>}
          >
            {(binding) => <Keycap>{formatBinding(binding())}</Keycap>}
          </Show>
        </Show>
      </Trigger>

      {/* Hidden while listening: Delete/Backspace is the gesture then, and a
          click target that moves under the cursor mid-capture is worse than
          one that waits. */}
      <Show when={props.value !== null && !listening()}>
        <ClearButton
          type="button"
          aria-label={props.copy.clear}
          disabled={props.disabled}
          onClick={clear}
        >
          <Ripple disabled={props.disabled} />
          <Symbol size={18}>close</Symbol>
        </ClearButton>
      </Show>
    </Root>
  );
}

const Root = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    flexShrink: 0,
  },
});

const Trigger = styled("button", {
  base: {
    // for <Ripple />:
    position: "relative",

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "96px",
    minHeight: "32px",
    padding: "0 var(--gap-md)",

    cursor: "pointer",
    overflow: "hidden",
    borderRadius: "var(--borderRadius-md)",
    border: "1px solid var(--md-sys-color-outline-variant)",

    transition: "var(--transitions-fast) all",
    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container-high)",

    "&:disabled": {
      cursor: "not-allowed",
      opacity: 0.6,
    },
  },
  variants: {
    state: {
      idle: {},
      /**
       * The distinct listening state. Deliberately a border/background change
       * and not only a text swap: the control is keyboard-armed and every
       * keystroke in the window is being eaten, which the user is owed a
       * visible reason for.
       */
      listening: {
        borderColor: "var(--md-sys-color-primary)",
        color: "var(--md-sys-color-on-primary-container)",
        background: "var(--md-sys-color-primary-container)",
      },
    },
  },
  defaultVariants: {
    state: "idle",
  },
});

const Keycap = styled("span", {
  base: {
    fontFamily: "var(--fonts-monospace)",
    fontSize: "0.8em",
    whiteSpace: "nowrap",
  },
});

const Prompt = styled("span", {
  base: {
    fontSize: "0.8em",
    opacity: 0.7,
    whiteSpace: "nowrap",
  },
});

const ClearButton = styled("button", {
  base: {
    // for <Ripple />:
    position: "relative",

    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    flexShrink: 0,

    cursor: "pointer",
    overflow: "hidden",
    border: "none",
    borderRadius: "var(--borderRadius-full)",

    transition: "var(--transitions-fast) all",
    color: "var(--md-sys-color-on-surface-variant)",
    background: "transparent",

    "&:disabled": {
      cursor: "not-allowed",
      opacity: 0.6,
    },
  },
});
