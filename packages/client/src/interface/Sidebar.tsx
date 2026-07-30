import { Component, JSX, Match, Show, Switch, createMemo } from "solid-js";
import { styled } from "styled-system/jsx";

import { Channel, Server as ServerI } from "stoat.js";

import {
  CategoryContextMenu,
  ChannelContextMenu,
  ServerSidebarContextMenu,
} from "@revolt/app";
import { useClient, useUser } from "@revolt/client";
import { useModals } from "@revolt/modal";
import { useLocation, useParams, useSmartParams } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";

import { HomeSidebar, ServerList, ServerSidebar } from "./navigation";
import { UserFooter } from "./navigation/UserFooter";

const MainBar = styled("div", {
  base: {
    display: "flex",
    flexShrink: 0,
    // Containing block for the floating user bar.
    position: "relative",

    _phone: {
      "--layout-width-channel-sidebar": "auto",
      position: "absolute",
      width: "100vw",
      height: "100%",
    },
  },
  variants: {
    /**
     * Reserve room at the bottom of both columns (server rail + channel
     * list) so their content can always scroll clear of the floating
     * user bar, which overlays the bottom of the nav block.
     */
    withFooter: {
      true: {
        "& > *:not([data-user-footer])": {
          paddingBottom: "var(--layout-height-user-footer)",
        },
      },
      false: {},
    },
  },
  defaultVariants: {
    withFooter: false,
  },
});

/**
 * Left-most channel navigation sidebar
 */
export const Sidebar = (props: {
  /**
   * Menu generator TODO FIXME: remove
   */
  menuGenerator: (t: ServerI | Channel) => JSX.Directives["floating"];
}) => {
  const user = useUser();
  const state = useState();
  const client = useClient();
  const { openModal } = useModals();

  const params = useParams<{ server: string }>();
  const location = useLocation();

  /** Whether the channel sidebar (and with it the user bar) is shown. */
  const showSidebar = () =>
    state.layout.getSectionState(LAYOUT_SECTIONS.PRIMARY_SIDEBAR, true) &&
    !location.pathname.startsWith("/discover");

  return (
    <MainBar class="main_bar" withFooter={showSidebar()}>
      <ServerList
        orderedServers={state.ordering.orderedServers(client())}
        setServerOrder={state.ordering.setServerOrder}
        unreadConversations={state.ordering
          .orderedConversations(client())
          .filter(
            // TODO: muting channels
            (channel) => channel.unread,
          )}
        pendingFriendRequests={
          client()
            ?.users.toList()
            .filter((user) => user.relationship === "Incoming").length ?? 0
        }
        user={user()!}
        selectedServer={() => params.server}
        onCreateOrJoinServer={() =>
          openModal({
            type: "create_or_join_server",
            client: client(),
          })
        }
        menuGenerator={props.menuGenerator}
      />
      <Show when={showSidebar()}>
        <Switch fallback={<Home />}>
          <Match when={params.server}>
            <Server />
          </Match>
        </Switch>
        <UserFooter />
      </Show>
    </MainBar>
  );
};

/**
 * Render sidebar for home
 */
const Home: Component = () => {
  const params = useSmartParams();
  const client = useClient();
  const state = useState();
  const conversations = createMemo(() =>
    state.ordering.orderedConversations(client()),
  );

  return (
    <HomeSidebar
      conversations={conversations}
      channelId={params().channelId}
      openSavedNotes={(navigate) => {
        // Check whether the saved messages channel exists already
        const channelId = [...client()!.channels.values()].find(
          (channel) => channel.type === "SavedMessages",
        )?.id;

        if (navigate) {
          if (channelId) {
            // Navigate if exists
            navigate(`/channel/${channelId}`);
          } else {
            // If not, try to create one but only if navigating
            client()!
              .user!.openDM()
              .then((channel) => navigate(`/channel/${channel.id}`));
          }
        }

        // Otherwise return channel ID if available
        return channelId;
      }}
    />
  );
};

/**
 * Render sidebar for a server
 */
const Server: Component = () => {
  const { openModal } = useModals();
  const params = useSmartParams();
  const client = useClient();

  /**
   * Resolve the server
   * @returns Server
   */
  const server = () => client()!.servers.get(params().serverId!)!;

  /**
   * Open the server information modal
   */
  function openServerInfo() {
    openModal({
      type: "server_info",
      server: server(),
    });
  }

  /**
   * Open the server settings modal
   */
  function openServerSettings() {
    openModal({
      type: "settings",
      config: "server",
      context: server(),
    });
  }

  return (
    <Show when={server()}>
      <ServerSidebar
        server={server()}
        channelId={params().channelId}
        openServerInfo={openServerInfo}
        openServerSettings={openServerSettings}
        menuGenerator={(target) => ({
          contextMenu: () =>
            target instanceof Channel ? (
              <ChannelContextMenu channel={target} />
            ) : target instanceof ServerI ? (
              <ServerSidebarContextMenu server={target} />
            ) : (
              <CategoryContextMenu server={server()} category={target} />
            ),
        })}
      />
    </Show>
  );
};
