import { For, Show, createResource, createSignal } from "solid-js";

import { Plural, Trans } from "@lingui-solid/solid/macro";
import { type DiscoverableServerData, File } from "stoat.js";
import { styled } from "styled-system/jsx";

import {
  Avatar,
  Button,
  Column,
  Dialog,
  DialogProps,
  Row,
  Text,
} from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Card as returned by the privileged requests route: the public card plus
 * the owner's user id (only ever populated on this route)
 */
type RequestCard = DiscoverableServerData & { owner?: string };

const Card = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-high)",
  },
});

const Title = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    fontWeight: 600,
    color: "var(--md-sys-color-on-surface)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    justifyContent: "flex-end",
    marginTop: "var(--gap-xs)",
  },
});

/**
 * Review queue for public-directory listing requests (privileged only).
 * Approve = `discoverable: true` (server-side clears the request);
 * reject = `discovery_requested: false`.
 */
export function DiscoveryQueueModal(
  props: DialogProps & Modals & { type: "discovery_queue" },
) {
  const { showError } = useModals();

  // Ids with an in-flight approve/reject, to disable their buttons
  const [busy, setBusy] = createSignal<string[]>([]);

  /**
   * Call a discovery/server route directly.
   *
   * stoat-api's typed client silently drops the body of requests to routes
   * missing from its generated route tables, so go through fetch instead
   * (same reasoning as the report queue).
   */
  async function apiCall(method: string, path: string, body?: unknown) {
    const api = props.client.api as unknown as {
      baseURL: string;
      auth: Record<string, string>;
    };

    const response = await fetch(api.baseURL + path, {
      method,
      headers: {
        ...api.auth,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) throw await response.text();
    return response.status === 204 ? null : response.json();
  }

  const [requests, { refetch }] = createResource(async () => {
    const { servers } = (await apiCall("GET", "/discover/requests")) as {
      servers: RequestCard[];
    };

    // Owners are usually strangers to the reviewer, so they are not in the
    // cache; pull them in so the cards show a name instead of an id.
    // Best-effort — a failed lookup just leaves the id visible.
    await Promise.allSettled(
      servers
        .map((server) => server.owner)
        .filter((id): id is string => !!id && !props.client.users.has(id))
        .map((id) => props.client.users.fetch(id)),
    );

    return servers;
  });

  /**
   * Best-effort display name for a user id
   */
  function username(id?: string) {
    if (!id) return "unknown";
    const user = props.client.users.get(id);
    return user ? `${user.username}#${user.discriminator}` : id;
  }

  /**
   * Approve or reject one request
   */
  async function review(server: RequestCard, approve: boolean) {
    setBusy((list) => [...list, server._id]);
    try {
      await apiCall(
        "PATCH",
        `/servers/${server._id}`,
        approve ? { discoverable: true } : { discovery_requested: false },
      );
      refetch();
    } catch (error) {
      showError(error);
    } finally {
      setBusy((list) => list.filter((id) => id !== server._id));
    }
  }

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Listing requests</Trans>}
      actions={[{ text: <Trans>Close</Trans> }]}
    >
      <Column>
        <Show when={requests.loading && !requests.latest}>
          <Text>
            <Trans>Loading requests…</Trans>
          </Text>
        </Show>
        <Show when={requests()?.length === 0}>
          <Text>
            <Trans>No pending listing requests. All clear!</Trans>
          </Text>
        </Show>
        <For each={requests()}>
          {(server) => (
            <Card>
              <Title>
                <Avatar
                  size={32}
                  src={
                    server.icon
                      ? new File(props.client, server.icon).previewUrl
                      : undefined
                  }
                  fallback={server.name}
                />
                <span>{server.name}</span>
              </Title>
              <Show when={server.description}>
                <Text>{server.description}</Text>
              </Show>
              <Text class="label">
                <Plural
                  value={server.member_count}
                  one="# member"
                  other="# members"
                />
                {" · "}
                <Trans>Owner</Trans>: {username(server.owner)}
              </Text>
              <Actions>
                <Row>
                  <Button
                    variant="tonal"
                    size="sm"
                    isDisabled={busy().includes(server._id)}
                    onPress={() => review(server, false)}
                  >
                    <Trans>Reject</Trans>
                  </Button>
                  <Button
                    variant="filled"
                    size="sm"
                    isDisabled={busy().includes(server._id)}
                    onPress={() => review(server, true)}
                  >
                    <Trans>Approve</Trans>
                  </Button>
                </Row>
              </Actions>
            </Card>
          )}
        </For>
      </Column>
    </Dialog>
  );
}
