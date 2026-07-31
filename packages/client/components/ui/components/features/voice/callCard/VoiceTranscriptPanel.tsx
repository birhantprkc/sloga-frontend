import { For, Show, createMemo } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useUsers } from "@revolt/markdown/users";
import { useVoice } from "@revolt/rtc";
import { Text } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { participantUserId } from "../participantIdentity";

/**
 * The live transcript, and the only place it can be got out of the app.
 *
 * **It stays open after the call ends when there is something in it.** The
 * transcript exists only in this browser's memory, and a call can end without
 * warning — the network drops, the other side hangs up. If the panel vanished
 * with the call, so would the only route to Export. So the panel is shown
 * whenever transcription is running OR there is a transcript nobody has dealt
 * with yet, and Discard is the one control that throws it away.
 */
export function VoiceTranscriptPanel() {
  const voice = useVoice();
  const { t } = useLingui();

  const segments = () => voice.transcript.segments();
  const open = () => voice.transcribing() || segments().length > 0;

  // Resolve identities to names once for the whole list rather than per row.
  const identities = createMemo(() => [
    ...new Set(segments().map((segment) => segment.identity)),
  ]);
  const userIds = () => identities().map((id) => participantUserId(id));
  const users = useUsers(userIds);

  const nameFor = (identity: string) => {
    const index = identities().indexOf(identity);
    return users()[index]?.username ?? identity;
  };

  const names = () =>
    new Map(identities().map((identity) => [identity, nameFor(identity)]));

  return (
    <Show when={open()}>
      <Panel>
        <Header>
          <Text class="title">
            <Trans>Transcript</Trans>
          </Text>
          <Show when={voice.transcribing()}>
            <LiveDot title={t`Transcribing`} />
          </Show>
        </Header>

        <Lines>
          <For
            each={segments()}
            fallback={
              <Empty>
                <Trans>Nothing has been transcribed yet.</Trans>
              </Empty>
            }
          >
            {(segment) => (
              <Line>
                <Speaker>{nameFor(segment.identity)}</Speaker>
                <Said>{segment.text}</Said>
              </Line>
            )}
          </For>
        </Lines>

        <Actions>
          <Action
            onClick={() => void voice.copyTranscript(names())}
            title={t`Copy the transcript to the clipboard`}
          >
            <Symbol size={16}>content_copy</Symbol>
            <Trans>Copy</Trans>
          </Action>
          {/* Two files, because they answer different needs: .vtt loads as
              subtitles beside a recording of the same call, .txt is what
              people paste into notes. */}
          <Action
            onClick={() => void voice.exportTranscript("txt", names())}
            title={t`Save the transcript as a text file`}
          >
            <Symbol size={16}>download</Symbol>
            .txt
          </Action>
          <Action
            onClick={() => void voice.exportTranscript("vtt", names())}
            title={t`Save the transcript as subtitles`}
          >
            <Symbol size={16}>download</Symbol>
            .vtt
          </Action>
          <Show when={!voice.transcribing() && segments().length > 0}>
            <Action
              onClick={() => voice.transcript.discard()}
              title={t`Throw this transcript away`}
            >
              <Symbol size={16}>delete</Symbol>
              <Trans>Discard</Trans>
            </Action>
          </Show>
        </Actions>
      </Panel>
    </Show>
  );
}

const Panel = styled("div", {
  base: {
    position: "absolute",
    // Below the roster panel's corner so the two never sit on top of one
    // another when both are open.
    bottom: "var(--gap-lg)",
    right: "var(--gap-lg)",
    zIndex: 6,
    width: "min(320px, calc(100% - 2 * var(--gap-lg)))",
    maxHeight: "60%",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-highest)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

const LiveDot = styled("span", {
  base: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "var(--md-sys-color-error)",
    animation: "voiceRecordingPulse 2s ease-in-out infinite",
    "@media (prefers-reduced-motion: reduce)": { animation: "none" },
  },
});

const Lines = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    overflowY: "auto",
    minHeight: 0,
  },
});

const Line = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const Speaker = styled("span", {
  base: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Said = styled("span", {
  base: {
    fontSize: "0.875rem",
    color: "var(--md-sys-color-on-surface)",
    wordBreak: "break-word",
  },
});

const Empty = styled("span", {
  base: {
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const Action = styled("button", {
  base: {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    border: "none",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "var(--borderRadius-md)",
    fontSize: "0.8125rem",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    _hover: { background: "var(--md-sys-color-surface-container)" },
  },
});
