import { Trans } from "@lingui-solid/solid/macro";

import { useClientLifecycle } from "@revolt/client";
import { Dialog, DialogProps } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Modal to confirm signing out of the current session.
 *
 * `logout()` drops the stored session and tears the client down — there is no
 * undo — so the user menu entry routes through here instead of calling it
 * straight from a single click.
 */
export function SignOutModal(
  props: DialogProps & Modals & { type: "sign_out" },
) {
  const { logout } = useClientLifecycle();

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Are you sure you want to Sign out?</Trans>}
      actions={[
        {
          text: <Trans>No</Trans>,
          onClick: () => {
            props.onClose();
            return false;
          },
        },
        {
          text: <Trans>Yes</Trans>,
          onClick: () => {
            // Close first: logout() transitions the lifecycle out from under
            // this tree, and the modal must not be left on the stack.
            props.onClose();
            logout();
            return false;
          },
        },
      ]}
    >
      <Trans>You'll need to log in again to get back to your messages.</Trans>
    </Dialog>
  );
}
