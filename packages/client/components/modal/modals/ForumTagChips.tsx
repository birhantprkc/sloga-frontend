import { For, Show } from "solid-js";

import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { TextWithEmoji } from "@revolt/markdown";

type ForumTag = Channel["tags"][number];

/** Server-enforced cap on tags per post (`MAX_APPLIED_TAGS` in delta) */
export const MAX_APPLIED_TAGS = 5;

/**
 * A tag's emoji and name. Both go through `TextWithEmoji`, so a server emoji
 * (stored as `:id:`) draws as its image instead of as that text, and a
 * Unicode emoji draws in the reader's chosen pack, the same as in chat.
 */
export function ForumTagLabel(props: { tag: ForumTag }) {
  return (
    <>
      <Show when={props.tag.emoji}>
        <TextWithEmoji content={props.tag.emoji} />{" "}
      </Show>
      <TextWithEmoji content={props.tag.name} />
    </>
  );
}

/**
 * Toggleable tag chips, shared by the new-post and edit-tags dialogs
 */
export function ForumTagChips(props: {
  tags: ForumTag[];
  selected: string[];
  onToggle: (id: string) => void;
  /** Applied tags this member may see but not remove (moderated ones) */
  locked?: (tag: ForumTag) => boolean;
}) {
  return (
    <TagRow>
      <For each={props.tags}>
        {(tag) => (
          <TagChip
            type="button"
            selected={props.selected.includes(tag.id)}
            aria-pressed={props.selected.includes(tag.id)}
            disabled={props.locked?.(tag)}
            onClick={() => props.onToggle(tag.id)}
          >
            <ForumTagLabel tag={tag} />
          </TagChip>
        )}
      </For>
    </TagRow>
  );
}

const TagRow = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const TagChip = styled("button", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    fontSize: "0.8125rem",
    transition: "var(--transitions-fast) all",

    _disabled: {
      cursor: "default",
      opacity: 0.7,
    },
  },
  variants: {
    selected: {
      true: {
        background: "var(--md-sys-color-primary-container)",
        color: "var(--md-sys-color-on-primary-container)",
      },
    },
  },
});
