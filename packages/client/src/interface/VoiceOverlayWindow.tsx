/**
 * The in-game voice overlay window.
 *
 * A PASSIVE RENDERER: no client, no session, no WebSocket, no LiveKit room.
 * It draws whatever the main window publishes on the `sloga:voice-overlay`
 * BroadcastChannel and owns nothing. `MountContext` short-circuits the entire
 * provider stack for this window, so there is no I18nProvider, ModalContext,
 * KeybindContext or SnackbarProvider here — **no lingui macros in this file
 * or anything it renders**, because they throw at runtime and neither tsc nor
 * the extractor catches it.
 *
 * The staleness timers are the safety property. If the main window's renderer
 * reloads or crashes, this window is still alive, still on top of the user's
 * game, and still showing a frozen roster. So: blank at 10 s of silence, ask
 * the shell to close at 30 s. (A full process kill takes this window with it,
 * which is why the timers are not about that case.)
 */
import { createSignal, onCleanup, onMount, Show } from "solid-js";

import { IS_OVERLAY_WINDOW } from "@revolt/client/popout";
import { OverlayRoster } from "@revolt/rtc/overlay/OverlayRoster";
import { openOverlayBridge } from "@revolt/rtc/overlay/bridge";
import {
  OVERLAY_PROTOCOL_VERSION,
  OverlayConfig,
  OverlayParticipant,
} from "@revolt/rtc/overlay/protocol";
import { overlayShell } from "@revolt/rtc/overlay/shell";

/** Blank the window after this long without a message. */
const STALE_BLANK_MS = 10_000;
/** Ask the shell to close the window after this long without a message. */
const STALE_CLOSE_MS = 30_000;
/** Debounce for content-size reports to the shell. */
const RESIZE_DEBOUNCE_MS = 100;

const FALLBACK_CONFIG: OverlayConfig = {
  opacity: 0.85,
  scale: 1,
  displayMode: "avatars-names",
  showLatency: false,
  corner: "top-left",
};

export function VoiceOverlayWindow() {
  // Inverse of the Interface.tsx bounce. A web user who types the path gets a
  // blank page, and in-app SPA navigation here never mounts a listener that
  // nobody is publishing to.
  //
  // The early return is safe despite the rule: `IS_OVERLAY_WINDOW` is frozen
  // at module init (see @revolt/client/popout), so there is no reactivity for
  // a second render to pick up — the whole point of freezing it is that
  // window identity must not follow SPA navigation.
  // eslint-disable-next-line solid/components-return-once
  if (!IS_OVERLAY_WINDOW) return null;

  const [participants, setParticipants] = createSignal<OverlayParticipant[]>(
    [],
  );
  const [config, setConfig] = createSignal<OverlayConfig>(FALLBACK_CONFIG);
  const [rttMs, setRttMs] = createSignal<number | undefined>(undefined);
  /** Undefined until the first message ever arrives. */
  const [lastMessageAt, setLastMessageAt] = createSignal<number | undefined>(
    undefined,
  );
  const [now, setNow] = createSignal(Date.now());
  const [ended, setEnded] = createSignal(false);

  /**
   * Silence is measured from the first message, not from mount: the window is
   * built and shown before the publisher's first snapshot lands, and starting
   * the clock at mount would blank a healthy overlay during its own boot.
   */
  const silentFor = () => {
    const last = lastMessageAt();
    return last === undefined ? 0 : now() - last;
  };

  const visible = () =>
    !ended() && lastMessageAt() !== undefined && silentFor() < STALE_BLANK_MS;

  let root: HTMLDivElement | undefined;

  onMount(() => {
    document.title = "Sloga overlay";

    const bridge = openOverlayBridge();
    const shell = overlayShell();

    const unsubscribe = bridge?.subscribe((msg) => {
      if (msg.type === "bye") {
        // The call is over and the publisher said so. Stop drawing at once
        // rather than waiting out the staleness timers — those exist for the
        // case where nobody gets to say goodbye.
        setEnded(true);
        setParticipants([]);
        shell?.close();
        return;
      }
      if (msg.type !== "state") return;

      setEnded(false);
      setLastMessageAt(Date.now());
      setParticipants(msg.participants);
      setConfig(msg.config);
      setRttMs(msg.rttMs);
    });

    // Snapshot-on-boot: this window can open at any point in a call, and the
    // publisher's periodic tick would otherwise leave it blank for up to
    // 3 seconds.
    bridge?.publish({ v: OVERLAY_PROTOCOL_VERSION, type: "hello" });

    // One clock drives both staleness thresholds. 1 s granularity is plenty
    // for 10 s / 30 s and costs nothing.
    const tick = setInterval(() => {
      setNow(Date.now());
      if (lastMessageAt() !== undefined && silentFor() >= STALE_CLOSE_MS) {
        shell?.close();
      }
    }, 1000);

    // Self-sizing: the shell owns x/y, we own w/h. Without this the
    // transparent window stays at whatever size it was built at, and a
    // click-through window larger than its content is invisible but still
    // covers screen area that the corner arithmetic thinks is in use.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer =
      typeof ResizeObserver === "function" && root
        ? new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              if (!root) return;
              const rect = root.getBoundingClientRect();
              // Round up: a fractional height truncated down clips the last
              // row's descenders.
              shell?.setBounds({
                width: Math.ceil(rect.width),
                height: Math.ceil(rect.height),
                corner: config().corner,
              });
            }, RESIZE_DEBOUNCE_MS);
          })
        : undefined;
    if (observer && root) observer.observe(root);

    onCleanup(() => {
      unsubscribe?.();
      bridge?.close();
      clearInterval(tick);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer?.disconnect();
    });
  });

  return (
    <div
      ref={root}
      style={{
        display: "inline-block",
        padding: "8px",
        // The whole window fades as one, so the roster never half-disappears.
        opacity: visible() ? config().opacity : 0,
        transition: "opacity 200ms ease",
        // Belt-and-suspenders against the shell's click-through: nothing here
        // should ever be a mouse target even if a future shell slice forgets
        // `set_ignore_cursor_events`.
        "pointer-events": "none",
        "user-select": "none",
      }}
    >
      <Show when={visible()}>
        <OverlayRoster
          participants={participants()}
          config={config()}
          rttMs={rttMs()}
        />
      </Show>
    </div>
  );
}
