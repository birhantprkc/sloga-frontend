import { For, Show, createMemo } from "solid-js";

import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { useNavigate } from "@revolt/routing";
import {
  Column,
  Dialog,
  DialogProps,
  Form2,
  MenuItem,
  Radio2,
  Text,
} from "@revolt/ui";

import {
  afkCreateChannelFields,
  effectiveAfkTimeout,
} from "../../../src/lib/afkChannelSettings";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to create a new server channel
 */
export function CreateChannelModal(
  props: DialogProps & Modals & { type: "create_channel" },
) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const { showError } = useModals();

  const group = createFormGroup({
    name: createFormControl("", { required: true }),
    type: createFormControl("Text"),
    announcement: createFormControl(false),
    afk: createFormControl(false),
    // Seeded from the server's current idle timeout, not from a constant.
    // Designating a channel without naming a timeout makes the backend KEEP
    // the timeout the server already had — which may have been chosen for a
    // different channel by somebody else. Seeding the select from it, and
    // sending the seeded value back, is what stops that adoption being
    // invisible.
    afkTimeout: createFormControl(
      String(effectiveAfkTimeout(props.server.afkTimeout)),
    ),
    category: createFormControl(props.categoryId ?? "default"),
  });

  /**
   * Real categories on the server ("default" is the synthetic uncategorised
   * bucket, offered as the "No category" option instead)
   */
  /**
   * Whether to offer the AFK option at all.
   *
   * 🔴 ManageServer, not the ManageChannel that got you into this modal. The
   * AFK designation is a server field and the create route demands BOTH bits;
   * offering the tickbox to someone holding only ManageChannel would turn the
   * whole channel creation into a 403, not just the AFK half of it.
   */
  const canDesignateAfk = () => props.server.havePermission("ManageServer");

  const categories = createMemo(() =>
    props.server.orderedChannels.filter(
      (category) => category.id !== "default",
    ),
  );

  async function onSubmit() {
    try {
      const channel = await props.server.createChannel({
        // "Forum" is an additive server channel type the typed client
        // predates; the route passes it through verbatim.
        type: group.controls.type.value as "Text" | "Voice",
        name: group.controls.name.value,
        // `announcement` is additive (stoat-api predates it) and only
        // meaningful on text channels — pass it through verbatim.
        ...(group.controls.type.value === "Text" &&
        group.controls.announcement.value
          ? { announcement: true }
          : {}),
        // `afk` / `afk_timeout` are additive too, and only meaningful on a
        // voice channel. The mapper drops them on every other type, because
        // the route rejects `afk: true` outright rather than ignoring it —
        // ticking the box and then switching the radio back to Text would
        // otherwise be a 400.
        ...afkCreateChannelFields({
          channelType: group.controls.type.value,
          afk: group.controls.afk.value,
          timeoutSeconds: Number(group.controls.afkTimeout.value),
        }),
      } as never);

      // File the channel into the chosen category; without this edit it
      // stays in the uncategorised block. The new id is filtered out of
      // every category first so a racing ChannelCreate event cannot
      // duplicate it; if the category was deleted meanwhile, the channel
      // simply stays uncategorised.
      const categoryId = group.controls.category.value;
      if (categoryId !== "default") {
        await props.server.edit({
          categories: props.server.orderedChannels.map((category) => ({
            ...category,
            channels: category.channels
              .map((entry) => entry.id)
              .filter((id) => id !== channel.id)
              .concat(category.id === categoryId ? [channel.id] : []),
          })),
        });
      }

      if (props.cb) {
        props.cb(channel);
      } else {
        navigate(`/server/${props.server.id}/channel/${channel.id}`);
      }

      props.onClose();
    } catch (error) {
      showError(error);
    }
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Create channel</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Create</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
          isDisabled: !Form2.canSubmit(group),
        },
      ]}
      isDisabled={group.isPending}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.TextField
            minlength={1}
            maxlength={32}
            counter
            name="name"
            control={group.controls.name}
            label={t`Channel Name`}
          />

          <Form2.Radio control={group.controls.type}>
            <Radio2.Option value="Text">
              <Trans>Text Channel</Trans>
            </Radio2.Option>
            <Radio2.Option value="Voice">
              <Trans>Voice Channel</Trans>
            </Radio2.Option>
            <Radio2.Option value="Forum">
              <Trans>Forum Channel</Trans>
            </Radio2.Option>
          </Form2.Radio>

          <Show when={group.controls.type.value === "Text"}>
            <Form2.Checkbox
              name="announcement"
              control={group.controls.announcement}
            >
              <Trans>Announcement channel</Trans>
            </Form2.Checkbox>
          </Show>

          <Show
            when={group.controls.type.value === "Voice" && canDesignateAfk()}
          >
            <Form2.Checkbox name="afk" control={group.controls.afk}>
              <Trans>AFK channel</Trans>
            </Form2.Checkbox>

            <Show when={group.controls.afk.value}>
              <Text>
                <Trans>
                  Nobody can speak, share video or share their screen in the AFK
                  channel. A server has one AFK channel, so choosing this one
                  replaces any previous choice.
                </Trans>
              </Text>

              {/* AFK_TIMEOUT_PRESETS contract: these five options are pinned
                  to AFK_TIMEOUT_PRESETS by src/lib/afkChannelSettings.test.ts,
                  which fails if they drift. Written out rather than generated
                  from the list because each needs its own lingui message, and
                  because the slowmode select in channel settings — the select
                  this copies — is written the same way. The value shown is the
                  timeout this server already has, so a timeout inherited from
                  an earlier AFK channel is visible before it is adopted. */}
              <Form2.Select
                label={t`Move idle members here after`}
                control={group.controls.afkTimeout}
              >
                <MenuItem value="60">
                  <Trans>1 minute</Trans>
                </MenuItem>
                <MenuItem value="300">
                  <Trans>5 minutes</Trans>
                </MenuItem>
                <MenuItem value="900">
                  <Trans>15 minutes</Trans>
                </MenuItem>
                <MenuItem value="1800">
                  <Trans>30 minutes</Trans>
                </MenuItem>
                <MenuItem value="3600">
                  <Trans>1 hour</Trans>
                </MenuItem>
              </Form2.Select>
            </Show>
          </Show>

          <Show when={categories().length}>
            <Form2.Select label={t`Category`} control={group.controls.category}>
              <MenuItem value="default">
                <Trans>No category</Trans>
              </MenuItem>
              <For each={categories()}>
                {(category) => (
                  <MenuItem value={category.id}>{category.title}</MenuItem>
                )}
              </For>
            </Form2.Select>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
