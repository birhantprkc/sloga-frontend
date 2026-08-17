import { Trans } from "@lingui-solid/solid/macro";

import { Column, Text } from "@revolt/ui";

import { CameraOptions } from "./CameraOptions";
import { VideoInputOptions } from "./VoiceInputOptions";

/**
 * Video page: camera device, live preview, brightness, quality, filters and
 * background effects, plus screen-share quality. Split out of the old
 * "Voice & Video" page; the sidebar entry is hidden when the build has video
 * disabled, so this never renders an empty page.
 */
export function VideoSettings() {
  return (
    <Column gap="lg">
      <Column>
        <Text class="title">
          <Trans>Camera</Trans>
        </Text>
        <VideoInputOptions />
      </Column>
      <CameraOptions />
    </Column>
  );
}
