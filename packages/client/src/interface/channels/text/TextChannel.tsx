import {
  Match,
  Show,
  Switch,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";
import { decodeTime, ulid } from "ulid";

import { DraftMessages, Messages, ScheduledMessagesBar } from "@revolt/app";
import { useClient } from "@revolt/client";
import { Keybind, KeybindAction, createKeybind } from "@revolt/keybinds";
import { useModals } from "@revolt/modal";
import { useNavigate, useSmartParams } from "@revolt/routing";
import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import {
  BelowFloatingHeader,
  Button,
  Header,
  NewMessages,
  Text,
  TypingIndicator,
  main,
  useLayoutSides,
} from "@revolt/ui";
import { VoiceChannelCallCardMount } from "@revolt/ui/components/features/voice/callCard/VoiceCallCard";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { ChannelHeader } from "../ChannelHeader";
import { ChannelPageProps } from "../ChannelPage";

import { Channel } from "stoat.js";
import { MessageComposition } from "./Composition";
import { MemberSidebar } from "./MemberSidebar";
import { TextSearchSidebar } from "./TextSearchSidebar";
import { ThreadsListSidebar } from "./ThreadsListSidebar";

/**
 * State of the channel sidebar
 */
export type SidebarState =
  | {
      state: "search";
      query: string;
    }
  | {
      state: "pins";
    }
  | {
      state: "threads_list";
    }
  | {
      state: "default";
    };

export function canIHasSidebar(ch: Channel) {
  return !["SavedMessages", "DirectMessage"].includes(ch.type);
}

/**
 * Channel component
 */
export function TextChannel(props: ChannelPageProps) {
  const state = useState();
  const client = useClient();
  const sides = useLayoutSides();

  /**
   * Whether the member list belongs in this channel's own side column (the
   * one opposite the navigation block) rather than in the channel column.
   *
   * A server text channel keeps its member list at the bottom of the channel
   * column by default, sharing the space with the channel list; the layout
   * setting (or the ultrawide layout, via "auto") moves it here instead so
   * neither list has to give up rows for the other. Group DMs have no channel
   * column and always use this one. `ServerSidebar` reads the same condition
   * and stands down when this is true.
   */
  const membersInOwnColumn = () =>
    props.channel.type !== "TextChannel" || sides().membersOwnColumn;

  /**
   * Whether the side column (members / search / pins / threads) renders
   * before or after `<main>` in the row.
   *
   * It has always sat on the near side — between the channel column and the
   * messages — and it stays there unless the member list has been given its
   * own column, in which case the whole side column moves to the far edge:
   * that is what "member list on the right" means. Both cases mirror when the
   * navigation block is on the right.
   */
  const sideColumnEdge = (): "before" | "after" => {
    const far = sides().membersOwnColumn;
    const navRight = sides().nav === "right";
    return far !== navRight ? "after" : "before";
  };

  // Last unread message id
  const [lastId, setLastId] = createSignal<string>();

  // Read highlighted message id from parameters
  const params = useSmartParams();
  const navigate = useNavigate();

  /**
   * Message id to be highlighted
   * @returns Message Id
   */
  const highlightMessageId = () => params().messageId;

  const canConnect = () =>
    props.channel.isVoice && props.channel.havePermission("Connect");

  // Get a reference to the message box's load latest function
  let jumpToBottomRef: ((nearby?: string) => void) | undefined;

  const [atEnd, setEnd] = createSignal(true);

  // Store last unread message id
  createEffect(
    on(
      () => props.channel.id,
      (id) =>
        setLastId(
          props.channel.unread
            ? (client().channelUnreads.get(id)?.lastMessageId as string)
            : undefined,
        ),
    ),
  );

  // Mark channel as read whenever it is marked as unread
  createEffect(
    on(
      // must be at the end of the conversation
      () => props.channel.unread && atEnd(),
      (unread) => {
        if (unread) {
          if (document.hasFocus()) {
            // acknowledge the message
            props.channel.ack();
          } else {
            // otherwise mark this location as the last read location
            if (!lastId()) {
              // (taking away one second from the seed)
              setLastId(ulid(decodeTime(props.channel.lastMessageId!) - 1));
            }
          }
        }
      },
    ),
  );

  // Mark as read on re-focus
  function onFocus() {
    if (props.channel.unread && atEnd()) {
      props.channel.ack();
    }
  }

  document.addEventListener("focus", onFocus);
  onCleanup(() => document.removeEventListener("focus", onFocus));

  // Register ack/jump latest
  createKeybind(KeybindAction.CHAT_JUMP_END, () => {
    // Mark channel as read if not already
    if (props.channel.unread) {
      props.channel.ack();
    }

    // Clear the last unread id
    if (lastId()) {
      setLastId(undefined);
    }

    // Scroll to the bottom
    jumpToBottomRef?.();
  });

  // Sidebar scroll target
  let sidebarScrollTargetElement!: HTMLDivElement;

  // Sidebar state
  const [sidebarState, setSidebarState] = createSignal<SidebarState>({
    state: "default",
  });

  // todo: in the future maybe persist per ID?
  createEffect(
    on(
      () => props.channel.id,
      () => setSidebarState({ state: "default" }),
    ),
  );

  return (
    <>
      <Header placement="primary">
        <ChannelHeader
          channel={props.channel}
          sidebarState={sidebarState}
          setSidebarState={setSidebarState}
        />
      </Header>
      <Show when={props.channel.isThread}>
        <ThreadBanner channel={props.channel} />
      </Show>
      <Content navRight={sides().nav === "right"}>
        <Show
          when={
            sidebarState().state !== "default" ||
            (state.layout.getSectionState(
              LAYOUT_SECTIONS.MEMBER_SIDEBAR,
              true,
            ) &&
              canIHasSidebar(props.channel) &&
              membersInOwnColumn())
          }
        >
          <div
            ref={sidebarScrollTargetElement}
            use:scrollable={{
              direction: "y",
              showOnHover: true,
              class: sidebar(),
            }}
            style={{
              width: sidebarState().state !== "default" ? "360px" : "",
              // `<main>` keeps the default order 0; the column goes either
              // side of it without ever being remounted (which would drop
              // the scroll position and the members' scroll target). The
              // directive above applies its class once, so the edge-dependent
              // rule (the hairline on the side facing the messages) lives
              // here where it can react.
              order: sideColumnEdge() === "before" ? -1 : 1,
              [sideColumnEdge() === "before" ? "border-right" : "border-left"]:
                "1px solid var(--md-sys-color-outline-variant)",
            }}
          >
            <Switch
              fallback={
                <Show when={membersInOwnColumn()}>
                  <MemberSidebar
                    channel={props.channel}
                    scrollTargetElement={sidebarScrollTargetElement}
                  />
                </Show>
              }
            >
              <Match when={sidebarState().state === "search"}>
                <WideSidebarContainer edge={sideColumnEdge()}>
                  <SidebarTitle>
                    <Text class="label" size="large">
                      Search Results
                    </Text>
                  </SidebarTitle>
                  <TextSearchSidebar
                    channel={props.channel}
                    query={{
                      query: (sidebarState() as { query: string }).query,
                    }}
                  />
                </WideSidebarContainer>
              </Match>
              <Match when={sidebarState().state === "pins"}>
                <WideSidebarContainer edge={sideColumnEdge()}>
                  <SidebarTitle>
                    <Text class="label" size="large">
                      Pinned Messages
                    </Text>
                  </SidebarTitle>
                  <TextSearchSidebar
                    channel={props.channel}
                    query={{ pinned: true, sort: "Latest" }}
                  />
                </WideSidebarContainer>
              </Match>
              <Match when={sidebarState().state === "threads_list"}>
                <WideSidebarContainer edge={sideColumnEdge()}>
                  <SidebarTitle>
                    <Text class="label" size="large">
                      <Trans>Threads</Trans>
                    </Text>
                  </SidebarTitle>
                  <ThreadsListSidebar channel={props.channel} />
                </WideSidebarContainer>
              </Match>
            </Switch>

            <Show when={sidebarState().state !== "default"}>
              <Keybind
                keybind={KeybindAction.CLOSE_SIDEBAR}
                onPressed={() => setSidebarState({ state: "default" })}
              />
            </Show>
          </div>
        </Show>
        <main class={main()}>
          <Show
            when={canConnect()}
            fallback={
              <BelowFloatingHeader>
                <div>
                  <NewMessages
                    lastId={lastId}
                    jumpBack={() => navigate(lastId()!)}
                    dismiss={() => setLastId()}
                  />
                </div>
              </BelowFloatingHeader>
            }
          >
            <VoiceChannelCallCardMount channel={props.channel} />
          </Show>

          <Messages
            channel={props.channel}
            lastReadId={lastId}
            pendingMessages={(pendingProps) => (
              <DraftMessages
                channel={props.channel}
                tail={pendingProps.tail}
                sentIds={pendingProps.ids}
              />
            )}
            typingIndicator={
              <TypingIndicator
                users={props.channel.typing}
                ownId={client().user!.id}
              />
            }
            highlightedMessageId={highlightMessageId}
            clearHighlightedMessage={() => navigate(".")}
            jumpToBottomRef={(ref) => (jumpToBottomRef = ref)}
            atEnd={[atEnd, setEnd]}
          />

          <ScheduledMessagesBar channel={props.channel} />

          <MessageComposition
            channel={props.channel}
            onMessageSend={() => jumpToBottomRef?.()}
          />
        </main>
      </Content>
    </>
  );
}

/**
 * Thread banner row — parent breadcrumb, archived notice and join/leave
 * controls for the navigated-into thread view
 */
function ThreadBanner(props: { channel: Channel }) {
  const client = useClient();
  const { showError } = useModals();

  // Refresh membership whenever we navigate into a thread so the
  // join/leave state is correct even before any live events arrive
  createEffect(
    on(
      () => props.channel.id,
      () => {
        if (props.channel.isThread) {
          props.channel.fetchThreadMembers().catch(() => void 0);
        }
      },
    ),
  );

  const joined = () =>
    props.channel.threadMembers.has(client().user?.id as string);

  /**
   * Whether we may unarchive: ManageChannel on the parent (the permission
   * calculator resolves threads against their parent) or being the creator
   */
  const canUnarchive = () =>
    props.channel.havePermission("ManageChannel") ||
    props.channel.creatorId === client().user?.id;

  return (
    <ThreadBannerBase>
      <Show when={props.channel.parent}>
        <a href={props.channel.parent!.path}>
          <ThreadBannerParent>
            <Symbol size={16}>subdirectory_arrow_left</Symbol>
            <Trans>Back to #{props.channel.parent!.name}</Trans>
          </ThreadBannerParent>
        </a>
      </Show>
      <ThreadBannerSpacer />
      <Show when={props.channel.archived}>
        <ThreadBannerNotice>
          <Symbol size={16}>archive</Symbol>
          <Trans>This thread is archived</Trans>
        </ThreadBannerNotice>
        <Show when={canUnarchive()}>
          <Button
            size="sm"
            variant="text"
            onPress={() => props.channel.unarchive().catch(showError)}
          >
            <Trans>Unarchive</Trans>
          </Button>
        </Show>
      </Show>
      <Show when={!props.channel.archived}>
        <Show
          when={joined()}
          fallback={
            <Button
              size="sm"
              onPress={() => props.channel.joinThread().catch(showError)}
            >
              <Trans>Join Thread</Trans>
            </Button>
          }
        >
          <Button
            size="sm"
            variant="text"
            onPress={() => props.channel.leaveThread().catch(showError)}
          >
            <Trans>Leave Thread</Trans>
          </Button>
        </Show>
      </Show>
    </ThreadBannerBase>
  );
}

/**
 * Thread banner container
 */
const ThreadBannerBase = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    paddingInline: "var(--gap-lg)",
    paddingBlock: "var(--gap-sm)",
    color: "var(--md-sys-color-on-surface)",
    background: "var(--md-sys-color-surface-container-low)",
    borderBottom: "1px solid var(--md-sys-color-outline-variant)",
  },
});

/**
 * Parent channel breadcrumb
 */
const ThreadBannerParent = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-primary)",
    cursor: "pointer",
  },
});

/**
 * Archived notice
 */
const ThreadBannerNotice = styled("span", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

/**
 * Pushes actions to the end of the banner
 */
const ThreadBannerSpacer = styled("div", {
  base: {
    flexGrow: 1,
  },
});

/**
 * Main content row layout
 */
const Content = styled("div", {
  base: {
    display: "flex",
    flexDirection: "row",
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,
  },
  variants: {
    /**
     * With the navigation block on the right, a capped `<main>` should hug
     * it from the other side: pack the row from the end so the leftover
     * width collects on the left. Centred alignment is margin-driven and
     * unaffected.
     */
    navRight: {
      true: {
        justifyContent: "flex-end",
      },
    },
  },
});

/**
 * Base styles
 */
const sidebar = cva({
  base: {
    flexShrink: 0,
    width: "var(--layout-width-channel-sidebar)",
    // margin: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    // The hairline facing the messages is set inline by `TextChannel` — it
    // depends on which side of `<main>` the column is on.
    // color: "var(--colours-sidebar-channels-foreground)",
    // background: "var(--colours-sidebar-channels-background)",
  },
});

/**
 * Container styles
 */
const WideSidebarContainer = styled("div", {
  base: {
    width: "360px",
  },
  variants: {
    /** Pad the edge that faces the messages */
    edge: {
      before: { paddingRight: "var(--gap-md)" },
      after: { paddingLeft: "var(--gap-md)" },
    },
  },
  defaultVariants: {
    edge: "before",
  },
});

/**
 * Sidebar title
 */
const SidebarTitle = styled("div", {
  base: {
    padding: "var(--gap-md)",
    color: "var(--md-sys-color-on-surface)",
  },
});
