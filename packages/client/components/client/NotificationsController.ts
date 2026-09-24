import { useLingui } from "@lingui-solid/solid/macro";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { Client } from "stoat.js";

import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";
import { useSnackbar } from "@revolt/ui";

import { useClient } from ".";
import {
  notificationPermissionGranted,
  notificationsSupported,
  requestNotificationPermission,
  tauriNotification,
} from "./nativeNotifications";
import {
  compareSubscriptionKey,
  decodeVapidKey,
  keyMarker,
  planWebPushSubscription,
  shouldResyncWebPush,
} from "./webPushKey.ts";

export function useNotifications() {
  const { settings } = useState();
  const { t } = useLingui();
  const getClient = useClient();
  const snackbar = useSnackbar();
  const { showError } = useModals();

  const supportsNotification = notificationsSupported();

  const onDeny = async (showModal?: boolean) => {
    settings.resetNotificationsState("denied");
    if (showModal) {
      showError(
        t`Failed to enable notifications. Sloga does not have notification permission.`,
      );
    }
    await killServiceWorkerSubscription(getClient());
  };

  const notificationStateMismatch = (): boolean => {
    const areNotificationsAllowed =
      settings.desktopNotificationsState === "allowed" ||
      settings.pushNotificationsState === "allowed";

    const permissionGranted =
      !supportsNotification || notificationPermissionGranted();

    return areNotificationsAllowed && !permissionGranted;
  };

  const initNotifications = async () => {
    if (
      settings.desktopNotificationsState === "default" ||
      notificationStateMismatch()
    ) {
      // Sloga Desktop: OS permission is implicit for installed apps; no test
      // notification and no web push (updates arrive over the WebSocket)
      if (tauriNotification()) {
        settings.desktopNotificationsState = "allowed";
        return;
      }

      // We do this before permission checking because the constructor will still work fine if we don't have permission.
      if (supportsNotification) {
        try {
          const noti = new Notification(
            "This is what notifications will look like. You shouldn't see this for long.",
            { silent: true },
          );
          // Close the notification just after showing
          // On very slow desktop systems, 100 ms just isn't long enough. Skill issue I guess.
          noti.addEventListener("show", () =>
            setTimeout(() => noti.close(), 100),
          );
        } catch {
          // An error means not supported.
          settings.desktopNotificationsState = "unsupported";
        }
      } else {
        settings.desktopNotificationsState = "unsupported";
      }

      if (supportsNotification) {
        if (await requestNotificationPermission()) {
          settings.desktopNotificationsState = "allowed";
          await enablePushSubscription();
        } else {
          await onDeny();
        }
      } else {
        await enablePushSubscription();
      }
    }
  };

  const toggleNotificationPermission = async (modalOnDeny?: boolean) => {
    if (settings.desktopNotificationsState !== "allowed") {
      if (await requestNotificationPermission()) {
        settings.desktopNotificationsState = "allowed";
      } else {
        await onDeny(modalOnDeny);
      }
    } else {
      settings.desktopNotificationsState = "denied";
    }
  };

  const enablePushSubscription = async () => {
    // "allowed" only after the subscription actually registered — flipping it
    // first left a session that looked subscribed but never was whenever the
    // registration hung or the app was killed mid-flow.
    try {
      await setUpServiceWorkerSubscription(getClient());
      settings.pushNotificationsState = "allowed";
    } catch (e) {
      console.error(e);
      snackbar.show({
        message: t`Failed to enable push notifications. Please try again later.`,
      });
      settings.pushNotificationsState = "default";
    }
  };

  /**
   * Re-register the native FCM subscription with the backend. Runs on every
   * logged-in launch: a session's subscription can be lost with no signal to
   * this device (the one-shot first-run flow failed or was interrupted, the
   * backend dropped it, the token changed) and the first-run flow never
   * retries — the session then silently misses every push, including
   * incoming-call rings. /push/subscribe overwrites the session's
   * subscription, so re-syncing is idempotent. No-op on desktop and when
   * the user has disabled push.
   *
   * Web: re-checks the browser's subscription against the server's current
   * VAPID key and re-subscribes on a mismatch (a key rotation otherwise
   * strands the old subscription forever). Only when permission is granted
   * and push is already on; never changes the push setting.
   */
  const resyncPushSubscription = async (): Promise<boolean> => {
    if (isWebPushPlatform()) return resyncWebPushSubscription();
    if (!PushTokenNative) return true;
    if (settings.pushNotificationsState === "denied") return true;
    try {
      await setUpServiceWorkerSubscription(getClient());
      settings.pushNotificationsState = "allowed";
      return true;
    } catch (e) {
      console.error("Push subscription re-sync failed", e);
      return false;
    }
  };

  const resyncWebPushSubscription = async (): Promise<boolean> => {
    const resyncAllowed = () =>
      shouldResyncWebPush({
        permission:
          "Notification" in window ? Notification.permission : "unsupported",
        pushState: settings.pushNotificationsState,
      }) && !webPushTurnedOff();
    if (!resyncAllowed()) return true;

    try {
      // Checked again once the lock is held: push may have been turned off
      // (and the subscription killed) while this waited for it
      await setUpServiceWorkerSubscription(getClient(), resyncAllowed);
      return true;
    } catch (e) {
      // Safari only lets subscribe() run inside a user gesture; hand the
      // retry to the next click (retryWebPushOnGesture).
      if (
        e instanceof DOMException &&
        e.name === "NotAllowedError" &&
        webPushGestureRetry === "idle"
      ) {
        webPushGestureRetry = "armed";
      }
      console.error("Web push subscription re-sync failed", e);
      return false;
    }
  };

  const togglePushPermission = async (modalOnDeny?: boolean) => {
    if (settings.pushNotificationsState !== "allowed") {
      if (supportsNotification && !Capacitor.isNativePlatform()) {
        if ((await Notification.requestPermission()) === "granted") {
          await enablePushSubscription();
        } else {
          await onDeny(modalOnDeny);
        }
      } else {
        // On safari mobile, just enable push notifications.
        await enablePushSubscription();
      }
    } else {
      settings.pushNotificationsState = "denied";
      await killServiceWorkerSubscription(getClient());
    }
  };

  return {
    toggleNotificationPermission,
    togglePushPermission,
    initNotifications,
    resyncPushSubscription,
    retryWebPushOnGesture,
  };
}

/**
 * One-shot Safari retry: "armed" when a launch re-sync's subscribe() was
 * refused for lack of a user gesture, "spent" once handed out, so a retry
 * that fails the same way can't re-arm itself on every later click.
 */
let webPushGestureRetry: "idle" | "armed" | "spent" = "idle";

/**
 * Whether the web push re-sync should run again from the next user gesture.
 * Reading it consumes the retry: true at most once per page load.
 */
function retryWebPushOnGesture(): boolean {
  if (webPushGestureRetry !== "armed") return false;
  webPushGestureRetry = "spent";
  return true;
}

/** Native bridge to fetch the FCM device token (Android app only) */
const PushTokenNative = Capacitor.isNativePlatform()
  ? registerPlugin<{
      getToken(): Promise<{ token: string }>;
      saveSubscription(opts: {
        apiUrl: string;
        sessionToken: string;
      }): Promise<void>;
      clearSubscription(): Promise<void>;
      canUseFullScreenIntent(): Promise<{
        allowed: boolean;
        applicable: boolean;
      }>;
      openFullScreenIntentSettings(): Promise<void>;
    }>("PushToken")
  : undefined;

/**
 * Whether push rides a browser service worker (VAPID web push): not the
 * Android app (FCM), not the Tauri or Electron desktop shells (no service
 * worker there).
 */
export function isWebPushPlatform(): boolean {
  return (
    !PushTokenNative &&
    !("__TAURI__" in window) &&
    !("slogaShell" in window) &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

/**
 * Whether incoming calls are currently unable to light up a locked screen.
 *
 * Android 14 grants USE_FULL_SCREEN_INTENT only to apps it classifies as
 * calling apps; for everyone else a full-screen intent is silently demoted to
 * a heads-up notification, so a call rings but the screen stays dark. The
 * toggle that fixes it is buried (and on some OEM skins effectively
 * unfindable), so the app has to offer it.
 *
 * False on every other platform and on Android 13 and below, where the
 * permission does not exist.
 */
export async function fullScreenCallAlertsBlocked(): Promise<boolean> {
  if (!PushTokenNative) return false;
  try {
    const { allowed, applicable } =
      await PushTokenNative.canUseFullScreenIntent();
    return applicable && !allowed;
  } catch {
    // Older shell without the method
    return false;
  }
}

/** Deep-link to the system screen that grants the permission above */
export function openFullScreenCallAlertSettings() {
  PushTokenNative?.openFullScreenIntentSettings().catch(console.error);
}

/**
 * @param gate Web only, re-checked under the lock; when false nothing is
 * subscribed or posted. Only the re-sync passes one: the enable flow must
 * never be gated.
 */
async function setUpServiceWorkerSubscription(
  client: Client,
  gate?: () => boolean,
) {
  // Sloga Desktop: no service worker in the bundled shell (slice 6.2b) —
  // push rides the WebSocket + native notifications instead. Throwing routes
  // the manual settings toggle into the existing failure snackbar/reset.
  if ("__TAURI__" in window) {
    throw "Web push is not supported in the desktop app";
  }

  // Native Android app: web push is unavailable in the WebView — register
  // the FCM device token as the push subscription instead.
  if (PushTokenNative) {
    const { token } = await PushTokenNative.getToken();
    await client.api.post("/push/subscribe", {
      endpoint: "fcm",
      p256dh: "",
      auth: token,
    });
    // Persist the API base + session token so the native FirebaseMessagingService
    // can re-subscribe on its own if FCM rotates the token while the app is
    // killed (onNewToken), instead of waiting for the next app launch.
    await PushTokenNative.saveSubscription({
      apiUrl: client.options.baseURL,
      sessionToken: client.authenticationHeader[1],
    });
    return;
  }

  if (!client.configured() || !client.configuration) {
    throw "Client not configured";
  }

  let registration = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL ?? undefined,
  );
  if (!registration) {
    // Register explicitly — the automatic vite-plugin-pwa registration relies
    // on an HMR event that doesn't always fire (e.g. through a tunnel).
    const swUrl = import.meta.env.DEV ? "/dev-sw.js?dev-sw" : "/serviceWorker.js";
    registration = await navigator.serviceWorker.register(swUrl, {
      scope: import.meta.env.BASE_URL ?? "/",
      type: "module",
    });
    await navigator.serviceWorker.ready;
  }

  const { pushManager } = registration;
  // Decoded to raw bytes: either base64 alphabet, padded or not
  const advertised = decodeVapidKey(client.configuration!.vapid);

  // Deliberately no permission/setting gate of its own: the enable flow marks
  // push "allowed" only after this returns, and must still get the key check.
  const syncSubscription = async () => {
    if (gate && !gate()) return;

    // Read inside the lock, so a second tab sees this tab's new subscription
    const existing = await pushManager.getSubscription();
    const plan = planWebPushSubscription({
      advertised,
      existing: !existing
        ? "none"
        : advertised
          ? compareSubscriptionKey(
              existing.options?.applicationServerKey,
              advertised,
            )
          : "unknown",
      // Only consulted when the browser doesn't expose the subscription's key
      markerMatches: advertised ? webPushKeyMarkerMatches(advertised) : null,
    });

    let subscription: PushSubscription;
    switch (plan) {
      case "invalid":
        throw "Server did not advertise a valid VAPID key";
      case "reuse":
        subscription = existing!;
        break;
      case "resubscribe":
      case "subscribe":
        // A subscription made with a different (rotated) key is dead weight:
        // the browser won't take a second key until the old one is gone.
        if (plan === "resubscribe") await existing!.unsubscribe();
        subscription = await pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: advertised!,
        });
        // Records the browser's key, not the server's copy: written even if
        // the POST below fails, so the next launch reuses and re-posts
        // instead of churning the subscription again
        writeWebPushKeyMarker(advertised!);
        break;
    }

    // Always re-posted: /push/subscribe overwrites, so this is idempotent
    await client.api.post("/push/subscribe", {
      endpoint: subscription.endpoint,
      p256dh: arrayBufferToBase64URL(
        subscription.getKey("p256dh") || new ArrayBuffer(),
      ),
      auth: arrayBufferToBase64URL(
        subscription.getKey("auth") || new ArrayBuffer(),
      ),
    });

    // Only a successful enable lifts a turn-off (see WEB_PUSH_OFF)
    if (!gate) setWebPushTurnedOff(false);
  };

  // One tab at a time, so two tabs can't unsubscribe each other's new
  // subscription mid-rotation
  if ("locks" in navigator) {
    await navigator.locks.request("sloga-webpush", syncSubscription);
  } else {
    await syncSubscription();
  }
}

/** Key the current web push subscription was made with (see keyMarker) */
const WEB_PUSH_KEY_MARKER = "sloga.webpush.vapidKey";

/** null when storage is unavailable (private mode, blocked site data) */
function webPushKeyMarkerMatches(advertised: Uint8Array): boolean | null {
  try {
    return localStorage.getItem(WEB_PUSH_KEY_MARKER) === keyMarker(advertised);
  } catch {
    return null;
  }
}

function writeWebPushKeyMarker(bytes: Uint8Array) {
  try {
    localStorage.setItem(WEB_PUSH_KEY_MARKER, keyMarker(bytes));
  } catch {
    // Storage unavailable: the next launch reuses the subscription as-is
  }
}

function clearWebPushKeyMarker() {
  try {
    localStorage.removeItem(WEB_PUSH_KEY_MARKER);
  } catch {
    // Storage unavailable: nothing was stored
  }
}

/**
 * Set whenever push is turned off in this browser (toggle, denied permission,
 * logout). Tabs don't share the push setting live, so another tab's re-sync
 * would trust its own stale "allowed" and subscribe again; only the enable
 * flow clears it, so the next person to log in can still turn push on.
 */
const WEB_PUSH_OFF = "sloga.webpush.off";

/** false when storage is unavailable: never block the re-sync on it */
function webPushTurnedOff(): boolean {
  try {
    return localStorage.getItem(WEB_PUSH_OFF) !== null;
  } catch {
    return false;
  }
}

function setWebPushTurnedOff(off: boolean) {
  try {
    if (off) localStorage.setItem(WEB_PUSH_OFF, "1");
    else localStorage.removeItem(WEB_PUSH_OFF);
  } catch {
    // Storage unavailable: other tabs go by their own setting
  }
}

function arrayBufferToBase64URL(buffer: ArrayBuffer): string {
  const intArray = new Uint8Array(buffer);
  // Todo: Upon upgrading the target of this repo, use Uint8Array.prototype.toBase64() instead of this.
  const binaryString = [...intArray.values()]
    .map((byte) => String.fromCodePoint(byte))
    .join("");
  const base64String = btoa(binaryString);
  return base64String
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Exported for the client controller. Don't use this unless you have to. */
export async function killServiceWorkerSubscription(
  client: Client,
  loggingOut?: boolean,
) {
  if (PushTokenNative) {
    if (!loggingOut) await client.api.post("/push/unsubscribe");
    // Drop stored credentials so a later token rotation can't re-register this
    // now logged-out / unsubscribed session.
    await PushTokenNative.clearSubscription();
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration(
    import.meta.env.BASE_URL ?? undefined,
  );
  if (!registration) {
    // Nothing to unsubscribe, but other tabs must still see push is off
    setWebPushTurnedOff(true);
    return;
  }

  const unsubscribe = async () => {
    // Set first, even with no subscription left or a failing unsubscribe: it
    // records the intent, and queued re-syncs check it once they get the lock
    setWebPushTurnedOff(true);
    // Read inside the lock: a re-sync may have just replaced it
    const subscription = await registration.pushManager.getSubscription();
    if (await subscription?.unsubscribe()) {
      clearWebPushKeyMarker();
      if (!loggingOut) await client.api.post("/push/unsubscribe");
    }
  };

  // Setup's lock: waits out a re-sync mid-rotation, so this unsubscribes the
  // new subscription instead of the one already on its way out
  if ("locks" in navigator) {
    await navigator.locks.request("sloga-webpush", unsubscribe);
  } else {
    await unsubscribe();
  }
}
