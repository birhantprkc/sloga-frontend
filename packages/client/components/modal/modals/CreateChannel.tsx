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
} from "@revolt/ui";

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
    category: createFormControl(props.categoryId ?? "default"),
  });

  /**
   * Real categories on the server ("default" is the synthetic uncategorised
   * bucket, offered as the "No category" option instead)
   */
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
