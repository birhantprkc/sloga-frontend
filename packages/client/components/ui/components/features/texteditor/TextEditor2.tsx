import { onMount } from "solid-js";

import { defaultKeymap, history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { type Node } from "prosemirror-model";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { AutoCompleteSearchSpace } from "../../utils/autoComplete";

import { autocomplete } from "./codeMirrorAutoComplete";
import { isInFencedCodeBlock } from "./codeMirrorCommon";
import { smartLineWrapping } from "./codeMirrorLineWrap";
import { markdownTheme } from "./codeMirrorTheme";
import { widgets } from "./codeMirrorWidgets";

interface Props {
  /**
   * Auto focus the input on creation
   */
  autoFocus?: boolean;

  /**
   * Placeholder to show when no text is shown
   */
  placeholder?: string;

  /**
   * Initial value to show in the text box
   */
  initialValue?: readonly [string];

  /**
   * Signal for sending a node replacement or focus request to the editor
   */
  nodeReplacement?: Node | readonly ["_focus"];

  /**
   * Event is fired when the text content changes
   * @param value Text value
   */
  onChange: (value: string) => void;

  /**
   * Event is fired when user submits (Enter) content
   */
  onComplete?: () => void;

  /**
   * Event is fired when any keys are input
   */
  onTyping?: () => void;

  /**
   * Event is fired when 'previous context' is requested
   * i.e. edit the last message (given current is empty)
   */
  onPreviousContext?: () => void;

  autoCompleteSearchSpace?: AutoCompleteSearchSpace;
}

/**
 * Text editor powered by CodeMirror
 */
export function TextEditor2(props: Props) {
  const codeMirror = document.createElement("div");
  codeMirror.className = editor;

  const enterKeymap = keymap.of([
    {
      key: "Enter",
      run: (view) => {
        const cursor = view.state.selection.main;
        if (!isInFencedCodeBlock(view.state, cursor.from, cursor.to)) {
          props.onChange?.(view.state.doc.toString());
          props.onComplete?.();
          view.dispatch(
            view.state.update({
              changes: { from: 0, to: view.state.doc.length, insert: "" },
            }),
          );

          return true;
        } else {
          return false;
        }
      },
    },
  ]);

  const view = new EditorView({
    parent: codeMirror,
    state: EditorState.create({
      doc: props.initialValue?.[0],
      extensions: [
        /* Handle 'Enter' key presses */
        enterKeymap,
        keymap.of(defaultKeymap), // required for atomic ranges to work: https://github.com/codemirror/dev/issues/923

        /* Enable history */
        history(),

        /* Use the bundled Markdown syntax */
        markdown({ base: markdownLanguage }),

        /* Linewrapping */
        smartLineWrapping,

        /* Show a placeholder */
        ...(props.placeholder ? [placeholder(props.placeholder)] : []),

        /* Autocomplete */
        autocomplete(),

        /* Custom items */
        widgets,

        /* Widgets */
        markdownTheme,

        /* Handle change event */
        EditorView.updateListener.of((view) => {
          if (view.docChanged) {
            props.onChange?.(view.state.doc.toString());
          }
        }),
      ],
    }),
  });

  // auto focus on mount
  onMount(
    () =>
      props.autoFocus &&
      setTimeout(() => {
        view.focus();
        view.dispatch(
          view.state.update({
            selection: {
              anchor: view.state.doc.length,
            },
          }),
        );
      }, 0),
  );

  return <>{codeMirror}</>;
}

const editor = css({
  alignSelf: "center",

  flexGrow: 1,
  fontFamily: "var(--fonts-primary)",
  color: "var(--md-sys-color-on-surface)",

  "& .md-h1": {
    fontSize: "2em",
    fontWeight: 600,
  },
  "& .md-h2": {
    fontSize: "1.6em",
    fontWeight: 600,
  },
  "& .md-h3": {
    fontSize: "1.4em",
    fontWeight: 600,
  },
  "& .md-h4": {
    fontSize: "1.2em",
    fontWeight: 600,
  },
  "& .md-h5": {
    fontSize: "1em",
    fontWeight: 600,
  },
  "& .md-h6": {
    fontSize: "0.8em",
    fontWeight: 600,
  },

  "& .md-meta-atom": {
    fontSize: "inherit",
    fontWeight: "inherit",
  },

  "& .md-meta.md-list": {
    fontFamily: "var(--fonts-monospace)",
    fontWeight: "bold",
    opacity: "0.5",
  },

  "& .md-emph": {
    fontStyle: "italic",
  },

  "& .md-bold": {
    fontWeight: "bold",
  },

  "& .md-link": {
    textDecoration: "underline",
  },

  "& .md-strikethrough": {
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in srgb, currentColor 40%, transparent)",
    textDecorationThickness: "2px",
  },

  "& .md-hr": {
    fontWeight: "bold",
  },

  "& .md-code": {
    fontFamily: "var(--fonts-monospace)",
  },

  // "& .md-comment": {},
});
