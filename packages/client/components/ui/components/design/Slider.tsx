import { type JSX, createEffect, createSignal, on, splitProps } from "solid-js";

import { styled } from "styled-system/jsx";

import "mdui/components/slider.js";

type Props = Omit<
  JSX.HTMLAttributes<HTMLInputElement>,
  "onChange" | "onInput"
> & {
  min?: number;
  max?: number;
  step?: number;
  value: number;
  tickmarks?: boolean;
  labelFormatter?: (value: number) => string;
  onChange?: (event: { currentTarget: { value: number } }) => void;
  onInput?: (event: { currentTarget: { value: number } }) => void;
};

/**
 * Sliders let users make selections from a range of values
 *
 * @library MDUI
 * @specification https://m3.material.io/components/sliders
 */
export function Slider(props: Props) {
  const [ref, setRef] = createSignal<{
    labelFormatter?: (value: number) => string;
  }>();

  const [local, rest] = splitProps(props, ["labelFormatter"]);

  createEffect(
    on(ref, (ref) => {
      if (ref && local.labelFormatter) {
        ref.labelFormatter = local.labelFormatter;
      }
    }),
  );

  return <StyledSlider ref={setRef} {...rest} />;
}

/**
 * Panda's preflight reset (* { padding: 0 }) wins over the component's
 * internal :host padding, which is what reserves room for the handle at
 * the ends of the track — restore it so the handle is not clipped.
 */
const StyledSlider = styled("mdui-slider", {
  base: {
    paddingInline: "1.25rem",
  },
});
