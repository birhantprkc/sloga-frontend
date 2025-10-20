import { EditorView, keymap } from "@codemirror/view";
import {
  autocompletion,
  closeCompletion,
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
  currentCompletions,
} from "@codemirror/autocomplete";
import { emojiLookup, isInCodeBlock, userProfilePicture } from "./codeMirrorCommon";

const completionTheme = EditorView.theme({
  ".cm-scroller": {
    "font-family": "inherit",
  },
  ".cm-tooltip.cm-tooltip-autocomplete": {
    "border": "none",
    "padding": "8px 0",
    "border-radius": "4px",
    "box-shadow": "0 0 3px #000",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    "min-width": "10em",
    "font-family": "inherit",
  },
  ".cm-completionMatchedText": {
    "text-decoration": "inherit",
  },
  ".cm-emoji-preview": {
    "display": "inline-block",
    "width": "1.2em",
    "height": "1.2em",
    "vertical-align": "baseline",
    "margin-bottom": "-0.2em",
    "object-fit": "contain",
    "padding-inline": "0.2em 0.4em",
  },
  ".cm-user-preview": {
    "display": "inline-block",
    "width": "1.2em",
    "height": "1.2em",
    "vertical-align": "baseline",
    "margin-bottom": "-0.2em",
    "object-fit": "contain",
    "padding-inline": "0.2em 0.4em",
  },
});

export function autocomplete() {
  // TODO: integrate with full completion source lists
  let emojis = [":smile:", ":heart:", ":cat:", ":thread:"].map(
    (item) =>
      ({
        label: item,
        apply: item,
        type: "emoji",
        data: item.replaceAll(":", ""),
      }) as Completion,
  );

  let mentions = [
    {
      label: "@Aeledfyr",
      details: "@Aeledfyr",
      apply: "<@01H4WQ0K0NTNK38SVE0RAJK1ZC> ",
      type: "user",
    },
    {
      label: "@Nickname",
      details: "@Aeledfyr",
      apply: "<@01H4WQ0K0NTNK38SVE0RAJK1ZC> ",
      type: "user",
    },
  ];

  let channels = [
    {
      label: "#General",
      apply: "<#01H4WQ3RYEX3Q3CMZSECV6763Y> ",
      type: "channel",
    },
  ];

  let source = completeFromList(emojis, mentions, channels);

  function completeFromList(
    emojis: readonly Completion[],
    mentions: readonly Completion[],
    channels: readonly Completion[],
  ): CompletionSource {
    let match = /(?<!\w)[:@#]\w*/;
    let emojiValidFor = /(?<!\w):\w*/;
    let mentionValidFor = /(?<!\w)@\w*/;
    let channelValidFor = /(?<!\w)#\w*/;
    return (context: CompletionContext) => {
      if (isInCodeBlock(context.state, context.pos, context.pos)) {
        return null;
      }

      let token = context.matchBefore(match);
      if (token && token.text[0] == ":") {
        return {
          from: token.from,
          options: emojis,
          validFor: emojiValidFor,
        } as CompletionResult;
      } else if (token && token.text[0] == "@") {
        // TODO: add `filter: false`, manually filter mentions by both
        // username and display name.
        // https://codemirror.net/docs/ref/#autocomplete.CompletionResult.filter
        return {
          from: token.from,
          options: mentions,
          validFor: mentionValidFor,
        } as CompletionResult;
      } else if (token && token.text[0] == "#") {
        return {
          from: token.from,
          options: channels,
          validFor: channelValidFor,
        } as CompletionResult;
      } else {
        return null;
      }
    };
  }

  const extension = autocompletion({
    activateOnTyping: true,
    aboveCursor: true,
    icons: false,
    override: [source],
    closeOnBlur: true, // Note: disable to debug styles
    tooltipClass: (state) => {
      const completions = currentCompletions(state);
      if (completions[0]?.type == "emoji") {
        return "autocomplete-tooltip autocomplete-tooltip-emoji";
      } else if (
        completions[0]?.type == "user" ||
        completions[0]?.type == "role"
      ) {
        return "autocomplete-tooltip autocomplete-tooltip-mention";
      } else if (completions[0]?.type == "channel") {
        return "autocomplete-tooltip autocomplete-tooltip-channel";
      } else {
        return "autocomplete-tooltip autocomplete-tooltip-unknown";
      }
    },
    optionClass: (completion) => "example-option-class",
    addToOptions: [
      {
        render: (completion, state, view) => {
          const blankSvg =
            'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
          if (completion.type == "emoji") {
            const url = emojiLookup((completion as any).data || "") || blankSvg;
            const img = document.createElement("img");
            img.classList.add("cm-emoji-preview");
            img.src = url;
            return img;
          } else if (completion.type == "user") {
            const userId = ((completion.apply as string) || "").match(
              /<@([A-Z0-9]{26})> /,
            )?.[1];
            const url = userProfilePicture(userId || "") || blankSvg;
            const img = document.createElement("img");
            img.classList.add("cm-user-preview");
            img.src = url;
            return img;
          } else if (completion.type == "role") {
            const span = document.createElement("span");
            span.classList.add("cm-role-preview");
            return span;
          } else if (completion.type == "channel") {
            const span = document.createElement("span");
            span.classList.add("cm-channel-preview");
            return span;
          } else {
            return null;
          }
        },
        position: 30,
      },
    ],
  });

  const emojiKeymap = keymap.of([
    {
      key: ":",
      run: (view) => {
        closeCompletion(view);
        return false;
      },
    },
  ]);

  return [extension, emojiKeymap, completionTheme];
}