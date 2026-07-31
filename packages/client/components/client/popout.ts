/**
 * Whether this window is the detachable friends popout — FROZEN at module
 * init, i.e. at window boot. Window identity must NOT follow later SPA
 * navigation: the E2EE engine attach (Controller construction) and the
 * per-window worker gates are boot-time decisions, and a live pathname
 * check would let them disagree with each other if the window ever
 * navigates away from the popout route. `Interface` additionally bounces
 * any such navigation straight back, so a popout window can never host
 * the full app shell.
 *
 * `startsWith` (not equality) so a trailing slash or sub-path spelling
 * from a shell can't silently flip a popout window back to full-client.
 */
export const IS_POPOUT_WINDOW: boolean =
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/friends-popout");

/**
 * Whether this window is the in-game voice overlay — FROZEN at module init
 * for exactly the same reasons as {@link IS_POPOUT_WINDOW} above.
 *
 * The overlay goes FURTHER than the popout: the popout is a lean second
 * client (it deliberately keeps its own WebSocket), while the overlay is a
 * PASSIVE RENDERER with no client at all. It draws whatever arrives on the
 * `sloga:voice-overlay` BroadcastChannel and owns nothing — no session, no
 * WebSocket, no LiveKit room. That is not an optimisation: one identity can
 * hold exactly one room membership, so a second LiveKit join is impossible,
 * and speaking state has exactly one source (the window that owns the
 * `Room`). A relay is the only correct shape.
 *
 * Consequence for anything rendered under this flag: the provider stack is
 * SHORT-CIRCUITED (see `MountContext` in src/index.tsx), so there is no
 * I18nProvider, ModalContext, KeybindContext or SnackbarProvider. A lingui
 * macro in an overlay component throws at runtime and NEITHER tsc NOR the
 * extractor catches it — overlay strings stay plain.
 */
export const IS_OVERLAY_WINDOW: boolean =
  typeof window !== "undefined" &&
  window.location.pathname.startsWith("/voice-overlay");
