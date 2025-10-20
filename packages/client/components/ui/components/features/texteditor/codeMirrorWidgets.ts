import {
  EditorView,
  Decoration,
  DecorationSet,
  MatchDecorator,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  channelName,
  customEmojiLookup,
  emojiLookup,
  isInCodeBlock,
  userDisplayName,
} from "./codeMirrorCommon";

class PlaceholderWidget extends WidgetType {
  private readonly text: string;

  constructor(text: string) {
    super();
    this.text = text;
  }
  eq(other: PlaceholderWidget): boolean {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.classList.add("cm-placeholder-widget");
    span.setAttribute("style", `font-weight: bold;`);
    span.textContent = this.text;
    return span;
  }
}

class EmojiWidget extends WidgetType {
  private readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }
  eq(other: EmojiWidget): boolean {
    return this.url === other.url;
  }
  toDOM() {
    const outer = document.createElement("span");
    const inner = document.createElement("span");
    const img = document.createElement("img");
    outer.classList.add("cm-emoji-widget");
    img.src = this.url;
    inner.appendChild(img);
    outer.appendChild(inner);
    return outer;
  }
}

class UserMentionWidget extends WidgetType {
  private readonly userId: string;

  constructor(userId: string) {
    super();
    this.userId = userId;
  }
  eq(other: UserMentionWidget): boolean {
    return this.userId === other.userId;
  }
  toDOM() {
    const span = document.createElement("span");
    span.classList.add("cm-user-mention-widget");
    span.contentEditable = "false";
    span.textContent = userDisplayName(this.userId) || "unknown user";
    return span;
  }
}

class ChannelMentionWidget extends WidgetType {
  private readonly id: string;

  constructor(id: string) {
    super();
    this.id = id;
  }
  eq(other: ChannelMentionWidget): boolean {
    return this.id === other.id;
  }
  toDOM() {
    const span = document.createElement("span");
    span.classList.add("cm-channel-mention-widget");
    span.contentEditable = "false";
    span.textContent = channelName(this.id) || "unknown channel";
    return span;
  }
}

const widgetMatcher = new MatchDecorator({
  regexp:
    /(?<!\\)(?::([a-zA-Z0-9_]+):|<@([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})>|<%([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})>|<#([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})>)/gs,
  decoration: (match, view, pos) => {
    if (isInCodeBlock(view.state, pos, pos + match[0].length)) {
      return null;
    }

    let widget;
    let id;
    if ((id = match[1])) {
      // Emoji
      let url;
      if ((url = emojiLookup(id))) {
        widget = new EmojiWidget(url);
      } else if (id.length == 26 && (url = customEmojiLookup(id))) {
        widget = new EmojiWidget(url);
      } else {
        return null;
      }
    } else if ((id = match[2])) {
      // User mention
      // TODO: add non-id user mentions, look up if username exists?
      if (id[0] != "0") return null;
      widget = new UserMentionWidget(id);
    } else if ((id = match[3])) {
      // Role mention
      widget = new PlaceholderWidget("role!" + id);
    } else if ((id = match[4])) {
      // Channel mention
      widget = new ChannelMentionWidget(id);
    } else {
      return null;
    }
    return Decoration.replace({
      widget: widget,
    });
  },
});

const widgetsPlugin = ViewPlugin.fromClass(
  class {
    placeholders: DecorationSet;
    constructor(view: EditorView) {
      this.placeholders = widgetMatcher.createDeco(view);
    }
    update(update: ViewUpdate) {
      this.placeholders = widgetMatcher.updateDeco(update, this.placeholders);
    }
  },
  {
    decorations: (instance) => instance.placeholders,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => {
        return view.plugin(plugin)?.placeholders || Decoration.none;
      }),
  },
);

const widgetsTheme = EditorView.theme({
  ".cm-emoji-widget span": {
    "display": "inline-block",
    "width": "auto",
    "height": "1lh",
    "vertical-align": "bottom",
  },
  ".cm-emoji-widget img": {
    "display": "inline-block",
    "width": "1.375em",
    "height": "1.375em",
    "vertical-align": "baseline",
    "margin-bottom": "-0.375em",
    "object-fit": "contain",
  },
  ".cm-user-mention-widget": {
    "user-select": "none",
    "padding": "0 0.3em",
    "background": "#F003",
    "border": "1px solid red",
  },
  ".cm-user-mention-widget::before": {
    "content": '"@"',
  },
  ".cm-channel-mention-widget": {
    "user-select": "none",
    "padding": "0 0.3em",
    "background": "#F003",
    "border": "1px solid red",
  },
  ".cm-channel-mention-widget::before": {
    "content": '"#"',
  },
});

export const widgets = [
  widgetsPlugin,
  widgetsTheme,
];
