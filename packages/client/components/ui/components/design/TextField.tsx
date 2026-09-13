import type { JSX } from "solid-js";

import "mdui/components/select.js";
import "mdui/components/text-field.js";
import { cva } from "styled-system/css";

type Props = JSX.HTMLAttributes<HTMLInputElement> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value?: any;
  autoFocus?: boolean;
  required?: boolean;
  name?: string;
  label?: string;
  autosize?: boolean;
  disabled?: boolean;
  rows?: number;
  "min-rows"?: number;
  "max-rows"?: number;
  maxlength?: number;
  minlength?: number;
  counter?: boolean;
  placeholder?: string;
  type?:
    | "text"
    | "number"
    | "password"
    | "url"
    | "email"
    | "search"
    | "tel"
    | "hidden"
    | "date"
    | "datetime-local"
    | "month"
    | "time"
    | "week";
  variant?: "filled" | "outlined";
  enterkeyhint?:
    | "enter"
    | "done"
    | "go"
    | "next"
    | "previous"
    | "search"
    | "find";
  helper?: string;
  "helper-on-focus"?: boolean;
  clearable?: boolean;
  "clear-icon"?: string;
  "end-aligned"?: boolean;
  prefix?: string;
  suffix?: string;
  icon?: string;
  "end-icon"?: string;
  "error-icon"?: string;
  form?: string;
  readonly?: boolean;
  min?: number;
  max?: number;
  step?: number;
  pattern?: string;
  "toggle-password"?: boolean;
  showPasswordIcon?: string;
  hidePasswordIcon?: string;
  autocapitalize?: "none" | "sentences" | "words" | "characters";
  autocorrect?: string;
  autocomplete?: string;
  spellcheck?: boolean;
  inputmode?:
    | "none"
    | "text"
    | "decimal"
    | "numeric"
    | "tel"
    | "search"
    | "email"
    | "url";
  autofocus?: boolean;
  tabindex?: number;
};

const field = cva({
  base: { cursor: "text" },
});

/**
 * Text fields let users enter text into a UI
 *
 * @library MDUI
 * @specification https://m3.material.io/components/text-fields
 */
export function TextField(props: Props) {
  /**
   * mdui submits the surrounding form on a plain Enter, and it binds that
   * handler to its multi-line `<textarea>` as well as to `<input>`. So a
   * multi-line field could never take a line break: the newline went in and
   * the form submitted on the next tick (the forum post composer, reported
   * 2026-09-11; the channel and server description fields did it too).
   *
   * Stopping the event in the CAPTURE phase at the host keeps it from ever
   * reaching mdui's listener inside the shadow root, while its default
   * action, inserting the line break, still happens. Never `preventDefault`
   * here: that would cancel the line break itself.
   */
  function keepEnterInMultiline(event: KeyboardEvent) {
    const multiline = props.autosize || (props.rows ?? 1) > 1;
    const modified =
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

    if (multiline && event.key === "Enter" && !modified) {
      event.stopPropagation();
    }
  }

  return (
    <mdui-text-field
      {...props}
      class={field()}
      oncapture:keydown={keepEnterInMultiline}
      // @codegen directives props=props include=autoComplete
    />
  );
}
