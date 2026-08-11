import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useUsers } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { participantUserId } from "../participantIdentity";

/**
 * Whisper status, both directions, as undismissable chips in the banner
 * stack (same posture as the recording chip: a private side-channel in a
 * group call is a fact everyone party to it must stay aware of — the sender
 * because their mic is doing something unusual, the receiver because a voice
 * only they can hear reads as a bug or a haunting otherwise).
 *
 * The sender chip is a control too: clicking it ends the whisper, because
 * hunting for the context menu again while accidentally narrating your aside
 * to the wrong audience is the failure mode that matters.
 */
export function VoiceCallWhisperBanner() {
  const voice = useVoice();

  const targetUsers = useUsers(() => {
    const target = voice.whisper.target();
    return target ? [target] : [];
  });
  const targetName = () => targetUsers()[0]?.username;

  const senderUsers = useUsers(() => {
    const identity = voice.incomingWhisperFrom();
    return identity ? [participantUserId(identity)] : [];
  });
  const senderName = () => senderUsers()[0]?.username;

  return (
    <>
      <Show when={voice.whisper.target()}>
        <WhisperChip
          type="button"
          onClick={() => void voice.stopWhisper()}
          title="Stop whispering"
        >
          <Symbol size={14}>hearing</Symbol>
          <Trans>Whispering to {targetName()} — only they hear you</Trans>
          <Symbol size={14}>close</Symbol>
        </WhisperChip>
      </Show>
      <Show when={voice.incomingWhisperFrom()}>
        <WhisperBadge>
          <Symbol size={14}>hearing</Symbol>
          <Trans>{senderName()} is whispering to you</Trans>
        </WhisperBadge>
      </Show>
    </>
  );
}

// Chip-shaped like the recording residue (see VoiceCallRecordingBanner), but
// on the primary palette: a whisper is a feature working as intended, not an
// alarm. Two elements sharing one look because panda's styled() is not
// polymorphic: the sender chip is a real <button> (it stops the whisper),
// the receiver badge is inert.
// Style duplicated literally in both (NOT shared via a spread const): panda
// extracts styles statically, and a spread can silently produce no CSS.
const WhisperChip = styled("button", {
  base: {
    alignSelf: "flex-start",
    marginInlineStart: "var(--gap-md)",

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "2px var(--gap-md)",
    fontSize: "0.6875rem",
    fontWeight: 700,
    whiteSpace: "nowrap",
    border: "none",
    cursor: "pointer",

    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
    borderRadius: "var(--borderRadius-full)",
  },
});

const WhisperBadge = styled("div", {
  base: {
    alignSelf: "flex-start",
    marginInlineStart: "var(--gap-md)",

    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",

    padding: "2px var(--gap-md)",
    fontSize: "0.6875rem",
    fontWeight: 700,
    whiteSpace: "nowrap",

    background: "var(--md-sys-color-primary-container)",
    color: "var(--md-sys-color-on-primary-container)",
    borderRadius: "var(--borderRadius-full)",
  },
});
