import { For, Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { useClient } from "@revolt/client";

import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";

import { Avatar, Button, IconButton, Text, TextField, typography } from "../../design";

import { isProfilePrivateError } from "./ProfileBio";
import { ProfileCard } from "./ProfileCard";

/**
 * Respect wall — one short compliment per friend, curated by the profile's
 * owner. Entries render as PLAIN TEXT on purpose: no markdown and no mention
 * resolution, so a wall can never become a ping or embed vector.
 */
export function ProfileRespect(props: { user: User }) {
  const { t } = useLingui();
  const client = useClient();
  const queryClient = useQueryClient();

  const [draft, setDraft] = createSignal("");
  const [pending, setPending] = createSignal(false);

  const query = useQuery(() => ({
    queryKey: ["respect", props.user.id],
    queryFn: () => props.user.fetchRespect(),
    retry: (failureCount, error) =>
      !isProfilePrivateError(error) && failureCount < 3,
  }));

  const selfId = () => client().user!.id;

  /** The owner and their friends may write (bots have no walls). */
  const canWrite = () =>
    !props.user.bot &&
    (props.user.self || props.user.relationship === "Friend");

  const ownEntry = () =>
    query.data?.respect.find((entry) => entry.author_id === selfId());

  /** Your own entry is always deletable; the owner curates everything. */
  const canDelete = (authorId: string) =>
    authorId === selfId() || props.user.self;

  const author = (authorId: string) => client().users.get(authorId);

  async function submit(event: Event) {
    event.preventDefault();
    const content = draft().trim();
    if (!content || pending()) return;

    setPending(true);
    try {
      await props.user.giveRespect(content);
      setDraft("");
      queryClient.invalidateQueries({ queryKey: ["respect", props.user.id] });
    } finally {
      setPending(false);
    }
  }

  async function remove(authorId: string) {
    if (pending()) return;
    setPending(true);
    try {
      await props.user.removeRespect(authorId);
      queryClient.invalidateQueries({ queryKey: ["respect", props.user.id] });
    } finally {
      setPending(false);
    }
  }

  return (
    <Show when={query.data?.respect.length || canWrite()}>
      <ProfileCard width={3}>
        <Text class="title" size="large">
          <Trans>Respect</Trans>
        </Text>

        <Show when={query.data?.respect.length}>
          <Entries>
            <For each={query.data?.respect}>
              {(entry) => (
                <Entry>
                  <Avatar
                    src={author(entry.author_id)?.animatedAvatarURL}
                    fallback={author(entry.author_id)?.displayName}
                    size={28}
                  />
                  <EntryBody>
                    <EntryMeta>
                      <AuthorName>
                        {author(entry.author_id)?.displayName ?? (
                          <Trans>Unknown user</Trans>
                        )}
                      </AuthorName>
                      <EntryTime>
                        {new Date(entry.updated_at).toLocaleDateString()}
                      </EntryTime>
                    </EntryMeta>
                    <EntryContent>{entry.content}</EntryContent>
                  </EntryBody>
                  <Show when={canDelete(entry.author_id)}>
                    <IconButton
                      size="xs"
                      onPress={() => void remove(entry.author_id)}
                    >
                      <MdClose />
                    </IconButton>
                  </Show>
                </Entry>
              )}
            </For>
          </Entries>
        </Show>

        <Show when={canWrite()}>
          <Compose onSubmit={submit}>
            <TextField
              value={draft()}
              maxlength={240}
              placeholder={
                ownEntry()
                  ? t`Rewrite your respect…`
                  : t`Write something nice…`
              }
              onInput={(event) => setDraft(event.currentTarget.value)}
            />
            <Button
              size="sm"
              type="submit"
              isDisabled={!draft().trim() || pending()}
            >
              <Show when={ownEntry()} fallback={<Trans>Give respect</Trans>}>
                <Trans>Update</Trans>
              </Show>
            </Button>
          </Compose>
        </Show>
      </ProfileCard>
    </Show>
  );
}

const Entries = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    maxHeight: "220px",
    overflowY: "auto",
  },
});

const Entry = styled("div", {
  base: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--gap-md)",
    minWidth: 0,
  },
});

const EntryBody = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-xs)",
    flexGrow: 1,
    minWidth: 0,
  },
});

const EntryMeta = styled("div", {
  base: {
    display: "flex",
    alignItems: "baseline",
    gap: "var(--gap-sm)",
    minWidth: 0,
  },
});

const AuthorName = styled("span", {
  base: {
    ...typography.raw({ class: "label" }),
    fontWeight: 600,
  },
});

const EntryTime = styled("span", {
  base: {
    ...typography.raw({ class: "label", size: "small" }),
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const EntryContent = styled("span", {
  base: {
    ...typography.raw({ class: "_messages" }),
    userSelect: "text",
    overflowWrap: "anywhere",
  },
});

const Compose = styled("form", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});
