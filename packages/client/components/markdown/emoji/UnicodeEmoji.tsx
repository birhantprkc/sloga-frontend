import { ComponentProps, splitProps } from "solid-js";

import emojiRegex from "emoji-regex";

import { CONFIGURATION } from "@revolt/common";
import { useState } from "@revolt/state";
import { EmojiBase, toCodepoint } from ".";

// openmoji is off due to incomplete implementation

export type UnicodeEmojiPacks =
  | "fluent-3d"
  | "fluent-color"
  | "fluent-flat"
  | "mutant"
  | "noto"
  //  | "openmoji"
  | "twemoji";

export const UNICODE_EMOJI_PACKS: UnicodeEmojiPacks[] = [
  "fluent-3d",
  "fluent-color",
  "fluent-flat",
  "mutant",
  "noto",
  //  "openmoji",
  "twemoji",
];

export const UNICODE_EMOJI_PACK_PUA: Record<string, string> = {
  // omit fluent-3d as it is the default (canonically \uE0E1)
  "fluent-flat": "\uE0E2",
  mutant: "\uE0E3",
  noto: "\uE0E4",
  //  openmoji: "\uE0E5",
  twemoji: "\uE0E6",
};

/**
 * Regex for matching emoji
 */
export const RE_UNICODE_EMOJI = new RegExp(
  "([\uE0E0-\uE0E6]?(?:" + emojiRegex().source + "))",
  "g",
);

export const UNICODE_EMOJI_MIN_PACK = "\uE0E0".codePointAt(0)!;
export const UNICODE_EMOJI_MAX_PACK = "\uE0E6".codePointAt(0)!;

export const UNICODE_EMOJI_PUA_PACK: Record<string, UnicodeEmojiPacks> = {
  ["\uE0E0"]: "fluent-3d", // default entry
  ["\uE0E1"]: "fluent-3d",
  ["\uE0E2"]: "fluent-flat",
  ["\uE0E3"]: "mutant",
  ["\uE0E4"]: "noto",
  //  ["\uE0E5"]: "openmoji",
  ["\uE0E6"]: "twemoji",
};

/**
 * Prefix that tells readers which pack an emoji the app inserted should be
 * drawn from. The default pack is canonically unmarked, hence the empty
 * string.
 * @param pack Pack the sender has chosen
 * @returns Marker to put in front of the emoji
 */
export const unicodeEmojiPackPrefix = (pack?: string) =>
  UNICODE_EMOJI_PACK_PUA[pack!] ?? "";

export const startsWithPackPUA = (emoji: string) => {
  if (emoji.startsWith(":")) return false;
  if (emoji.slice(0, 1).match("[\uE0E0-\uE0E6]")) return true;

  return false;
};

export function unicodeEmojiUrl(
  pack: UnicodeEmojiPacks = "fluent-3d",
  text: string,
) {
  // The packs name their files WITHOUT the U+FE0F presentation selector
  // ("270f.svg", never "270f-fe0f.svg"), including inside ZWJ sequences —
  // probed on all six packs 2026-08-17. Text such as "✏️" or "🎚️" carries
  // FE0F, so leaving it in produced a 404 and a broken-image glyph.
  const codepoint = toCodepoint(text.replace(/\uFE0F/g, ""));
  return `${CONFIGURATION.DEFAULT_EMOJI_URL}/${pack}/${codepoint}.svg?v=1`;
}

/**
 * Display Unicode emoji
 */
export function UnicodeEmoji(
  props: { emoji: string; pack?: UnicodeEmojiPacks } & Omit<
    ComponentProps<typeof EmojiBase>,
    "loading" | "class" | "alt" | "draggable" | "src"
  >,
) {
  const [local, remote] = splitProps(props, ["emoji"]);
  const state = useState();

  return (
    <EmojiBase
      {...remote}
      loading="lazy"
      class="emoji"
      alt={local.emoji}
      draggable={false}
      src={unicodeEmojiUrl(
        props.pack ?? state.settings.getValue("appearance:unicode_emoji"),
        props.emoji,
      )}
    />
  );
}
