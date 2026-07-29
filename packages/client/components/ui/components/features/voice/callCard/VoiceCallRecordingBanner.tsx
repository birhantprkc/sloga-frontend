import { Show } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useUsers } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { Button } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * "This call is being recorded."
 *
 * Two tiers, and the split is the whole design:
 *
 * - The **banner** is the loud one. It names who is recording and can be
 *   dismissed, because a permanent strip over the video for a two-hour
 *   recording is the kind of thing people learn to route around.
 * - The **chip** is what dismissing collapses to, and it CANNOT be dismissed.
 *   A notice that can be cleared to nothing lets someone forget mid-call and
 *   makes the disclosure weaker than the recording is long. So dismissal
 *   shrinks the notice; it never removes it.
 *
 * Both render for a recording that started before this user joined, because
 * they read `recordersInCall()`, which is derived from the roster rather than
 * from a start event nobody replayed for the late joiner.
 *
 * ## What the copy may and may not claim
 *
 * It says a participant *told us* they are recording. It must never imply the
 * converse — that no banner means nobody is recording. Any participant can run
 * a screen recorder or point a phone at the screen, media E2EE means the
 * decrypted audio is in every participant's client by design, and nothing here
 * detects any of that. The wording is therefore about what someone declared,
 * never about what is technically possible, and "Leave call" is offered because
 * leaving is the only actual remedy this UI can give.
 */
export function VoiceCallRecordingBanner() {
  const voice = useVoice();
  const { t } = useLingui();

  const recorders = () => voice.recordersInCall();
  const undismissed = () => voice.undismissedRecorders();

  const users = useUsers(recorders);
  const names = () =>
    users()
      .map((user) => user?.username)
      .filter((name): name is string => !!name);

  /** Whether the local user is one of the recorders. */
  const selfRecording = () => voice.recording();

  return (
    <Show when={recorders().length}>
      <Show
        when={undismissed().length}
        fallback={
          /* Dismissed: the notice shrinks to this, and there is no control to
             remove it. */
          <Chip>
            <Symbol size={14}>fiber_manual_record</Symbol>
            <Trans>Recording</Trans>
          </Chip>
        }
      >
        <Banner>
          <Symbol size={18}>fiber_manual_record</Symbol>
          <Text>
            <Show
              when={!selfRecording()}
              fallback={
                <Trans>
                  You are recording this call. Everyone in the call has been
                  told.
                </Trans>
              }
            >
              <Show
                when={names().length}
                fallback={
                  <Trans>
                    Someone in this call said they are recording it.
                  </Trans>
                }
              >
                <Trans>
                  {names().join(", ")} said they are recording this call.
                </Trans>
              </Show>
            </Show>
          </Text>
          <Actions>
            <Button
              size="sm"
              variant="text"
              onPress={() => voice.dismissRecordingBanner()}
            >
              {t`Hide`}
            </Button>
            <Show when={!selfRecording()}>
              <Button
                size="sm"
                variant="text"
                onPress={() => voice.disconnect()}
              >
                <Trans>Leave call</Trans>
              </Button>
            </Show>
          </Actions>
        </Banner>
      </Show>
    </Show>
  );
}

// Positioned by `<TopBanners>` — see the note in VoiceCallDowngradeBanner.
const Banner = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--gap-md)",

    padding: "var(--gap-md) var(--gap-lg)",
    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
    borderRadius: "var(--borderRadius-lg) var(--borderRadius-lg) 0 0",
  },
});

/**
 * The undismissable residue. Deliberately small and quiet, but always in the
 * same place so it reads as a status light rather than a notification.
 *
 * `alignSelf: flex-start` keeps it pill-sized inside the banner stack instead
 * of stretching to full width like a strip.
 */
const Chip = styled("div", {
  base: {
    alignSelf: "flex-start",
    marginInlineStart: "var(--gap-md)",

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "2px var(--gap-md)",
    fontSize: "0.6875rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",

    background: "var(--md-sys-color-error-container)",
    color: "var(--md-sys-color-on-error-container)",
    borderRadius: "var(--borderRadius-full)",
  },
});

const Text = styled("div", {
  base: {
    flex: 1,
    minWidth: "180px",
    fontSize: "0.8125rem",
    fontWeight: 500,
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    flexShrink: 0,

    "& button": {
      background: "var(--md-sys-color-surface)",
      "--color": "currentColor",
    },
  },
});
