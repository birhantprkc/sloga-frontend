import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import {
  type DataEditUserExt,
  type NameEffect,
  type NameFont,
  type NameStyle,
  type User,
  UserPerks,
} from "stoat.js";

import { allowsDonationLinks } from "@revolt/client";
import {
  NAME_EFFECTS,
  NAME_FONTS,
  nameStyleClass,
  permittedNameStyle,
} from "@revolt/common/lib/nameStyle";
import { useError } from "@revolt/i18n";
import {
  Button,
  CircularProgress,
  ColouredText,
  Column,
  IconButton,
  Row,
  Text,
} from "@revolt/ui";
import { styled } from "styled-system/jsx";

import MdPalette from "@material-design-icons/svg/outlined/palette.svg?component-solid";

/**
 * The rule the server applies to name (and role) colors
 */
const RE_COLOUR =
  /^(?:[a-z ]+|var\(--[a-z\d-]+\)|rgba?\([\d, ]+\)|#[a-f0-9]+|(repeating-)?(linear|conic|radial)-gradient\(([a-z ]+|var\(--[a-z\d-]+\)|rgba?\([\d, ]+\)|#[a-f0-9]+|\d+deg)([ ]+(\d{1,3}%|0))?(,[ ]*([a-z ]+|var\(--[a-z\d-]+\)|rgba?\([\d, ]+\)|#[a-f0-9]+)([ ]+(\d{1,3}%|0))?)+\))$/i;

/**
 * Whether the server would accept this as a name color
 */
function isValidColour(colour: string) {
  return colour.length >= 1 && colour.length <= 128 && RE_COLOUR.test(colour);
}

/**
 * Values a native color input can hold
 */
const RE_HEX_COLOUR = /^#[0-9a-f]{6}$/i;

const COLOUR_PRESETS = [
  [
    "#7B68EE",
    "#3498DB",
    "#1ABC9C",
    "#F1C40F",
    "#FF7F50",
    "#FD6671",
    "#E91E63",
    "#D468EE",
  ],
  [
    "#594CAD",
    "#206694",
    "#11806A",
    "#C27C0E",
    "#CD5B45",
    "#FF424F",
    "#AD1457",
    "#954AA8",
  ],
];

const PRESET_COLOURS = COLOUR_PRESETS.flat();

function sameStyle(a: NameStyle, b: NameStyle) {
  return a.colour === b.colour && a.font === b.font && a.effect === b.effect;
}

function isEmptyStyle(style: NameStyle) {
  return (
    style.colour === undefined &&
    style.font === undefined &&
    style.effect === undefined
  );
}

/**
 * Editor for the session user's name color, font and effect
 *
 * Each part is locked behind its own perk. Changes stay in a draft, shown in
 * the preview, until saved.
 */
export function NameStyleEditor(props: { user: User }) {
  const { t } = useLingui();
  const err = useError();

  // Copied once: later changes from elsewhere don't overwrite an open draft
  /* eslint-disable solid/reactivity */
  const [draft, setDraft] = createSignal<NameStyle>({
    ...props.user.nameStyle,
  });
  /* eslint-enable solid/reactivity */
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<unknown>();

  let colourInput: HTMLInputElement | undefined;

  const canColour = () => props.user.hasPerk(UserPerks.NameColour);
  const canFont = () => props.user.hasPerk(UserPerks.NameFont);
  const canEffect = () => props.user.hasPerk(UserPerks.NameEffect);

  /**
   * The draft, minus anything the user's perks don't allow
   */
  const permitted = createMemo(
    () => permittedNameStyle(draft(), props.user.perks) ?? {},
  );

  const previewClass = () =>
    nameStyleClass(permitted(), props.user.perks, true);

  const dirty = () => !sameStyle(permitted(), props.user.nameStyle ?? {});

  const colourInvalid = () => {
    const colour = permitted().colour;
    return colour !== undefined && !isValidColour(colour);
  };

  const customColour = () => {
    const colour = permitted().colour;
    return colour !== undefined && !PRESET_COLOURS.includes(colour);
  };

  const lockedHint = () =>
    allowsDonationLinks()
      ? t`Unlock by inviting friends, or by supporting Sloga`
      : t`Unlock by inviting friends`;

  const fontLabel = (font: NameFont) => {
    switch (font) {
      case "Serif":
        return t`Serif`;
      case "Mono":
        return t`Mono`;
      case "Rounded":
        return t`Rounded`;
      case "Script":
        return t`Script`;
      case "Pixel":
        return t`Pixel`;
      default:
        return font;
    }
  };

  const effectLabel = (effect: NameEffect) => {
    switch (effect) {
      case "Shimmer":
        return t`Shimmer`;
      case "Glow":
        return t`Glow`;
      case "Rainbow":
        return t`Rainbow`;
      default:
        return effect;
    }
  };

  function update<K extends keyof NameStyle>(key: K, value?: NameStyle[K]) {
    setError(undefined);
    setDraft((current) => {
      const next = { ...current };
      if (value === undefined) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  }

  function reset() {
    setError(undefined);
    setDraft({});
  }

  async function save() {
    if (saving() || !dirty() || colourInvalid()) return;

    setSaving(true);
    setError(undefined);

    try {
      // The server replaces the style whole (an empty one clears it). The
      // client only ever sees the perk-filtered style, so saving while a perk
      // has lapsed drops the part it covered for good.
      await props.user.edit({
        name_style: permitted(),
      } satisfies DataEditUserExt);

      setDraft({ ...props.user.nameStyle });
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Column gap="lg">
      <Preview>
        <Text class="title" size="large">
          <span class={previewClass() || undefined}>
            <ColouredText colour={permitted().colour}>
              {props.user.displayName}
            </ColouredText>
          </span>
        </Text>
      </Preview>

      <Column>
        <Text class="label">
          <Trans>Color</Trans>
        </Text>
        <Show when={!canColour()}>
          <Text class="_status">{lockedHint()}</Text>
        </Show>
        <Row align wrap>
          <Button
            size="sm"
            group="standard"
            groupActive={permitted().colour === undefined}
            isDisabled={!canColour()}
            onPress={() => update("colour")}
          >
            <Trans>Default</Trans>
          </Button>
          <IconButton
            size="sm"
            variant={customColour() ? "filled" : "tonal"}
            isDisabled={!canColour()}
            onPress={() => colourInput?.click()}
          >
            <MdPalette />
          </IconButton>
          <input
            ref={colourInput}
            type="color"
            disabled={!canColour()}
            value={
              RE_HEX_COLOUR.test(permitted().colour ?? "")
                ? permitted().colour
                : "#ffffff"
            }
            onInput={(event) => update("colour", event.currentTarget.value)}
            style={{
              position: "absolute",
              opacity: 0,
              width: "0px",
              height: "0px",
              padding: 0,
              border: "none",
            }}
          />
        </Row>
        <For each={COLOUR_PRESETS}>
          {(row) => (
            <Row wrap>
              <For each={row}>
                {(colour) => (
                  <Button
                    size="sm"
                    bg={colour}
                    group="standard"
                    groupActive={permitted().colour === colour}
                    isDisabled={!canColour()}
                    onPress={() => update("colour", colour)}
                  />
                )}
              </For>
            </Row>
          )}
        </For>
        <Show when={colourInvalid()}>
          <Text class="_status">
            <Trans>This color can't be used for a name.</Trans>
          </Text>
        </Show>
      </Column>

      <Column>
        <Text class="label">
          <Trans>Font</Trans>
        </Text>
        <Show when={!canFont()}>
          <Text class="_status">{lockedHint()}</Text>
        </Show>
        <Row align wrap>
          <Button
            size="sm"
            group="standard"
            groupActive={permitted().font === undefined}
            isDisabled={!canFont()}
            onPress={() => update("font")}
          >
            <Trans>Default</Trans>
          </Button>
          <For each={NAME_FONTS}>
            {(font) => (
              <Button
                size="sm"
                group="standard"
                groupActive={permitted().font === font}
                isDisabled={!canFont()}
                onPress={() => update("font", font)}
              >
                <span class={nameStyleClass({ font }, undefined, false)}>
                  {fontLabel(font)}
                </span>
              </Button>
            )}
          </For>
        </Row>
      </Column>

      <Column>
        <Text class="label">
          <Trans>Effect</Trans>
        </Text>
        <Show when={!canEffect()}>
          <Text class="_status">{lockedHint()}</Text>
        </Show>
        <Row align wrap>
          <Button
            size="sm"
            group="standard"
            groupActive={permitted().effect === undefined}
            isDisabled={!canEffect()}
            onPress={() => update("effect")}
          >
            <Trans>None</Trans>
          </Button>
          <For each={NAME_EFFECTS}>
            {(effect) => (
              <Button
                size="sm"
                group="standard"
                groupActive={permitted().effect === effect}
                isDisabled={!canEffect()}
                onPress={() => update("effect", effect)}
              >
                {effectLabel(effect)}
              </Button>
            )}
          </For>
        </Row>
      </Column>

      <Row align>
        <Button
          variant="text"
          isDisabled={saving() || isEmptyStyle(draft())}
          onPress={reset}
        >
          <Trans>Reset</Trans>
        </Button>
        <Button
          isDisabled={saving() || !dirty() || colourInvalid()}
          onPress={() => void save()}
        >
          <Trans>Save</Trans>
        </Button>
        <Switch>
          <Match when={error()}>{err(error())}</Match>
          <Match when={saving()}>
            <CircularProgress />
          </Match>
        </Switch>
      </Row>
    </Column>
  );
}

const Preview = styled("div", {
  base: {
    padding: "var(--gap-lg)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    overflow: "hidden",
    whiteSpace: "nowrap",
    textOverflow: "ellipsis",
  },
});
