import { Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { Column, Dialog, DialogProps } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

import { ForumTagChips, MAX_APPLIED_TAGS } from "./ForumTagChips";

/**
 * Modal to change the tags on a forum post after it has been posted
 */
export function EditForumPostTagsModal(
  props: DialogProps & Modals & { type: "edit_forum_post_tags" },
) {
  const { showError } = useModals();

  const forum = () => props.post.parent;
  const canManage = () => forum()?.havePermission("ManageChannel") ?? false;
  const definedTag = (id: string) => forum()?.tags.find((tag) => tag.id === id);

  // Seeded from the post, minus ids of tags deleted since it was tagged: the
  // server refuses any id the forum no longer defines, so keeping one would
  // fail every save over a tag nobody can see.
  const [selected, setSelected] = createSignal(
    // eslint-disable-next-line solid/reactivity
    props.post.appliedTags.filter((id) => definedTag(id)),
  );
  const [saving, setSaving] = createSignal(false);

  // Moderated tags are only offered to members who can apply them, except
  // one already on the post, which everyone sees (locked, see below).
  const shownTags = () =>
    (forum()?.tags ?? []).filter(
      (tag) => !tag.moderated || canManage() || selected().includes(tag.id),
    );

  // The server checks the WHOLE set against the editor's permissions, so a
  // moderated tag already on the post fails a non-manager's save even when
  // they only touched other tags. Say so instead of letting Save fail.
  const blockedByModeratedTag = () =>
    !canManage() && selected().some((id) => definedTag(id)?.moderated);

  const missingRequiredTag = () =>
    !!forum()?.requireTag && selected().length === 0;

  function toggleTag(id: string) {
    setSelected((tags) =>
      tags.includes(id)
        ? tags.filter((tag) => tag !== id)
        : tags.length >= MAX_APPLIED_TAGS
          ? tags
          : [...tags, id],
    );
  }

  async function save() {
    setSaving(true);
    try {
      await props.post.editAppliedTags(selected());
      props.onClose();
    } catch (error) {
      showError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Edit tags</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Save</Trans>,
          onClick: () => {
            save();
            return false;
          },
          isDisabled:
            saving() || blockedByModeratedTag() || missingRequiredTag(),
        },
      ]}
      isDisabled={saving()}
    >
      <Column>
        <Show
          when={shownTags().length}
          fallback={<Trans>This forum has no tags yet.</Trans>}
        >
          <ForumTagChips
            tags={shownTags()}
            selected={selected()}
            onToggle={toggleTag}
            locked={(tag) => !!tag.moderated && !canManage()}
          />
        </Show>

        <Show when={blockedByModeratedTag()}>
          <small>
            <Trans>
              This post has a tag only moderators can change, so only a
              moderator can edit its tags.
            </Trans>
          </small>
        </Show>

        <Show when={missingRequiredTag() && shownTags().length}>
          <small>
            <Trans>Every post in this forum needs at least one tag.</Trans>
          </small>
        </Show>
      </Column>
    </Dialog>
  );
}
