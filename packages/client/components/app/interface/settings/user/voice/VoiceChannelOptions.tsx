import { Trans } from "@lingui-solid/solid/macro";

import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";

/**
 * How a click on a voice channel in the channel list turns into a join.
 *
 * With the toggle on, a double-click joins the channel outright instead of
 * the two-step it replaces (open the channel, then press the call button in
 * the header). The single click is untouched either way — it still only
 * opens the channel — so turning this off restores the old behavior exactly.
 */
export function VoiceChannelOptions() {
  const { voice } = useState();

  return (
    <Column>
      <Text class="title">
        <Trans>Voice Channels</Trans>
      </Text>
      <CategoryButton.Group>
        {/* Checkbox is display-only: CategoryButton preventDefault()s the
            bubbled click, so the flip has to live in onClick. */}
        <CategoryButton
          icon="blank"
          description={
            <Trans>
              A single click still just opens the channel, the way it always
              has.
            </Trans>
          }
          action={<Checkbox checked={voice.joinVoiceOnDoubleClick} />}
          onClick={() =>
            (voice.joinVoiceOnDoubleClick = !voice.joinVoiceOnDoubleClick)
          }
        >
          <Trans>Double-click a voice channel to join it</Trans>
        </CategoryButton>
      </CategoryButton.Group>
    </Column>
  );
}
