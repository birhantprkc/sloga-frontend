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
  isInCodeBlock,
} from "./codeMirrorCommon";
import { useClient } from "@revolt/client";
import { useSmartParams } from "@revolt/routing";
import { userInformation } from "@revolt/markdown/users";
import { Channel, ServerMember, User } from "stoat.js";

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
  private readonly user: User | undefined;
  private readonly member: ServerMember | undefined;

  constructor(user?: User, member?: ServerMember) {
    super();
    this.user = user;
    this.member = member;
  }

  eq(other: UserMentionWidget): boolean {
    return this.user === other.user && this.member === other.member;
  }

  toDOM() {
    const span = document.createElement("span");
    span.classList.add("cm-user-mention-widget");
    span.contentEditable = "false";
    const { username } = userInformation(this.user, this.member);
    span.textContent = username;
    return span;
  }
}

class ChannelMentionWidget extends WidgetType {
  private readonly channel: Channel;

  constructor(channel: Channel) {
    super();
    this.channel = channel;
  }

  eq(other: ChannelMentionWidget): boolean {
    return this.channel === other.channel;
  }

  toDOM() {
    const span = document.createElement("span");
    span.classList.add("cm-channel-mention-widget");
    span.contentEditable = "false";
    span.textContent = this.channel.name;
    return span;
  }
}

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

export function codeMirrorWidgets() {
  const getClient = useClient();
  const params = useSmartParams();

  const widgetMatcher = new MatchDecorator({
    regexp: /:([0-7][0-9A-HJKMNP-TV-Z]{25}):|<@([0-7][0-9A-HJKMNP-TV-Z]{25})>|<#([0-7][0-9A-HJKMNP-TV-Z]{25})>|<%([0-7][0-9A-HJKMNP-TV-Z]{25})>/g,
    // /(?<!\\)(?::([a-zA-Z0-9_]+):|<@([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})>|<%([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})>|<#([0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26})>)/gs,
    decoration: ([str, emojiId, userId, channelId, roleId], view, pos) => {
      if (isInCodeBlock(view.state, pos, pos + str[0].length)) {
        return null;
      }

      const client = getClient();
      const { serverId } = params();

      let widget: WidgetType = null!;

      if (emojiId) {
        widget = new EmojiWidget(`${client?.configuration?.features.autumn.url}/emojis/${emojiId}`);
      } else if (userId) {
        const member = serverId ? getClient().serverMembers.getByKey({
          server: serverId,
          user: userId
        }) : undefined;

        const user = getClient().users.get(userId);

        widget = new UserMentionWidget(user, member);
      } else if (channelId) {
        const channel = getClient().channels.get(channelId);

        if (channel) {
          widget = new ChannelMentionWidget(channel);
        }
      } else if (roleId) {
        // todo: implement
      }

      // let widget;
      // let id;
      // if ((id = match[1])) {
      //   // Emoji
      //   let url;
      //   if ((url = emojiLookup(id))) {
      //     widget = new EmojiWidget(url);
      //   } else if (id.length == 26 && (url = customEmojiLookup(id))) {
      //     widget = new EmojiWidget(url);
      //   } else {
      //     return null;
      //   }
      // } else if ((id = match[2])) {
      //   // User mention
      //   // TODO: add non-id user mentions, look up if username exists?
      //   if (id[0] != "0") return null;
      //   widget = new UserMentionWidget(id);
      // } else if ((id = match[3])) {
      //   // Role mention
      //   widget = new PlaceholderWidget("role!" + id);
      // } else if ((id = match[4])) {
      //   // Channel mention
      //   widget = new ChannelMentionWidget(id);
      // } else {
      //   return null;
      // }

      return Decoration.replace({
        widget,
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

  return [
    widgetsPlugin,
    widgetsTheme,
  ];
}
