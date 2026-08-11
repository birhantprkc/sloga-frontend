import { createFormControl, createFormGroup } from "solid-forms";

import { Trans, useLingui } from "@lingui-solid/solid/macro";

import { Dialog, DialogProps, Form2 } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Add a new friend by username
 */
export function AddFriendModal(
  props: DialogProps & Modals & { type: "add_friend" },
) {
  const { t } = useLingui();
  const { showError } = useModals();

  const group = createFormGroup({
    username: createFormControl("", { required: true }),
    note: createFormControl(""),
  });

  async function onSubmit() {
    try {
      const note = group.controls.note.value.trim();
      await props.client.api.post(`/users/friend`, {
        username: group.controls.username.value,
        // `note` is additive; stoat-api 0.13.5 predates it
        ...(note ? { note } : {}),
      } as { username: string });

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
      title={<Trans>Add a new friend</Trans>}
      actions={[
        { text: <Trans>Close</Trans> },
        {
          text: <Trans>Send Request</Trans>,
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
        <Form2.TextField
          name="username"
          control={group.controls.username}
          label={t`Username`}
          placeholder={t`username#1234`}
        />
        <Form2.TextField
          name="note"
          control={group.controls.note}
          label={t`Note (optional)`}
          placeholder={t`Tell them why you're adding them`}
          maxlength={200}
        />
      </form>
    </Dialog>
  );
}
