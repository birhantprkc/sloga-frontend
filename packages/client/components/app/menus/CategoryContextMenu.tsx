import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { API } from "stoat.js";
import { Channel, Server } from "stoat.js";

import { useModals } from "@revolt/modal";
import { useNavigate } from "@revolt/routing";
import { useState } from "@revolt/state";

import MdBadge from "@material-design-icons/svg/outlined/badge.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdLibraryAdd from "@material-design-icons/svg/outlined/library_add.svg?component-solid";
import MdMarkChatRead from "@material-design-icons/svg/outlined/mark_chat_read.svg?component-solid";

import { Symbol } from "@revolt/ui/components/utils/Symbol";
import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
} from "./ContextMenu";

export type CategoryData = Omit<API.Category, "channels"> & {
  channels: Channel[];
};

/**
 * Open the create-channel modal and file the new channel into the given
 * category once it exists — without the follow-up edit, new channels always
 * land in the uncategorised block at the bottom of the sidebar.
 */
export function createChannelInCategory(
  openModal: ReturnType<typeof useModals>["openModal"],
  navigate: ReturnType<typeof useNavigate>,
  server: Server,
  categoryId: string,
) {
  openModal({
    type: "create_channel",
    server,
    cb: (channel) => {
      // Uncategorised channels already collect in the synthetic "default"
      // bucket, so only real categories need the server edit.
      if (categoryId !== "default") {
        server.edit({
          categories: server.orderedChannels.map((category) => ({
            ...category,
            channels: category.channels
              .map((entry) => entry.id)
              .filter((id) => id !== channel.id)
              .concat(category.id === categoryId ? [channel.id] : []),
          })),
        });
      }

      navigate(`/server/${server.id}/channel/${channel.id}`);
    },
  });
}

/**
 * Context menu for categories
 */
export function CategoryContextMenu(props: {
  server: Server;
  category: CategoryData;
}) {
  const state = useState();
  const { openModal } = useModals();
  const navigate = useNavigate();

  /**
   * Create a new channel inside this category
   */
  function createChannel() {
    createChannelInCategory(
      openModal,
      navigate,
      props.server,
      props.category.id,
    );
  }

  /**
   * Mark category as read
   */
  function markAsRead() {
    props.category.channels
      .filter((channel) => channel.unread)
      .forEach((channel) => channel.ack());
  }

  /**
   * Create a new category
   */
  function createCategory() {
    openModal({
      type: "create_category",
      server: props.server,
    });
  }

  /**
   * Delete category
   */
  function deleteCategory() {
    openModal({
      type: "delete_category",
      server: props.server,
      categoryId: props.category.id,
    });
  }

  function editCategoryName() {
    openModal({
      type: "edit_category",
      server: props.server,
      category: props.category,
    });
  }

  /**
   * Copy category id to clipboard
   */
  function copyId() {
    navigator.clipboard.writeText(props.category.id);
  }

  /**
   * Determine if any channel in category has unread messages
   */
  const hasUnread = () => {
    return props.category.channels.some((channel) => channel?.unread);
  };

  return (
    <ContextMenu>
      <Show when={hasUnread()}>
        <ContextMenuButton icon={MdMarkChatRead} onClick={markAsRead}>
          <Trans>Mark as read</Trans>
        </ContextMenuButton>
        <ContextMenuDivider />
      </Show>

      <Show when={props.server.havePermission("ManageChannel")}>
        <ContextMenuButton
          icon={<Symbol size={16}>add</Symbol>}
          onClick={createChannel}
        >
          <Trans>Create channel</Trans>
        </ContextMenuButton>
      </Show>
      <Show when={props.server.havePermission("ManageChannel")}>
        <ContextMenuButton icon={MdLibraryAdd} onClick={createCategory}>
          <Trans>Create category</Trans>
        </ContextMenuButton>
      </Show>
      <Show when={props.server.havePermission("ManageChannel")}>
        <ContextMenuButton
          icon={<Symbol size={16}>edit</Symbol>}
          onClick={editCategoryName}
        >
          <Trans>Rename category</Trans>
        </ContextMenuButton>
      </Show>
      <Show when={props.server.havePermission("ManageChannel")}>
        <ContextMenuButton icon={MdDelete} onClick={deleteCategory} destructive>
          <Trans>Delete category</Trans>
        </ContextMenuButton>
      </Show>

      <Show when={state.settings.getValue("advanced:copy_id")}>
        <ContextMenuDivider />
      </Show>

      <Show when={state.settings.getValue("advanced:copy_id")}>
        <ContextMenuButton icon={MdBadge} onClick={copyId}>
          <Trans>Copy category ID</Trans>
        </ContextMenuButton>
      </Show>
    </ContextMenu>
  );
}
