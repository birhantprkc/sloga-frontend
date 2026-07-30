import { Match, Show, Switch } from "solid-js";

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
             remove it.

             It NAMES the recorder rather than saying a bare "Recording". This
             is the state a call spends most of its time in once someone hides
             the banner, so it is the line most people will actually read — and
             "who" is the part that matters. Self-recording says "You are"
             instead of echoing your own name back at you. */
          <Chip>
            <Symbol size={14}>fiber_manual_record</Symbol>
            <Switch fallback={<Trans>Recording</Trans>}>
              <Match when={selfRecording() && names().length <= 1}>
                <Trans>You are recording</Trans>
              </Match>
              <Match when={names().length === 1}>
                <Trans>{names()[0]} is recording</Trans>
              </Match>
              <Match when={names().length > 1}>
                <Trans>{names().length} people are recording</Trans>
              </Match>
            </Switch>
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
              {/* Stated as fact, and matched word-for-word to the pre-join
                  card: the same fact told twice in two different phrasings
                  reads as a bug and invites the reader to wonder which one is
                  the real claim. Honest for the reason given on that card —
                  the flag can only over-report, and nothing here implies the
                  absence of a banner means nobody is recording.

                  Count-branched, not name-joined: "is" makes a joined list
                  ungrammatical, and at two or more the identities are in the
                  roster panel while the fact that matters here is that it is
                  happening. */}
              <Switch
                fallback={
                  <Trans>Someone in this call is recording audio.</Trans>
                }
              >
                <Match when={names().length === 1}>
                  <Trans>{names()[0]} is recording audio.</Trans>
                </Match>
                <Match when={names().length > 1}>
                  <Trans>{names().length} people are recording audio.</Trans>
                </Match>
              </Switch>
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
    // NO `textTransform: uppercase` (and no letter-spacing): the chip now
    // carries a display name, and upper-casing it would render "JEFFS IS
    // RECORDING" — destroying casing the user chose deliberately, and mangling
    // names in scripts that have no case at all.
    whiteSpace: "nowrap",

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
