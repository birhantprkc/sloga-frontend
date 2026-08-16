import { onCleanup } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Dialog, DialogProps } from "@revolt/ui";

import { Modals } from "../types";

/**
 * Edit a pending image attachment before it is sent.
 *
 * Slice 1: plumbing only — shows the image and round-trips the file
 * unchanged through onSave, which replaces the draft entry (and with it
 * any stale uploaded id). The editor core (crop/annotate/redact) lands
 * behind a dynamic import in slice 2.
 */
export function ImageEditorModal(
  props: DialogProps & Modals & { type: "image_editor" },
) {
  // modal props are fixed for the lifetime of this instance
  // eslint-disable-next-line solid/reactivity
  const dataUri = URL.createObjectURL(props.file);
  onCleanup(() => URL.revokeObjectURL(dataUri));

  return (
    <Dialog
      show={props.show}
      onClose={props.onClose}
      title={<Trans>Edit image</Trans>}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Apply</Trans>,
          onClick: () => props.onSave(props.file),
        },
      ]}
    >
      <Preview src={dataUri} alt={props.file.name} />
    </Dialog>
  );
}

const Preview = styled("img", {
  base: {
    maxWidth: "100%",
    maxHeight: "60vh",
    objectFit: "contain",
    borderRadius: "var(--borderRadius-md)",
  },
});
