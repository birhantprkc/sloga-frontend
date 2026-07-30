import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";

import { unicodeEmojiPackPrefix } from "@revolt/markdown/emoji/UnicodeEmoji";
import { useState } from "@revolt/state";

import { isInCodeBlock } from "./codeMirrorCommon";
import { emoticonExpansionAt } from "./emoticonExpansion";

/**
 * Expand a text emoticon into emoji when the space that finishes it is typed.
 *
 * The other moment an emoticon is finished is sending, and that one is not the
 * editor's: every send surface — Enter, the send button, a phone tap — reads
 * the draft, so expandTrailingEmoticon handles it there.
 *
 * The replacement is its own history entry, so undo brings the emoticon back
 * exactly as it was typed. That is the escape hatch for anyone who wanted the
 * literal text; a code span is the other one.
 * @returns Editor extension
 */
export function codeMirrorEmoticons() {
  const state = useState();

  /**
   * Replace an emoticon sitting just before the typed space
   * @param view Editor
   * @param from Start of the range the space is about to replace
   * @param to End of that range
   * @returns Whether anything was replaced
   */
  function expand(view: EditorView, from: number, to: number) {
    const spec = emoticonExpansionAt({
      state: view.state,
      from,
      to,
      trailing: " ",
      packPrefix: unicodeEmojiPackPrefix(
        state.settings.getValue("appearance:unicode_emoji") as string,
      ),
      isInCode: isInCodeBlock,
    });
    if (!spec) return false;

    view.dispatch({
      ...spec,
      annotations: isolateHistory.of("full"),
      userEvent: "input.complete",
    });

    return true;
  }

  return EditorView.inputHandler.of((view, from, to, text) =>
    text === " " ? expand(view, from, to) : false,
  );
}
