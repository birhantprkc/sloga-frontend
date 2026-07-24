import { createSignal } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

/**
 * Which channel this client was distributed through.
 *
 * One web bundle serves the browser, the sloga.gg APK and the Play Store APK,
 * so anything Google Play forbids has to be gated at runtime rather than at
 * build time. The native layer reports the flavour it was compiled as — see
 * android/app/src/main/java/com/acutest/app/AppFlavorPlugin.java.
 */
export type DistributionChannel = "web" | "sideload" | "play";

const AppFlavorNative = Capacitor.isNativePlatform()
  ? registerPlugin<{ get(): Promise<{ channel: string }> }>("AppFlavor")
  : undefined;

function initialChannel(): DistributionChannel {
  if (!Capacitor.isNativePlatform()) return "web";

  // APKs built before the flavour split have no AppFlavor plugin, and all of
  // them are sideload builds — the Play flavour did not exist yet. Without
  // this, every already-installed sideload app would lose its donate link the
  // moment it loaded a newer web bundle.
  if (!Capacitor.isPluginAvailable("AppFlavor")) return "sideload";

  // Native, plugin present, answer not back yet: assume Play. Guessing wrong
  // in this direction briefly hides a donate link; guessing wrong the other
  // way ships Play-prohibited UI, so this fails closed on purpose.
  return "play";
}

const [channel, setChannel] = createSignal<DistributionChannel>(
  initialChannel(),
);

AppFlavorNative?.get()
  .then(({ channel: reported }) =>
    setChannel(reported === "sideload" ? "sideload" : "play"),
  )
  // Leave the fail-closed default in place: on a native build we would rather
  // hide a donate link than risk showing one in a Play build.
  .catch(() => void 0);

/** Channel this client was distributed through. */
export const distributionChannel = channel;

/**
 * Google Play's Payments policy makes linking out to donations a grey area,
 * and Sloga Technologies LLC is not a registered nonprofit, so the charity
 * carve-out does not apply. Ko-fi entries stay out of Play builds.
 */
export const allowsDonationLinks = () => channel() !== "play";

/**
 * Google Play's Device and Network Abuse policy forbids an app distributed on
 * Play from updating itself outside Play.
 */
export const allowsSelfUpdate = () => channel() === "sideload";
