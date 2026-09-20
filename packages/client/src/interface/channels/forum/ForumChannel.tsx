import {
  For,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { useQuery } from "@tanstack/solid-query";
import { Channel, HydratedChannel, Message } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";
import { TextWithEmoji } from "@revolt/markdown";
import { useModals } from "@revolt/modal";
import { Button, CircularProgress, Header, Row, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import MdCheck from "@material-design-icons/svg/outlined/check.svg?component-solid";

import { ContextMenu, ContextMenuButton } from "@revolt/app/menus/ContextMenu";

import { ChannelHeader } from "../ChannelHeader";
import { ChannelPageProps } from "../ChannelPage";

import { PostCard } from "./PostCard";

/** Server page size for GET /posts */
const PAGE_SIZE = 50;

/** The `sort` values `GET /posts` accepts. */
type SortMode = "latest_activity" | "creation_date" | "alphabetical";

/**
 * Map a forum's stored `default_sort` onto the query parameter
 * @param order Forum's configured default ordering
 */
function sortModeFor(order: string): SortMode {
  if (order === "CreationDate") return "creation_date";
  if (order === "Alphabetical") return "alphabetical";
  return "latest_activity";
}

/**
 * Name of a sort mode. Written as three literal `Trans` elements rather than
 * a lookup table so each label is a literal lingui msgid.
 */
function SortName(props: { mode: SortMode }) {
  return (
    <Switch fallback={<Trans>Latest activity</Trans>}>
      <Match when={props.mode === "creation_date"}>
        <Trans>Creation date</Trans>
      </Match>
      <Match when={props.mode === "alphabetical"}>
        <Trans>A-Z</Trans>
      </Match>
    </Switch>
  );
}

/**
 * Forum channel browse view: a card grid of posts with tag filtering,
 * sorting by latest activity or creation date, and cursor pagination
 */
export function ForumChannel(props: ChannelPageProps) {
  const client = useClient();
  const { openModal, showError } = useModals();

  const [chosenSort, setSort] = createSignal<SortMode>(
    sortModeFor(props.channel.defaultSort),
  );

  // A forum can impose its order on everyone. The server enforces it, so the
  // client must ask for the same thing rather than send a `sort` that comes
  // back ignored — otherwise the merged page order below would disagree with
  // the order the pages actually arrived in.
  const sort = createMemo<SortMode>(() =>
    props.channel.forceSort
      ? sortModeFor(props.channel.defaultSort)
      : chosenSort(),
  );
  const [tag, setTag] = createSignal<string | undefined>(undefined);
  const [archived, setArchived] = createSignal(false);

  // Pages beyond the first, loaded through the `before` cursor.
  const [extraPosts, setExtraPosts] = createSignal<Channel[]>([]);
  const [extraStarters, setExtraStarters] = createSignal<Message[]>([]);
  const [exhausted, setExhausted] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);

  // Changing the filter/sort invalidates the loaded tail.
  createEffect(
    on([sort, tag, archived], () => {
      setExtraPosts([]);
      setExtraStarters([]);
      setExhausted(false);
    }),
  );

  const query = useQuery(() => ({
    queryKey: ["forum_posts", props.channel.id, sort(), tag(), archived()],
    queryFn: () =>
      props.channel.fetchPosts({
        sort: sort(),
        tag: tag(),
        archived: archived(),
        includeStarters: true,
      }),
  }));

  /**
   * Client-side mirror of the server's sort key so merged pages stay ordered.
   * The A-Z key mirrors `alphabetical_key` in the delta route exactly,
   * including the NUL tiebreaker on the post id — two posts can share a name.
   */
  const keyFor = (post: Channel, mode: SortMode) => {
    if (mode === "alphabetical")
      return `${post.name.toLowerCase()}\0${post.id}`;
    if (mode === "creation_date") return post.id;
    return post.lastMessageId ?? post.id;
  };

  const sortKey = (post: Channel) => keyFor(post, sort());

  // First page merged with cursor-loaded pages, deduplicated (a live refetch
  // of page one can overlap the tail) and re-sorted.
  const posts = createMemo(() => {
    // Read the mode once for the whole pass rather than per comparison: the
    // comparators below then hold no reactivity of their own, and the sort
    // cannot see the mode change halfway through its own ordering.
    const mode = sort();

    const seen = new Set<string>();
    const merged: Channel[] = [];
    for (const post of [...(query.data?.posts ?? []), ...extraPosts()]) {
      if (!seen.has(post.id)) {
        seen.add(post.id);
        merged.push(post);
      }
    }

    // A-Z reads ascending, and compares by code unit rather than with
    // `localeCompare`: the server orders raw UTF-8 bytes, and locale
    // collation treats the NUL tiebreaker as ignorable, which would order
    // same-named posts differently here than in the pages being merged.
    if (mode === "alphabetical") {
      return merged.sort((a, b) => {
        const left = keyFor(a, mode);
        const right = keyFor(b, mode);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    }

    return merged.sort((a, b) =>
      keyFor(b, mode).localeCompare(keyFor(a, mode)),
    );
  });

  async function loadMore() {
    const tail = posts().at(-1);
    if (!tail || loadingMore()) return;
    setLoadingMore(true);
    try {
      const page = await props.channel.fetchPosts({
        sort: sort(),
        tag: tag(),
        archived: archived(),
        // A-Z pages on the post's id, which the route resolves to the real
        // sort key server-side — the key itself embeds a NUL and cannot be
        // spelled in a query string. Every other order pages on the key.
        before: sort() === "alphabetical" ? tail.id : sortKey(tail),
        limit: PAGE_SIZE,
        includeStarters: true,
      });
      setExtraPosts((posts) => [...posts, ...page.posts]);
      setExtraStarters((starters) => [...starters, ...(page.starters ?? [])]);
      if (page.posts.length < PAGE_SIZE) setExhausted(true);
    } catch (error) {
      showError(error);
    } finally {
      setLoadingMore(false);
    }
  }

  const mayHaveMore = () =>
    !exhausted() && (query.data?.posts.length ?? 0) >= PAGE_SIZE;

  // Viewing the browse view reads the forum: acknowledge it so the sidebar
  // unread dot clears (posts keep their own per-thread unread state).
  createEffect(
    on(
      () => query.data && props.channel.unread,
      (unread) => {
        if (unread && document.hasFocus()) {
          props.channel.ack();
        }
      },
    ),
  );

  /**
   * Mark as read on re-focus while the browse view is open
   */
  function onFocus() {
    if (props.channel.unread) {
      props.channel.ack();
    }
  }

  document.addEventListener("focus", onFocus);
  onCleanup(() => document.removeEventListener("focus", onFocus));

  // Keep the grid live: new posts arrive as threadCreate, tag/archive edits
  // as channelUpdate, deletions as channelDelete, and replies (activity
  // bumps) as messageCreate on the post's own channel.
  const liveClient = client();

  /**
   * Refetch when a post under this forum changes, or the forum itself does
   */
  function onPostChange(channel: Channel) {
    if (
      channel.id === props.channel.id ||
      (channel.isThread && channel.parentChannelId === props.channel.id)
    ) {
      query.refetch();
    }
  }

  /**
   * Refetch when a post under this forum is deleted — channelDelete emits
   * the hydrated snapshot, not a live Channel object
   */
  function onPostDelete(channel: HydratedChannel) {
    if (
      channel.channelType === "Thread" &&
      channel.parentChannelId === props.channel.id
    ) {
      query.refetch();
    }
  }

  /**
   * Refetch when a reply lands in one of this forum's posts so the
   * activity sort and reply counts stay fresh
   */
  function onMessage(message: Message) {
    if (message.channel?.parentChannelId === props.channel.id) {
      query.refetch();
    }
  }

  liveClient.on("threadCreate", onPostChange);
  liveClient.on("channelUpdate", onPostChange);
  liveClient.on("channelDelete", onPostDelete);
  liveClient.on("messageCreate", onMessage);

  onCleanup(() => {
    liveClient.removeListener("threadCreate", onPostChange);
    liveClient.removeListener("channelUpdate", onPostChange);
    liveClient.removeListener("channelDelete", onPostDelete);
    liveClient.removeListener("messageCreate", onMessage);
  });

  /**
   * Starter message for a post (its id equals the post's id)
   */
  const starterFor = (post: Channel) =>
    query.data?.starters?.find((starter) => starter.id === post.id) ??
    extraStarters().find((starter) => starter.id === post.id);

  return (
    <Base>
      <Header placement="primary">
        <ChannelHeader channel={props.channel} />
      </Header>

      <Toolbar>
        <Row align gap="sm" wrap>
          {/* One "view" control rather than a button per mode. The toolbar
              also carries the tag filter and the archived toggle, and a row of
              one button per mode does not survive another mode being added. */}
          <Show
            when={!props.channel.forceSort}
            fallback={
              // The order is fixed for everyone, so this is a label rather
              // than a disabled menu: a control that opens and changes
              // nothing is worse than no control.
              <ForcedSort>
                <Symbol size={18}>lock</Symbol>
                <SortName mode={sort()} />
              </ForcedSort>
            }
          >
            <Button
              size="sm"
              variant="text"
              use:floating={{
                contextMenu: () => (
                  <ContextMenu>
                    <ContextMenuButton
                      onClick={() => setSort("latest_activity")}
                      actionIcon={
                        sort() === "latest_activity" ? MdCheck : undefined
                      }
                    >
                      <Trans>Latest activity</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => setSort("creation_date")}
                      actionIcon={
                        sort() === "creation_date" ? MdCheck : undefined
                      }
                    >
                      <Trans>Creation date</Trans>
                    </ContextMenuButton>
                    <ContextMenuButton
                      onClick={() => setSort("alphabetical")}
                      actionIcon={
                        sort() === "alphabetical" ? MdCheck : undefined
                      }
                    >
                      <Trans>A-Z</Trans>
                    </ContextMenuButton>
                  </ContextMenu>
                ),
                contextMenuHandler: "click",
              }}
            >
              <Symbol>sort</Symbol>
              <SortName mode={sort()} />
            </Button>
          </Show>

          <Button
            size="sm"
            variant={archived() ? "filled" : "text"}
            onPress={() => setArchived((archived) => !archived)}
          >
            <Trans>Archived</Trans>
          </Button>

          <Grow />

          <Show when={props.channel.havePermission("SendMessage")}>
            <Button
              size="sm"
              onPress={() =>
                openModal({
                  type: "create_forum_post",
                  channel: props.channel,
                })
              }
            >
              <Symbol size={18}>add</Symbol> <Trans>New Post</Trans>
            </Button>
          </Show>
        </Row>

        <Show when={props.channel.tags.length}>
          <Row align gap="sm" wrap>
            <For each={props.channel.tags}>
              {(forumTag) => (
                <TagChip
                  selected={tag() === forumTag.id}
                  onClick={() =>
                    setTag((current) =>
                      current === forumTag.id ? undefined : forumTag.id,
                    )
                  }
                >
                  <Show when={forumTag.emoji}>
                    <TextWithEmoji content={forumTag.emoji} />{" "}
                  </Show>
                  <TextWithEmoji content={forumTag.name} />
                </TagChip>
              )}
            </For>
          </Row>
        </Show>
      </Toolbar>

      <Scroll>
        <Suspense fallback={<CircularProgress />}>
          <Show when={posts().length === 0 && !query.isLoading}>
            <Text>
              <Show when={archived()} fallback={<Trans>No posts yet</Trans>}>
                <Trans>No archived posts</Trans>
              </Show>
            </Text>
          </Show>
          <Grid>
            <For each={posts()}>
              {(post) => (
                <PostCard
                  post={post}
                  forum={props.channel}
                  starter={starterFor(post)}
                />
              )}
            </For>
          </Grid>
          <Show when={mayHaveMore()}>
            <LoadMoreRow>
              <Button
                size="sm"
                variant="text"
                isDisabled={loadingMore()}
                onPress={loadMore}
              >
                <Show when={!loadingMore()} fallback={<CircularProgress />}>
                  <Trans>Load more</Trans>
                </Show>
              </Button>
            </LoadMoreRow>
          </Show>
        </Suspense>
      </Scroll>
    </Base>
  );
}

const Base = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minHeight: 0,
    color: "var(--md-sys-color-on-surface)",
  },
});

const Toolbar = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    padding: "var(--gap-md) var(--gap-lg)",
  },
});

const ForcedSort = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "0 8px",
    fontSize: "0.8125rem",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Grow = styled("div", {
  base: {
    flexGrow: 1,
  },
});

const TagChip = styled("button", {
  base: {
    padding: "var(--gap-sm) var(--gap-md)",
    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    cursor: "pointer",
    transition: "var(--transitions-fast) all",
    fontSize: "0.8125rem",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
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

const Scroll = styled("div", {
  base: {
    overflowY: "auto",
    flexGrow: 1,
    minHeight: 0,
    padding: "0 var(--gap-lg) var(--gap-lg)",

    // On a phone the floating user bar is pinned over the bottom of every
    // screen (it belongs to the nav block, which there is a drawer the content
    // slides straight over). End padding on a scroller counts towards the
    // scroll extent, so the last row of posts can be scrolled clear of the bar
    // instead of ending underneath it.
    _phone: {
      paddingBlockEnd: "calc(var(--gap-lg) + var(--layout-height-user-footer))",
    },
  },
});

const Grid = styled("div", {
  base: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
    gap: "var(--gap-md)",
    alignContent: "start",
  },
});

const LoadMoreRow = styled("div", {
  base: {
    display: "flex",
    justifyContent: "center",
    padding: "var(--gap-md)",
  },
});
