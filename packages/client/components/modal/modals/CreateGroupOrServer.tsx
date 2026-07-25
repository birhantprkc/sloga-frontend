import { Trans } from "@lingui-solid/solid/macro";

import { importDiscordEnabled } from "@revolt/client/discordImport";
import { Dialog, DialogProps } from "@revolt/ui";

import { useModals } from "..";
import { Modals } from "../types";

/**
 * Modal to create a group or server
 */
export function CreateGroupOrServer(
  props: DialogProps & Modals & { type: "create_group_or_server" },
) {
  const { openModal } = useModals();

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title="Start a Chat Room or Server"
      actions={[
        {
          text: "Chat Room",
          onClick: () => {
            openModal({
              type: "create_group",
              client: props.client,
            });
          },
        },
        {
          text: "Server",
          onClick: () => {
            openModal({
              type: "create_server",
              client: props.client,
            });
          },
        },
        // Kept in sync with the same entry in CreateOrJoinServer — both
        // fan-outs must offer it or the entry point becomes path-dependent.
        ...(importDiscordEnabled()
          ? [
              {
                text: <Trans>Import from Discord</Trans>,
                onClick: () => {
                  openModal({ type: "import_discord", client: props.client });
                },
              },
            ]
          : []),
      ]}
    >
      <Trans>Which would you like to Start?</Trans>
    </Dialog>
  );
}
