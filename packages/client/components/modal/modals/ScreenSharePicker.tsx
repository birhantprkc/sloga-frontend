import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Avatar, Column, Dialog, DialogProps, Form2, Ripple } from "@revolt/ui";

import { createMemo } from "solid-js";
import { styled } from "styled-system/jsx";
import { ScreenShareQualityLabel } from "./ScreenShareQualityLabel";
import { Modals } from "../types";

export function ScreenSharePickerModal(
  props: DialogProps & Modals & { type: "screen_share_picker" },
) {
  const { voice } = useState();
  const { t } = useLingui();

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(
      voice.screenShareQuality || "low",
    ),
    audio: createFormControl(voice.screenShareAudio),
    idx: createFormControl([0], { required: true }),
  });

  async function onSubmit() {
    props.callback(
      group.controls.idx.value[0],
      group.controls.qualityName.value,
      group.controls.audio.value,
    );
    props.onClose();
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  const sources = createMemo(() =>
    props.sources.map((source) => {
      return { item: source, value: source.idx };
    }),
  );

  return (
    // 820 is deliberately past Dialog's own 560px maxWidth -- an inline
    // min-width beats max-width in CSS, which is the only way to widen this.
    // It has to be wide: Form2.ButtonGroup renders its Row with
    // justify="stretch", i.e. `& * { flex: 1 }`, so every tier button is
    // forced to an identical flex-basis:0 width no matter what it says.
    // Content width is ignored, so total dialog width is the ONLY lever;
    // below ~117px/button the button is narrower than "Source" and splits
    // the word. 700 covered six tiers; the Game tier makes seven.
    <Dialog
      minWidth={820}
      show={props.show}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
      title={t`Pick a Screen to Share`}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Go</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
        },
      ]}
    >
      <form onSubmit={submit}>
        <Column>
          <Form2.VirtualSelect
            control={group.controls.idx}
            items={sources()}
            selectHeight="max(30vh, 200px)"
            isMaxHeight={true}
            itemHeight={60}
          >
            {(val, selected) => (
              <Item selected={selected}>
                <Ripple />
                <Avatar
                  src={val.image}
                  fallback={val.name}
                  size={36}
                  shape="rounded-square"
                />
                <span>{val.name}</span>
              </Item>
            )}
          </Form2.VirtualSelect>
          <Form2.ButtonGroup
            control={group.controls.qualityName}
            buttonDefinitions={props.qualities.map((quality) => {
              return {
                children: (
                  <ScreenShareQualityLabel fullName={quality.fullName} />
                ),
                value: quality.name,
              };
            })}
          />
          <Form2.Checkbox control={group.controls.audio}>
            <Trans>Share audio</Trans>
          </Form2.Checkbox>
        </Column>
      </form>
    </Dialog>
  );
}

const Item = styled("div", {
  base: {
    height: "60px",
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
