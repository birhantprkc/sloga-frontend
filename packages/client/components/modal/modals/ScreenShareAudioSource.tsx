import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { Avatar, Column, Dialog, DialogProps, Form2, Ripple } from "@revolt/ui";

import { createMemo } from "solid-js";
import { styled } from "styled-system/jsx";
import { Modals } from "../types";

/**
 * "Which app's audio?" — the explicit chooser for a Linux window share
 * (screenshare-audio design §9).
 *
 * It exists because matching a shared window to an audio stream is not
 * always possible: the Wayland portal never says which window the
 * compositor handed over, X11 windows can belong to a wrapper process, and
 * one process tree can host two applications. The design's privacy rule
 * says a silent auto-match is allowed ONLY on an exact single-application
 * match — anything else lands here, because broadcasting a different app's
 * audio than the user believes they are sharing is a privacy failure, not
 * a UX nit.
 *
 * Nothing is captured until a row is picked. Dismissing the dialog without
 * choosing (Cancel, Escape, or a click outside — the repo's dialogs can
 * close without running `onCancel`) therefore leaves the share silent,
 * which is the safe direction for this particular fail-open.
 */
export function ScreenShareAudioSourceModal(
  props: DialogProps & Modals & { type: "screen_share_audio_source" },
) {
  const { t } = useLingui();

  // Nothing is pre-selected on purpose: a highlighted first row turns one
  // hurried click into "share whatever happened to be at the top", which
  // is the wrong-app broadcast this dialog exists to prevent. `required`
  // also stops FormVirtualSelect's re-click-to-deselect, so a row the user
  // can see is selected cannot silently become no selection.
  const group = createFormGroup({
    key: createFormControl<string[]>([], { required: true }),
  });

  const chosen = () => group.controls.key.value[0];

  function onSubmit() {
    const key = chosen();
    // No pick yet — leave the dialog open rather than closing into a
    // silent share the user did not ask for. The action is disabled in
    // this state, so this is a backstop, not the UI.
    if (!key) return;
    props.callback(key);
    props.onClose();
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  const apps = createMemo(() =>
    props.apps.map((app) => ({ item: app, value: app.key })),
  );

  return (
    <Dialog
      show={props.show}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
      title={t`Which app's audio?`}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Share audio</Trans>,
          // Disabled until something is picked: a button that silently
          // does nothing reads as broken, and the alternative — closing
          // into a silent share — is worse.
          isDisabled: !chosen(),
          onClick: () => {
            onSubmit();
            return false;
          },
        },
      ]}
    >
      <form onSubmit={submit}>
        <Column>
          {/* Deliberately reason-agnostic: this dialog is raised by an
              opaque Wayland portal, an unreadable or lying window pid, two
              applications in one process tree, and a resolution that timed
              out. Naming any one of those would be wrong for the others. */}
          <small>
            <Trans>
              Sloga can't tell which app's sound belongs to this share, so pick
              the one you want to send.
            </Trans>
          </small>
          <Form2.VirtualSelect
            control={group.controls.key}
            items={apps()}
            selectHeight="max(30vh, 160px)"
            isMaxHeight={true}
            itemHeight={52}
          >
            {(app, selected) => (
              <Item selected={selected}>
                <Ripple />
                <Avatar fallback={app.name} size={32} shape="rounded-square" />
                <span>{app.name}</span>
              </Item>
            )}
          </Form2.VirtualSelect>
          <small>
            <Trans>
              Only apps that are playing sound right now are listed.
            </Trans>
          </small>
        </Column>
      </form>
    </Dialog>
  );
}

const Item = styled("div", {
  base: {
    height: "52px",
    display: "flex",
    position: "relative",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-sm)",
  },
  variants: {
    selected: {
      true: {
        color: "var(--md-sys-color-on-primary)",
        background: "var(--md-sys-color-primary)",
      },
    },
  },
});
