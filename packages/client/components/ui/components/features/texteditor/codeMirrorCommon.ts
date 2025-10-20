import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";

let emojiMap: { [k: string]: string } = {
  "smile": "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f600.svg",
  "heart": "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/2764.svg",
  "cat": "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f431.svg",
  "thread": "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f9f5.svg",
};

export function emojiLookup(name: string): string | undefined {
  return emojiMap[name];
}
export function customEmojiLookup(id: string): string | undefined {
  return undefined;
}

export function userProfilePicture(id: string): string | undefined {
  if (id == "01H4WQ0K0NTNK38SVE0RAJK1ZC") {
    return "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/1f600.svg";
  }
  return undefined;
}

export function userDisplayName(id: string): string | undefined {
  if (id == "01H4WQ0K0NTNK38SVE0RAJK1ZC") {
    return "Nickname";
  }
  return undefined;
}

export function channelName(id: string): string | undefined {
  if (id == "01H4WQ3RYEX3Q3CMZSECV6763Y") {
    return "General";
  }
  return undefined;
}

export function isInCodeBlock(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let inCode = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (
        (node.type.name === "InlineCode" ||
          node.type.name === "FencedCode" ||
          node.type.name === "CodeText") &&
        node.to != from &&
        node.from != to
      ) {
        inCode = true;
        return false;
      }
    },
  });
  return inCode;
}

export function isInFencedCodeBlock(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  let inFencedCode = false;
  let fencedCodeStart = 0;
  let fencedCodeEnd = 0;
  syntaxTree(state).iterate({
    from: from,
    to: to,
    enter(node) {
      switch (node.type.name) {
        case "FencedCode":
          fencedCodeStart = node.from;
          fencedCodeEnd = node.to;
          inFencedCode = true;
          return true;
        case "CodeMark":
          if (
            node.to >= fencedCodeEnd &&
            node.from != fencedCodeStart &&
            to >= node.to
          ) {
            inFencedCode = false;
          }
          return false;
        case "InlineCode":
          return false;
        default:
          return true;
      }
    },
  });
  return inFencedCode;
}
