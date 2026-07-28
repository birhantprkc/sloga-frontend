import { onCleanup, onMount } from "solid-js";

import { styled } from "styled-system/jsx";

import { normalizeToContentBox, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";

/**
 * The controller's capture surface: a transparent layer over a screen-share
 * tile that turns local pointer and keyboard input into events for the
 * sharer's machine.
 *
 * # Stacking — this is the whole reason the component exists separately
 *
 * `ParticipantTile` renders `<Overlay showOnHover>` at `gridArea: "1/1"`
 * with no `pointer-events: none` and no `z-index`. Both are grid items of a
 * `display: grid` tile at `position: static`, so a capture div placed as a
 * plain sibling AFTER `<VideoTrack>` paints below `Overlay` and hit-tests
 * below it too — across the ENTIRE tile, not just the visible bottom strip.
 * The symptom is the nastiest kind: control looks granted, the sharer's
 * indicator lights up, and nothing moves.
 *
 * The fix is `zIndex: 3` here, which beats `Overlay` (auto) and the theater
 * chrome (`ImmersiveControls` is 4 but sits outside the tile). Deliberately
 * NOT `pointerEvents: "none"` on `Overlay` — that is the obvious fix and it
 * silently kills the `use:floating` tooltip on the muted-participant icon
 * for every tile in every call, which is a real regression bought for
 * nothing since `z-index` alone is sufficient. `ParticipantCaption` already
 * proves the pattern (`pointerEvents: none` + `zIndex: 5` on a static grid
 * item beats `Overlay`).
 *
 * The surface is mounted ONLY while a session is armed, so hover chrome and
 * click-to-focus behave exactly as before outside one.
 */
export function RemoteControlCapture(props: {
  video?: HTMLVideoElement;
  /** Intrinsic video dimensions, from the tile's own `on:resize`. */
  videoDims: () => { width: number; height: number };
  /**
   * The sharer's FULL LiveKit identity (device-qualified since media E2EE),
   * used to scope `publishData` fan-out. Not the bare user id — the SFU
   * routes by identity.
   */
  sharerIdentity: string;
}) {
  const voice = useVoice();
  const state = useState();
  const rc = voice.remoteControl;
  let surface: HTMLDivElement | undefined;

  /**
   * Map a client point to normalized `[0,1]` coordinates of the video's
   * CONTENT BOX.
   *
   * `object-fit: contain` letterboxes: a 16:9 stream in a non-16:9 tile has
   * bars that are part of the element rect but not part of the picture. A
   * naive `(clientX - rect.left) / rect.width` is both offset and mis-scaled,
   * and every click lands systematically tens to hundreds of pixels off —
   * which feels BROKEN rather than laggy, and is the failure most likely to
   * be blamed on the network.
   *
   * `getBoundingClientRect()` is re-read per event rather than cached: the
   * tile transitions `max-width` and `aspect-ratio` over 300 ms on a focus
   * toggle, and the whole call card transitions `transform`/`width` when it
   * docks, so a rect captured at either moment is wrong for a third of a
   * second. Reading it per event is a few microseconds against a ~5 ms IPC
   * floor.
   *
   * Returns `undefined` outside the content box — rejecting is correct,
   * extrapolating would send the sharer's pointer somewhere nobody pointed.
   */
  function normalize(event: { clientX: number; clientY: number }) {
    const element = props.video ?? surface;
    if (!element) return undefined;
    // The maths lives in `normalizeToContentBox` (pure, unit-tested). Only
    // the rect read stays here, and it is deliberately PER EVENT rather than
    // cached: the tile transitions `max-width` and `aspect-ratio` over 300 ms
    // on a focus toggle, and the whole call card transitions
    // `transform`/`width` when it docks, so a rect captured at either moment
    // is wrong for a third of a second. Reading it costs a few microseconds
    // against a ~5 ms IPC floor.
    return normalizeToContentBox(
      element.getBoundingClientRect(),
      props.videoDims(),
      event,
    );
  }

  /**
   * Sloga's own behaviours hijack remote input, and `preventDefault` does not
   * help: per spec it suppresses compat mouse events but NOT `click` or
   * `contextmenu`. Two ancestors are the problem — the tile's own
   * `onClick={() => voice.toggleFocus(track)}` (Solid delegates it at
   * `document`, and bails on `cancelBubble`, so stopping propagation here is
   * enough) and `use:floating`'s bubble-phase `contextmenu` listener, which
   * would otherwise open Sloga's user context menu over the controlled
   * desktop on every remote right-click.
   *
   * Capture phase, so it runs before either.
   */
  function swallow(event: Event) {
    event.stopPropagation();
    event.preventDefault();
  }

  const MOUSE_BUTTONS: Record<number, number> = {
    0: 0, // left
    2: 1, // right
    1: 2, // middle
    3: 3, // x1
    4: 4, // x2
  };

  function onPointerDown(event: PointerEvent) {
    swallow(event);
    const at = normalize(event);
    if (!at) return;
    surface?.focus();
    // A drag that leaves this small tile would otherwise deliver `pointerup`
    // to whatever is underneath, leaving the sharer's mouse button
    // PHYSICALLY DOWN and rubber-band-selecting their desktop indefinitely.
    try {
      surface?.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort; the release-all paths below are the guarantee */
    }
    const button = MOUSE_BUTTONS[event.button];
    if (button === undefined) return;
    rc.queue({ kind: "button", button, down: true, ...at });
  }

  function onPointerUp(event: PointerEvent) {
    swallow(event);
    const at = normalize(event);
    const button = MOUSE_BUTTONS[event.button];
    if (button === undefined) return;
    // Every button packet carries its own absolute coordinates, so a click is
    // always positioned by its own packet and never by a stale lossy move.
    // If the release happened outside the content box, still send the "up" —
    // at the last known position — because a missing "up" is far worse than
    // one landing a few pixels off.
    rc.queue({
      kind: "button",
      button,
      down: false,
      x: at?.x ?? 0.5,
      y: at?.y ?? 0.5,
    });
    try {
      surface?.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  }

  function onPointerMove(event: PointerEvent) {
    const at = normalize(event);
    if (!at) return;
    rc.queue({ kind: "move", ...at });
  }

  function onWheel(event: WheelEvent) {
    swallow(event);
    const at = normalize(event);
    if (!at) return;
    rc.queue({
      kind: "wheel",
      ...at,
      deltaX: Math.trunc(event.deltaX),
      deltaY: Math.trunc(event.deltaY),
    });
  }

  /** Everything held goes up. Bound to every way focus or the pointer can be lost. */
  function releaseAll() {
    rc.queue({ kind: "releaseAll" });
  }

  function onKey(event: KeyboardEvent, down: boolean) {
    // THE PANIC COMBO IS NEVER FORWARDED. On the sharer's machine
    // `RegisterHotKey` withholds it from the focused app entirely, but on the
    // CONTROLLER'S machine no hotkey is registered — the lease belongs to the
    // injector — so without this the kill switch would be typed at the person
    // whose machine is at risk instead of stopping the session.
    //
    // Only SUPPRESSED here; the app-level handler in `RemoteControlOverlays`
    // is the one that acts, so the two do not both fire for one press.
    if (
      event.ctrlKey &&
      event.shiftKey &&
      event.altKey &&
      event.code === "End"
    ) {
      return;
    }

    // RESERVE THE CONTROLLER'S OWN PUSH-TO-TALK KEY. `ptt.rs` arms a GLOBAL
    // hook that fires regardless of focus, so without this a controller whose
    // PTT key is `KeyV` opens their own microphone *and* types `v` on the
    // sharer's machine.
    //
    // Two halves, and the second is easy to miss: do not forward it, and do
    // NOT swallow it either. The focused-window PTT listeners live on
    // `window` in the bubble phase and are the fallback whenever native
    // arming failed, so stopping propagation here would silently kill the
    // controller's own microphone. Applied unconditionally rather than only
    // while push-to-talk is on, because the setting can flip mid-session and
    // the native arm is lazy.
    if (event.code === state.voice.pushToTalkKey) return;

    event.preventDefault();
    event.stopPropagation();
    rc.queue({ kind: "key", code: event.code, down, repeat: event.repeat });
  }

  onMount(() => {
    if (!surface) return;
    // The generation this surface owns. Toggling focus swaps the tile between
    // two different `TrackLoop`s and Solid mounts the replacement BEFORE
    // disposing the original, so without a generation the outgoing tile's
    // cleanup would tear down the incoming tile's live capture — leaving a
    // fully-wired surface that silently discards every event.
    const generation = rc.startCapture(props.sharerIdentity);
    // Capture phase on the surface itself for the pointer events, so the
    // ancestors' delegated handlers never see them.
    surface.addEventListener("pointerdown", onPointerDown as never, true);
    surface.addEventListener("pointerup", onPointerUp as never, true);
    surface.addEventListener("pointermove", onPointerMove as never, true);
    surface.addEventListener("wheel", onWheel as never, {
      capture: true,
      passive: false,
    });
    surface.addEventListener("click", swallow, true);
    surface.addEventListener("contextmenu", swallow, true);
    surface.addEventListener("dblclick", swallow, true);
    surface.addEventListener("auxclick", swallow, true);

    const keydown = (event: KeyboardEvent) => onKey(event, true);
    const keyup = (event: KeyboardEvent) => onKey(event, false);
    // On `window`, capture phase: the surface can lose DOM focus (a click on
    // call chrome, a Solid remount) and keyboard events then target `body`.
    // The `keybindFilter` suppression covers correctness for Sloga's own
    // keybinds regardless; this is what actually forwards the keystrokes.
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup, true);

    // Alt+Tab delivers a keydown for Alt and never a keyup, so without these
    // the sharer is left with Alt latched and every subsequent letter is an
    // accelerator on their machine.
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", releaseAll);
    surface.addEventListener("pointercancel", releaseAll);
    surface.addEventListener("lostpointercapture", releaseAll);

    onCleanup(() => {
      surface?.removeEventListener("pointerdown", onPointerDown as never, true);
      surface?.removeEventListener("pointerup", onPointerUp as never, true);
      surface?.removeEventListener("pointermove", onPointerMove as never, true);
      surface?.removeEventListener("wheel", onWheel as never, true);
      surface?.removeEventListener("click", swallow, true);
      surface?.removeEventListener("contextmenu", swallow, true);
      surface?.removeEventListener("dblclick", swallow, true);
      surface?.removeEventListener("auxclick", swallow, true);
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("keyup", keyup, true);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", releaseAll);
      surface?.removeEventListener("pointercancel", releaseAll);
      surface?.removeEventListener("lostpointercapture", releaseAll);
      // THE UNMOUNT IS ITSELF A PAUSE CONDITION, and this covers four
      // separate vectors at once rather than special-casing each: toggling
      // focus swaps the tile between two different `TrackLoop`s, the call
      // card flipping to PiP replaces the whole component, the sharer muting
      // their screenshare track unmounts the tile, and route navigation
      // takes the card with it. Every one of them would otherwise leave the
      // controller's held keys down on someone else's machine.
      rc.onFeedLost("capture_unmounted", generation);
    });
  });

  return (
    <Surface
      ref={surface}
      tabIndex={0}
      // No visible affordance beyond the cursor: anything painted here sits
      // on top of the desktop the controller is trying to read.
      style={{ cursor: "crosshair" }}
    />
  );
}

const Surface = styled("div", {
  base: {
    gridArea: "1/1",
    width: "100%",
    height: "100%",
    /**
     * Above `Overlay` (z-index auto) AND above every other overlay the call
     * card paints across the tile. They all share one stacking context (the
     * card's `Base`), so the comparison is against their raw values, not
     * against their nesting:
     *
     *   ImmersiveControls        4  — top-right, and in theater mode the tile
     *                                 fills `View`, so this covers the
     *                                 maximized window's own close button
     *   ImmersiveChipOverlay     5  — top-left, over the app icon / File menu
     *   VoiceCallDowngradeBanner 5  — a full-width strip across the top
     *   VoiceCallRosterPanel     6  — 280px x 70% down the right-hand side
     *
     * Each of those was a dead zone where a remote click hit Sloga's chrome
     * instead of the shared desktop — and the theater one actively EXITED
     * theater mode. 20 clears all of them with room to spare.
     */
    zIndex: 20,
    outline: "none",
    touchAction: "none",
  },
});
