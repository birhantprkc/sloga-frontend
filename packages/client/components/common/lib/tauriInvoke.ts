/**
 * The Tauri command bridge, when running inside the Windows desktop shell.
 *
 * This existed as three byte-identical private copies (the friends popout
 * opener, native notifications, and remote control) before the voice overlay
 * would have made it four. It is a five-line function, so the duplication was
 * never the cost — the cost is that the SHAPE of the check is a decision:
 * `__TAURI__.core.invoke` is present only when `withGlobalTauri` is on and the
 * window's capability file exists, so this doubles as "am I a Tauri window
 * that is allowed to talk to the shell at all". A copy that drifts from that
 * (checking `__TAURI__` alone, say) reads as available in windows where every
 * call will ACL-fail.
 *
 * Returns undefined on web, on Android, and in the Electron shell — callers
 * fall back to their own path (`window.slogaShell.*`, a browser popup, or
 * nothing).
 */
export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function tauriInvoke(): TauriInvoke | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window as {
      __TAURI__?: {
        core?: {
          invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
        };
      };
    }
  ).__TAURI__?.core?.invoke;
}
