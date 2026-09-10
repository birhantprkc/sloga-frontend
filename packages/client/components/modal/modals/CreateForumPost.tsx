import { For, Match, Show, Switch, createSignal } from "solid-js";

import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useNavigate } from "@revolt/routing";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to create a new post in a forum channel
 */
export function CreateForumPostModal(
  props: DialogProps & Modals & { type: "create_forum_post" },
) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { showError } = useModals();

  const [selectedTags, setSelectedTags] = createSignal<string[]>([]);

  /** Server-enforced cap on tags per post */
  const MAX_APPLIED_TAGS = 5;

  const group = createFormGroup({
    title: createFormControl("", { required: true }),
    content: createFormControl("", { required: true }),
  });

  // Moderated tags are only offered to members who can actually apply them.
  const availableTags = () =>
    props.channel.tags.filter(
      (tag) => !tag.moderated || props.channel.havePermission("ManageChannel"),
    );

  function toggleTag(id: string) {
    setSelectedTags((tags) =>
      tags.includes(id)
        ? tags.filter((tag) => tag !== id)
        : tags.length >= MAX_APPLIED_TAGS
          ? tags
          : [...tags, id],
    );
  }

  async function onSubmit() {
    try {
      const { post } = await props.channel.createPost({
        title: group.controls.title.value.trim(),
        tags: selectedTags(),
        message: { content: group.controls.content.value },
      });

      navigate(post.path);
      props.onClose();
    } catch (error) {
      showError(error);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  const missingRequiredTag = () =>
    props.channel.requireTag && selectedTags().length === 0;

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>New post</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group) || missingRequiredTag(),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.TextField
            minlength={1}
            maxlength={100}
            counter
            name="title"
            control={group.controls.title}
            label={t`Title`}
          />

          <Form2.TextField
            name="content"
            control={group.controls.content}
            label={t`Message`}
          />

          <Show when={availableTags().length}>
            <Column gap="sm">
              <Show
                when={props.channel.requireTag}
                fallback={<Trans>Tags</Trans>}
              >
                <Trans>Tags (at least one required)</Trans>
              </Show>
              <TagRow>
                <For each={availableTags()}>
                  {(tag) => (
                    <TagChip
                      type="button"
                      selected={selectedTags().includes(tag.id)}
                      onClick={() => toggleTag(tag.id)}
                    >
                      <Show when={tag.emoji}>{tag.emoji} </Show>
                      {tag.name}
                    </TagChip>
                  )}
                </For>
              </TagRow>
            </Column>
          </Show>

          {/* A forum can require a tag and still offer this member none to
              apply. The block above then renders NOTHING and `Create` stays
              disabled for good with nothing on screen saying why, which reads
              exactly as "there is nowhere to add tags" — which is what was
              reported on 2026-09-10, by the person who had turned Require
              tags ON and never added any (they are separate controls on the
              same settings screen).

              The two ways to get here need different answers, and the
              no-tags-at-all one is the common one: telling the channel's own
              manager to go ask a manager is what made the first version of
              this message useless to the reporter. */}
          <Show when={props.channel.requireTag && !availableTags().length}>
            <small>
              <Switch>
                <Match when={!props.channel.tags.length}>
                  <Show
                    when={props.channel.havePermission("ManageChannel")}
                    fallback={
                      <Trans>
                        Every post here needs a tag, but this forum has no tags
                        yet. Ask someone who manages this channel to add some.
                      </Trans>
                    }
                  >
                    <Trans>
                      Every post here needs a tag, but this forum has no tags
                      yet. Add them in this channel's settings, under Forum.
                    </Trans>
                  </Show>
                </Match>
                <Match when={availableTags().length === 0}>
                  <Trans>
                    Every post here needs a tag, but none of this forum's tags
                    are ones you can apply. Ask someone who manages this
                    channel.
                  </Trans>
                </Match>
              </Switch>
            </small>
          </Show>
        </Column>
      </form>
    </Dialog>
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
