import { Show, createEffect, createResource, createSignal, onCleanup } from "solid-js";

import { styled } from "styled-system/jsx";

import { translateLanguageName, translateText } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";

/**
 * Translated live caption overlaid on a participant tile. Reads the speaker's
 * latest transcript from the caption store and renders it translated into the
 * viewer's chosen caption language (via the existing free translation path).
 * Interim transcripts are debounced so we don't translate every keystroke.
 */
export function ParticipantCaption(props: { identity: string }) {
  const voice = useVoice();
  const state = useState();

  const enabled = () => !!state.settings.getValue("captions:enabled");
  const target = () =>
    (state.settings.getValue("captions:target") as string) || "en";

  const entry = () => voice.captions.entries.get(props.identity);

  // Debounce interim text; finalized utterances apply immediately.
  const [pending, setPending] = createSignal("");
  createEffect(() => {
    const current = entry();
    if (!enabled() || !current || !current.text.trim()) {
      setPending("");
      return;
    }
    if (current.isFinal) {
      setPending(current.text);
      return;
    }
    const handle = setTimeout(() => setPending(current.text), 450);
    onCleanup(() => clearTimeout(handle));
  });

  const [caption] = createResource(
    () => {
      const text = pending();
      if (!text) return null;
      return { text, target: target() };
    },
    async (input) => {
      const result = await translateText(input.text, input.target);
      // translateText returns null when already in the target language or on
      // error — fall back to the original transcript so something still shows.
      if (!result) return { text: input.text, original: null, source: null };
      return {
        text: result.text,
        original: input.text,
        source: translateLanguageName(result.detectedSource),
      };
    },
  );

  return (
    <Show when={enabled() && pending() && caption.latest}>
      <CaptionBar>
        <TranslatedText>{caption.latest!.text}</TranslatedText>
        <Show when={caption.latest!.original}>
          <OriginalLine>
            {caption.latest!.source}: {caption.latest!.original}
          </OriginalLine>
        </Show>
      </CaptionBar>
    </Show>
  );
}

const CaptionBar = styled("div", {
  base: {
    gridArea: "1/1",
    alignSelf: "end",
    justifySelf: "center",

    maxWidth: "92%",
    marginBottom: "34px",
    padding: "3px 10px",

    borderRadius: "6px",
    background: "rgba(0,0,0,0.66)",
    color: "#fff",
    fontSize: "13px",
    lineHeight: 1.35,
    textAlign: "center",
    wordBreak: "break-word",

    pointerEvents: "none",
    zIndex: 5,
  },
});

const TranslatedText = styled("div", {
  base: {
    // Bound the overlay so a long caption can't cover the tile/chrome.
    maxHeight: "4.4em",
    overflow: "hidden",
  },
});

const OriginalLine = styled("div", {
  base: {
    // Pre-translation transcript, one dimmed line under the translation.
    fontSize: "11px",
    color: "rgba(255,255,255,0.65)",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
    overflow: "hidden",
    maxWidth: "100%",
  },
});
