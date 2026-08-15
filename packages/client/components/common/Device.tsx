import {
  Accessor,
  createContext,
  createSignal,
  JSX,
  onCleanup,
  useContext,
} from "solid-js";

import { isMobileBrowser } from "@livekit/components-core";
import Breakpoint from "./Breakpoint";

export type Layout = "desktop" | "tablet" | "phone";

/**
 * Aspect ratio at or above which a display counts as ultrawide.
 *
 * Real panels sit nowhere near this line: the widest common non-ultrawide is
 * 16:9 at 1.78, and the narrowest panel sold as 21:9 is 2560x1080 at 2.37. Do
 * not lower it toward 1.9 to be generous — a maximized browser on a 1920x1080
 * screen has a *viewport* around 1920x930, which is 2.06. That artifact is
 * exactly why this is measured against the screen and not the window.
 */
const ULTRAWIDE_ASPECT = 2;

/**
 * Viewport width at or above which the ultrawide rearrangement has room to
 * happen: server rail (~64) + channel column (~240) + a capped message column
 * (1200-1600) + a member gutter (~240).
 */
const ULTRAWIDE_MIN_WIDTH = 1800;

/**
 * Whether the display itself is ultrawide.
 *
 * Read from `screen`, not from a media query: `min-device-aspect-ratio` is the
 * obvious-looking CSS equivalent and it is deprecated. There is no event for
 * "window moved to another monitor", so this is re-read on resize instead; the
 * values track whichever monitor the window is currently on.
 */
function readUltrawideDisplay(): boolean {
  const width = globalThis.screen?.width;
  const height = globalThis.screen?.height;

  // Fail OPEN. Locking a genuine ultrawide owner out of a layout preference
  // because some shell reported nothing is a worse outcome than offering the
  // option to somebody who has no use for it.
  if (!width || !height) return true;

  return width / height >= ULTRAWIDE_ASPECT;
}

/** Device type and compatibility info */
export class Device {
  /** Layout type based on viewport size

   * **Note:** This is for advanced reactivity. If you only need to
   * adjust CSS, use the `_phone` and `_tablet` PandaCSS breakpoints. */
  readonly layout: Accessor<Layout>;

  /** Whether the *display* is 21:9 or wider.

   * Gates whether the ultrawide layout option is offered at all. Deliberately
   * a property of the hardware, so it does not flicker while the window is
   * dragged, and so it still reads true for a half-screen window. */
  readonly ultrawideDisplay: Accessor<boolean>;

  /** Whether the *window* is currently wide enough to lay out for.

   * Gates whether the ultrawide layout actually applies. Width, not aspect:
   * "is there room for another column" is a question about absolute pixels. */
  readonly wideEnough: Accessor<boolean>;

  /** Mobile device detection based on User Agent.

   * **Warning:** Don't use unless absolutely necessary.
   * Granular feature-detection is preferred when possible. */
  readonly isMobile: boolean;

  private pMedia;
  private tMedia;
  private wMedia;
  private setLayout;
  private setUltrawideDisplay;
  private onResize;

  constructor() {
    this.isMobile = isMobileBrowser();

    const [lo, setLo] = createSignal<Layout>("desktop");
    this.layout = lo;
    this.setLayout = setLo;

    this.pMedia = matchMedia(Breakpoint.phone);
    this.tMedia = matchMedia(Breakpoint.tablet);
    (this.pMedia.onchange = this.tMedia.onchange = this.onLayout.bind(this))();

    this.wMedia = matchMedia(`(min-width: ${ULTRAWIDE_MIN_WIDTH}px)`);
    const [wide, setWide] = createSignal(this.wMedia.matches);
    this.wideEnough = wide;
    this.wMedia.onchange = () => setWide(this.wMedia.matches);

    const [ultrawide, setUltrawide] = createSignal(readUltrawideDisplay());
    this.ultrawideDisplay = ultrawide;
    this.setUltrawideDisplay = setUltrawide;
    this.onResize = () => this.setUltrawideDisplay(readUltrawideDisplay());
    addEventListener("resize", this.onResize);
  }

  onLayout() {
    this.setLayout(
      this.pMedia.matches
        ? "phone"
        : this.tMedia.matches
          ? "tablet"
          : "desktop",
    );
  }

  destroy() {
    this.pMedia.onchange = this.tMedia.onchange = this.wMedia.onchange = null;
    removeEventListener("resize", this.onResize);
  }
}

const deviceCtx = createContext<Device>(null! as Device);

/** Mount device context */
export function DeviceContext(props: { children: JSX.Element }) {
  const dev = new Device();
  // Passing `dev.destroy` bare loses `this` and throws on the first line of the
  // method. It never surfaced because this context is mounted at the root and
  // so is only ever disposed on teardown — but the resize listener added above
  // does need removing, so the call has to actually work.
  onCleanup(() => dev.destroy());

  return <deviceCtx.Provider value={dev}>{props.children}</deviceCtx.Provider>;
}

/** Device type and compatibility info */
export const useDevice = () => useContext(deviceCtx);
