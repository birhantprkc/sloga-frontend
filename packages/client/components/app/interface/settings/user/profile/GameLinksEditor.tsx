import { For, Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { useQueryClient } from "@tanstack/solid-query";
import type { API, User } from "stoat.js";

import { LINK_PLATFORM_NAMES } from "@revolt/ui";
import {
  Button,
  Column,
  FloatingSelect,
  IconButton,
  MenuItem,
  Row,
  Text,
  TextField,
  useSnackbar,
} from "@revolt/ui";

import MdClose from "@material-design-icons/svg/outlined/close.svg?component-solid";

/** A game-account link as the API carries it. */
type Link = { platform: string; handle: string };

/**
 * Game IDs editor — self-declared platform handles shown on the profile.
 *
 * Saves on change (Privacy.tsx pattern) rather than joining the profile
 * form's solid-forms group: dynamic rows fight the form abstraction. Every
 * mutation sends the FULL list — the backend replaces wholesale, and an
 * empty list clears.
 */
export function GameLinksEditor(props: { user: User; links?: Link[] }) {
  const { t } = useLingui();
  const snackbar = useSnackbar();
  const queryClient = useQueryClient();

  const [platform, setPlatform] = createSignal<string | null>(null);
  const [handle, setHandle] = createSignal("");
  const [saving, setSaving] = createSignal(false);

  const links = () => props.links ?? [];

  const availablePlatforms = () =>
    Object.keys(LINK_PLATFORM_NAMES).filter(
      (key) => !links().some((link) => link.platform === key),
    );

  async function save(next: Link[]) {
    if (saving()) return;
    setSaving(true);
    try {
      // `profile.links` is additive; stoat-api 0.13.5 predates it
      await props.user.edit({
        remove: [],
        profile: { links: next },
      } as API.DataEditUser & { profile: { links: Link[] } });
      queryClient.invalidateQueries({
        queryKey: ["profile", props.user.id],
      });
    } catch {
      snackbar.show({
        message: t`Could not update your game IDs, try again.`,
      });
    } finally {
      setSaving(false);
    }
  }

  function add(event: Event) {
    event.preventDefault();
    const selected = platform();
    const value = handle().trim();
    if (!selected || !value || links().length >= 12) return;

    void save([...links(), { platform: selected, handle: value }]).then(() => {
      setPlatform(null);
      setHandle("");
    });
  }

  function remove(index: number) {
    void save(links().filter((_, position) => position !== index));
  }

  return (
    <Column>
      <Text class="label">
        <Trans>Game IDs</Trans>
      </Text>
      <Text class="_status" size="small">
        <Trans>
          Add your player IDs so friends can find you in-game. Shown on your
          profile, click-to-copy.
        </Trans>
      </Text>

      <For each={links()}>
        {(link, index) => (
          <Row align>
            <Text class="label">
              {LINK_PLATFORM_NAMES[link.platform] ?? link.platform}
            </Text>
            <Handle>{link.handle}</Handle>
            <IconButton size="xs" onPress={() => remove(index())}>
              <MdClose />
            </IconButton>
          </Row>
        )}
      </For>

      <Show when={links().length < 12}>
        <form onSubmit={add}>
          <Row align>
            <FloatingSelect
              label={t`Platform`}
              value={platform() ?? undefined}
              onChange={(event) =>
                setPlatform(event.currentTarget.value ?? null)
              }
            >
              <For each={availablePlatforms()}>
                {(key) => (
                  <MenuItem value={key}>{LINK_PLATFORM_NAMES[key]}</MenuItem>
                )}
              </For>
            </FloatingSelect>
            <TextField
              value={handle()}
              maxlength={64}
              placeholder={t`Player ID or handle`}
              onInput={(event) => setHandle(event.currentTarget.value)}
            />
            <Button
              size="sm"
              type="submit"
              isDisabled={!platform() || !handle().trim() || saving()}
            >
              <Trans>Add</Trans>
            </Button>
          </Row>
        </form>
      </Show>
    </Column>
  );
}

function Handle(props: { children: string }) {
  return (
    <span style={{ "flex-grow": 1, "user-select": "text", "min-width": 0 }}>
      {props.children}
    </span>
  );
}
