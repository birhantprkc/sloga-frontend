import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import type { API } from "stoat.js";
import { Channel, Server } from "stoat.js";

import { useDevice } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useState } from "@revolt/state";

import MdBadge from "@material-design-icons/svg/outlined/badge.svg?component-solid";
import MdDelete from "@material-design-icons/svg/outlined/delete.svg?component-solid";
import MdLibraryAdd from "@material-design-icons/svg/outlined/library_add.svg?component-solid";
import MdMarkChatRead from "@material-design-icons/svg/outlined/mark_chat_read.svg?component-solid";
import MdSwapVert from "@material-design-icons/svg/outlined/swap_vert.svg?component-solid";

import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { enterReorderMode } from "../../../src/interface/navigation/channels/reorderMode";
import {
  ContextMenu,
  ContextMenuButton,
  ContextMenuDivider,
} from "./ContextMenu";

export type CategoryData = Omit<API.Category, "channels"> & {
  channels: Channel[];
};

/**
 * Context menu for categories
 */
export function CategoryContextMenu(props: {
  server: Server;
  category: CategoryData;
}) {
  const state = useState();
  const { openModal } = useModals();
  const { isMobile } = useDevice();

  /**
   * Create a new channel, preselecting this category
   */
  function createChannel() {
    openModal({
      type: "create_channel",
      server: props.server,
      categoryId: props.category.id,
    });
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
   * Put the server sidebar into channel reorder mode.
   *
   * Deliberately does not close the menu: FloatingManager already hides any
   * shown context menu from its bubble-phase document click listener, so an
   * explicit hide here would be redundant.
   */
  function rearrangeChannels() {
    enterReorderMode(props.server.id);
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
        <ContextMenuButton icon={MdLibraryAdd} onClick={createCategory}>
          <Trans>Create category</Trans>
        </ContextMenuButton>
        <ContextMenuButton
          icon={<Symbol size={16}>edit</Symbol>}
          onClick={editCategoryName}
        >
          <Trans>Rename category</Trans>
        </ContextMenuButton>
        <Show when={isMobile}>
          <ContextMenuButton icon={MdSwapVert} onClick={rearrangeChannels}>
            <Trans>Rearrange channels</Trans>
          </ContextMenuButton>
        </Show>
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
