/**
 * Where the unread badge goes, per platform.
 *
 * Four different mechanisms and one non-mechanism:
 *
 * | host              | surface                  | how                          |
 * | ----------------- | ------------------------ | ---------------------------- |
 * | Tauri (Win/macOS) | taskbar button, tray     | `set_unread_badge` (badge.rs)|
 * | Electron (Linux)  | launcher entry           | `slogaShell.badge.set`       |
 * | web, installed    | taskbar/dock icon        | `navigator.setAppBadge`      |
 * | web, plain tab    | the tab itself           | `document.title`             |
 * | Android           | —                        | the launcher counts the      |
 * |                   |                          | notifications, not us        |
 *
 * The count itself is decided in `unreadBadge.ts`, which is pure and has the
 * spec; nothing here does arithmetic.
 */
import { tauriInvoke } from "@revolt/common";

import { type UnreadBadge, titleForBadge } from "./unreadBadge";

/** The Electron shell's launcher-badge verb, when we are inside it. */
function electronBadge(): { set(count: number): void } | undefined {
  return (window as { slogaShell?: { badge?: { set(count: number): void } } })
    .slogaShell?.badge;
}

/**
 * Hand the badge to whatever shell is hosting us.
 *
 * Every platform call here is fire-and-forget. This runs off a reactive effect
 * on every unread change, and none of these surfaces has a failure the app can
 * act on: the Linux launcher may not implement badges at all, and a webview
 * that refuses the overlay icon has still delivered the message itself. A
 * rejection is logged once, never retried — a retry loop on a platform that
 * structurally cannot do this would run for the life of the session.
 *
 * The title is set on every host, not only the web one. A desktop window has a
 * title bar and an alt-tab entry too, and on a plain browser tab it is the only
 * badge there is.
 */
export function publishUnreadBadge(badge: UnreadBadge): void {
  if (typeof window === "undefined") return;

  // The live title is the base: `titleForBadge` strips any prefix already on
  // it, which is what keeps repeated updates from stacking `(3) (5) Sloga`.
  document.title = titleForBadge(document.title, badge.count);

  const invoke = tauriInvoke();
  if (invoke) {
    invoke("set_unread_badge", {
      count: badge.count,
      mention: badge.mention,
    }).catch((err) =>
      // An older shell has no such command. Logged rather than swallowed: a
      // missing ACL grant looks exactly like this, and that one is a bug.
      console.error("[unread-badge] set_unread_badge failed:", err),
    );
    return;
  }

  const electron = electronBadge();
  if (electron) {
    electron.set(badge.count);
    return;
  }

  // Web: the Badging API, which reaches the taskbar/dock only for an installed
  // PWA and is absent in Firefox and Safari. The title above is what the rest
  // of the web gets.
  const nav = navigator as Navigator & {
    setAppBadge?(count?: number): Promise<void>;
    clearAppBadge?(): Promise<void>;
  };
  if (badge.count > 0) {
    nav.setAppBadge?.(badge.count).catch(() => {});
  } else {
    nav.clearAppBadge?.().catch(() => {});
  }
}
