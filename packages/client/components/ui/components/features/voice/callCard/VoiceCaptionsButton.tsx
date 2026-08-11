import { useLingui } from "@lingui-solid/solid/macro";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Live captions toggle for the call bar.
 *
 * Flips the same `captions:enabled` setting as Settings → Language; the
 * headless CaptionPublisher reacts to it mid-call, so this is a pure settings
 * write with no lifecycle of its own. Broadcasting never happens on an E2EE
 * call (CaptionPublisher fails closed), so rather than present a switch that
 * silently does nothing, the button disables itself and says why.
 */
export function VoiceCaptionsButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const state = useState();
  const { t } = useLingui();

  const enabled = () => !!state.settings.getValue("captions:enabled");

  // Mirror of CaptionPublisher's fail-closed gate: on an E2EE-capable call,
  // captions exist only when the mode is POSITIVELY plaintext ("off").
  const blocked = () =>
    voice.callE2EECapable() ? voice.callMode()?.kind !== "off" : false;

  const tooltip = () => {
    if (blocked()) return t`Captions aren't available on end-to-end encrypted calls`;
    if (enabled()) return t`Turn off live captions`;
    return t`Show live captions, translated into your chosen language`;
  };

  return (
    <IconButton
      size={props.size}
      variant={enabled() && !blocked() ? "filled" : "tonal"}
      isDisabled={blocked()}
      onPress={() => state.settings.setValue("captions:enabled", !enabled())}
      use:floating={{
        tooltip: { placement: "top", content: tooltip() },
      }}
    >
      <Symbol>closed_caption</Symbol>
    </IconButton>
  );
}
