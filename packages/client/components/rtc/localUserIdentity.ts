import { createEffect } from "solid-js";

/**
 * The only part of the client this wiring reads. Declared structurally so
 * the unit spec can drive it without constructing a real `Client` — which
 * is the whole point of the file existing.
 */
export type LocalUserSource = {
  /** Reactive: false until the Ready packet lands, and again per connect. */
  ready: () => boolean;
  /** NOT reactive — a plain field on the client. */
  user?: { id: string };
};

/**
 * Keep native told which account this device is signed in as.
 *
 * Depends on `ready()`, NOT on `user`. `Client.user` is a plain field, so
 * reading it inside an effect registers no dependency, and the accessor
 * returning the client is not reactive either. On a cold start the client
 * object already exists before the Ready packet lands, so the first run
 * reads `undefined` — and with nothing tracked, the effect never runs
 * again. The id then stays unset for the life of the process, and because
 * both handshake commands fail CLOSED on an unset id, every give-control
 * attempt is refused with "control session identity does not match this
 * device's account" and nothing on screen says so.
 *
 * `ready()` is the signal set inside the same Ready handler that assigns
 * `user`, immediately before the `ready` event is emitted, so by the time
 * this re-runs the id is there. It resets on each connect, so a reconnect
 * re-asserts the identity rather than assuming native still holds it.
 *
 * Extracted from the `Voice` constructor so it can be tested at all. The
 * two-instance harness cannot catch this class of bug by construction: it
 * calls `e2ee_rc_set_local_user` itself as its first step, so a scripted
 * end-to-end run sets by hand precisely the thing the product forgot.
 */
export function watchLocalUserId(
  client: () => LocalUserSource | undefined,
  setLocalUser: (userId: string) => void,
) {
  createEffect(() => {
    const current = client();
    if (!current?.ready()) return;
    const selfId = current.user?.id;
    if (selfId) setLocalUser(selfId);
  });
}
