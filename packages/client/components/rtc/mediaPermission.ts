import { Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";

import type {
  MediaPermissionName,
  MediaPermissionState,
} from "./mediaAccessPolicy";

/**
 * Live microphone/camera permission state for a component, from the
 * Permissions API. Starts as `unknown`, settles once the query answers, and
 * follows later changes (the user answering a prompt, or flipping the site
 * setting) through the status object's `change` event. Re-queries if the
 * requested name changes.
 *
 * Engines that do not support querying these names (Firefox, Safari) reject
 * the query with a TypeError; that stays `unknown`, which the pickers treat as
 * "not granted yet" rather than as a denial.
 */
export function createMediaPermissionState(
  name: Accessor<MediaPermissionName>,
): Accessor<MediaPermissionState> {
  const [state, setState] = createSignal<MediaPermissionState>("unknown");

  createEffect(
    on(name, (current) => {
      let status: PermissionStatus | undefined;
      let disposed = false;
      const sync = () => {
        if (status) setState(status.state);
      };

      setState("unknown");
      (async () => {
        try {
          status = await navigator.permissions.query({
            name: current as PermissionName,
          });
        } catch {
          return;
        }
        if (disposed) return;
        status.addEventListener("change", sync);
        sync();
      })();

      onCleanup(() => {
        disposed = true;
        status?.removeEventListener("change", sync);
      });
    }),
  );

  return state;
}
