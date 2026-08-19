import { Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";

import { CONFIGURATION } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  watchButtonVisible,
  watchCanStart,
} from "../watch/watchPolicy";

/**
 * "Watch together" for the call bar (plan §2). Behind the
 * `ENABLE_WATCH_TOGETHER` flag via `watchPolicy` — the single gate the
 * overlay and the player host share.
 *
 * Permission: `UseWatchTogether` in server channels (mirrored client-side
 * only to decide whether to SHOW the start affordance — the route is the
 * authority); DMs and group DMs do not consult the bit. A running session
 * shows the button to everyone (it opens the overlay / picker state).
 */
export function VoiceWatchButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const { t } = useLingui();
  const watch = voice.watch;

  const hasPermission = () => {
    const ch = voice.channel();
    if (!ch) return false;
    // DMs / groups: Connect-only server-side (remote-control table rule).
    if (!ch.serverId) return true;
    return ch.havePermission("UseWatchTogether");
  };
  const inputs = () => ({
    enabled: CONFIGURATION.ENABLE_WATCH_TOGETHER,
    connected: voice.state() === "CONNECTED",
    hasPermission: hasPermission(),
    hasSession: !!watch.session(),
  });

  return (
    <Show when={watchButtonVisible(inputs())}>
      <IconButton
        size={props.size}
        variant={watch.session() || watch.pickerOpen() ? "filled" : "tonal"}
        onPress={() => {
          if (watchCanStart(inputs())) watch.setPickerOpen(!watch.pickerOpen());
          // With a session running the overlay is already up; the button is
          // a visible "something is playing" marker rather than a toggle.
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: watch.session()
              ? t`Watching together`
              : t`Watch together — paste a YouTube link, everyone in the call stays in sync`,
          },
        }}
      >
        <Symbol>movie</Symbol>
      </IconButton>
    </Show>
  );
}
