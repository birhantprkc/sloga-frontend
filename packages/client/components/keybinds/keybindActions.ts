import { ReactiveSet } from "@solid-primitives/set";

import { keybindsSuppressed } from "./suppress";

export enum KeybindAction {
  /**
   * Navigate to channel above current channel
   */
  NAVIGATION_CHANNEL_UP = "navigation_channel_up",

  /**
   * Navigate to channel below current channel
   */
  NAVIGATION_CHANNEL_DOWN = "navigation_channel_down",

  /**
   * Navigate to server above current server
   */
  NAVIGATION_SERVER_UP = "navigation_server_up",

  /**
   * Navigate to server below current server
   */
  NAVIGATION_SERVER_DOWN = "navigation_server_down",

  /**
   * Mark channel as read, jump to the end of conversation, and focus composition
   */
  CHAT_JUMP_END = "chat_jump_end",

  /**
   * Mark server as read
   */
  CHAT_MARK_SERVER_AS_READ = "chat_mark_server_as_read",

  /**
   * Focus the message composition
   */
  CHAT_FOCUS_COMPOSITION = "chat_focus_composition",

  /**
   * Remove attachment or reply from message composition
   */
  CHAT_REMOVE_COMPOSITION_ELEMENT = "chat_remove_composition_element",

  /**
   * Cancel editing the current message
   */
  CHAT_CANCEL_EDITING = "chat_cancel_editing",

  /**
   * Close the currently active modal
   */
  CLOSE_MODAL = "close_modal",

  /**
   * Close the currently floating element
   */
  CLOSE_FLOATING = "close_floating",

  /**
   * Close the open and ephemeral sidebar
   */
  CLOSE_SIDEBAR = "close_sidebar",
}

/**
 * Priority of actions relative to each other
 */
export const ACTION_PRIORITY: KeybindAction[] = [
  // 'Escape' bindings
  KeybindAction.CLOSE_FLOATING,
  KeybindAction.CLOSE_MODAL,
  KeybindAction.CLOSE_SIDEBAR,
  KeybindAction.CHAT_CANCEL_EDITING,
  KeybindAction.CHAT_REMOVE_COMPOSITION_ELEMENT,
  KeybindAction.CHAT_MARK_SERVER_AS_READ,
  KeybindAction.CHAT_JUMP_END,

  // Navigation conflicts
  KeybindAction.NAVIGATION_SERVER_UP,
  KeybindAction.NAVIGATION_SERVER_DOWN,
  KeybindAction.NAVIGATION_CHANNEL_UP,
  KeybindAction.NAVIGATION_CHANNEL_DOWN,

  // ... all others
  KeybindAction.CHAT_FOCUS_COMPOSITION,
];

/**
 * Membership of the `'Escape' bindings` block of `ACTION_PRIORITY`.
 *
 * The block boundary above is a comment, which is not machine readable, so
 * membership is listed explicitly here while the *order* is still taken from
 * `ACTION_PRIORITY` (see `ESCAPE_GROUP`). Keep the two in sync: adding an
 * Escape-driven action to `ACTION_PRIORITY` without adding it here silently
 * leaves it out of `dismissTopmost()`.
 */
const ESCAPE_GROUP_MEMBERS: ReadonlySet<KeybindAction> = new Set([
  KeybindAction.CLOSE_FLOATING,
  KeybindAction.CLOSE_MODAL,
  KeybindAction.CLOSE_SIDEBAR,
  KeybindAction.CHAT_CANCEL_EDITING,
  KeybindAction.CHAT_REMOVE_COMPOSITION_ELEMENT,
  KeybindAction.CHAT_MARK_SERVER_AS_READ,
  KeybindAction.CHAT_JUMP_END,
]);

/**
 * The `'Escape' bindings` group of `ACTION_PRIORITY`, in priority order.
 */
export const ESCAPE_GROUP: KeybindAction[] = ACTION_PRIORITY.filter((keybind) =>
  ESCAPE_GROUP_MEMBERS.has(keybind),
);

/**
 * Escape-group actions that are NOT dismissals, and so must never be selected
 * by a programmatic "close the topmost overlay" request.
 *
 * # Why this exclusion exists
 *
 * `dismissTopmost()` deliberately does not go through `firing()`, so it has no
 * key sequence to filter on — priority order alone selects. That changes what
 * these two actions mean:
 *
 * - `CHAT_MARK_SERVER_AS_READ` is `Shift+Escape`, and it is bound
 *   **unconditionally** for the whole life of `ServerSidebar`. Under a real
 *   Escape it is never selected, because the sequence filter rejects it unless
 *   Shift is held. Without that filter it is the *highest priority bound
 *   action in the group* any time a server is open — so a back press with
 *   nothing open would ack the entire server. It also dismisses nothing.
 * - `CHAT_JUMP_END` is bound unconditionally by both `TextChannel` and
 *   `Composition`, so it is live in every text channel. It acks the channel,
 *   clears the unread divider and scrolls to the bottom — again, not a
 *   dismissal, and it would make `dismissTopmost()` return `true` in a plain
 *   channel with nothing open, starving the caller's fallback (history back /
 *   exit) of the `false` it needs.
 *
 * Both remain fully driven by Escape; only the programmatic path skips them.
 */
const NOT_A_DISMISSAL: ReadonlySet<KeybindAction> = new Set([
  KeybindAction.CHAT_MARK_SERVER_AS_READ,
  KeybindAction.CHAT_JUMP_END,
]);

/**
 * Actions `dismissTopmost()` walks, in priority order: the Escape group minus
 * the actions that do not dismiss anything.
 */
export const DISMISSAL_PRIORITY: KeybindAction[] = ESCAPE_GROUP.filter(
  (keybind) => !NOT_A_DISMISSAL.has(keybind),
);

/**
 * Filter keybinds with special logic
 * @param keybind Keybind to filter
 * @param currentlyBound Other keybinds currently bound
 * @returns Whether to include this keybind
 */
export function keybindFilter(
  keybind: KeybindAction,
  activeKeys: ReactiveSet<string>,
  currentlyBound: Record<KeybindAction, number>,
  target: HTMLElement | null,
) {
  // FIRST, before every other branch, and returning false for EVERY keybind:
  // while a remote-control capture surface is live the keyboard belongs to
  // the machine being controlled, not to this client. Placed here rather
  // than relying on `stopPropagation` at the capture surface, because
  // keyboard events target `document.activeElement` — one click on the call
  // chrome, or the tile remounting on a focus toggle, and the capture div is
  // no longer in the event path while these `document.body` listeners still
  // are. See `./suppress` for why it is unconditional rather than scoped to
  // CHAT_FOCUS_COMPOSITION.
  if (keybindsSuppressed()) return false;

  if (keybind === KeybindAction.CHAT_FOCUS_COMPOSITION) {
    // don't allow focusing if modal/floating is open
    // or if we're editing a message
    if (
      currentlyBound[KeybindAction.CLOSE_FLOATING] ||
      currentlyBound[KeybindAction.CLOSE_MODAL] ||
      currentlyBound[KeybindAction.CHAT_CANCEL_EDITING]
    )
      return false;

    // don't allow focusing if another input element is currently being typed into
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target?.nodeName === "MDUI-TEXT-FIELD"
    )
      return false;

    // don't allow focusing if modifier key is pressed... except for paste
    if (
      (activeKeys.has("Control") || activeKeys.has("Meta")) &&
      !(activeKeys.has("v") || activeKeys.has("a"))
    )
      return false;
  }

  return true;
}
