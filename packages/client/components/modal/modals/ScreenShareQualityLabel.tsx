import { For } from "solid-js";

/**
 * Two-line label for a screen share quality tier: resolution above, framerate
 * below.
 *
 * The break used to be accidental. The label was a single string in a button
 * too narrow to hold it, so it wrapped at its space — which meant the break
 * appeared or vanished purely on width. Widening the dialog to fit "Source"
 * left "4K 30FPS" short enough to fit on one line while every other tier still
 * wrapped, so the row read inconsistently. Splitting it here makes every tier
 * two lines regardless of how wide the button ends up.
 */
export function ScreenShareQualityLabel(props: { fullName: string }) {
  // Split on the LAST space: the framerate is always the final token, but the
  // resolution ahead of it is not guaranteed to be one word. No space at all
  // (a future translation, say) simply renders on a single line rather than
  // dropping half the label.
  const lines = () => {
    const at = props.fullName.lastIndexOf(" ");
    return at === -1
      ? [props.fullName]
      : [props.fullName.slice(0, at), props.fullName.slice(at + 1)];
  };

  return (
    <span
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "line-height": "1.15",
        // Backstop: neither half may be split mid-word if a button is ever
        // narrower than one of them. "keep-all" beats a word-break: break-all
        // and "normal" beats an overflow-wrap: break-word.
        "word-break": "keep-all",
        "overflow-wrap": "normal",
      }}
    >
      <For each={lines()}>{(line) => <span>{line}</span>}</For>
    </span>
  );
}
