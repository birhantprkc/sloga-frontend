import { onCleanup, onMount } from "solid-js";

/**
 * `<input>` types that hold no text, so the native menu offers them nothing.
 */
const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

/**
 * Whether the browser's own menu is the only thing that can serve this
 * right-click, so the guard has to stand down.
 * @param event Context menu event
 */
function nativeMenuIsTheOnlyOption(event: MouseEvent) {
  // Shift+right-click is the browser-wide "page, keep out of it" gesture —
  // Firefox honours it natively — and here it is the only way to reach the
  // affordances Sloga has no menu of its own for: Save image as…, Picture in
  // picture on a screenshare tile, View source, Inspect.
  if (event.shiftKey) return true;

  // Paste, spellcheck suggestions and Undo live only in the native menu, and
  // right-click → Paste is how a good number of people paste at all, so every
  // text field keeps it.
  //
  // This walks `composedPath` rather than looking at `event.target`, because
  // every text field in the app is an `<input>` inside an `mdui-*` element's
  // shadow root and events retarget to the host on the way out: `event.target`
  // is `<mdui-text-field>`, and no amount of `closest("input")` will ever find
  // the input. `composedPath` is the only view that still contains it.
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof HTMLElement &&
        (node.isContentEditable ||
          node instanceof HTMLTextAreaElement ||
          (node instanceof HTMLInputElement &&
            !NON_TEXT_INPUTS.has(node.type))),
    );
}

/**
 * Stop the browser from offering its own context menu where Sloga has nothing
 * to say.
 *
 * `use:floating` already cancels the event on everything it is attached to —
 * a message, a member, a channel, a server — so those right-clicks only ever
 * showed Sloga's menu. Everywhere else (the background behind the channel
 * list, sidebar padding, the member list's empty space, call chrome) the
 * browser's menu came up instead, complete with the host's extensions and
 * Ask Gemini, which is not something an app window should be handing out.
 *
 * Three things about the shape of this are load-bearing:
 *
 * - **Bubble phase, on `window`.** `floating.ts` bails out of opening Sloga's
 *   menu when it sees `defaultPrevented` (it has to: an overlay that claimed
 *   the right-click must not get a Sloga menu painted over it). A
 *   capture-phase guard therefore inverts the whole feature — it would cancel
 *   the event before the element handler ran and suppress every Sloga menu
 *   while the browser's stayed. Running last, after the element handlers that
 *   `stopPropagation`, means this only ever sees the right-clicks nobody
 *   claimed.
 * - **Mouse only.** A long-press on Android and the keyboard Menu key both
 *   arrive as `contextmenu` with `button` 0. Swallowing those would cost
 *   mobile text selection and keyboard access, and neither one is the
 *   browser-chrome menu this is here to hide.
 * - **It never stops propagation.** Anything downstream that wants the event
 *   still gets it; the only effect is on the browser's default action.
 */
export function ContextMenuGuard() {
  /**
   * Deny the browser its menu
   * @param event Context menu event
   */
  function onContextMenu(event: MouseEvent) {
    if (event.defaultPrevented) return;
    if (event.button !== 2) return;
    if (nativeMenuIsTheOnlyOption(event)) return;

    event.preventDefault();
  }

  onMount(() => window.addEventListener("contextmenu", onContextMenu));
  onCleanup(() => window.removeEventListener("contextmenu", onContextMenu));

  return <></>;
}
