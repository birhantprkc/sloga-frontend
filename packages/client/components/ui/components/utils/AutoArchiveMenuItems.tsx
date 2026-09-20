import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

// Deep import on purpose, not the `design` index: index imports inside
// `@revolt/ui` can reorder module evaluation and die with a TDZ
// ReferenceError at boot (see the note in ForumSettings.tsx).
import { MenuItem } from "../design/Menu";

/**
 * Value of the "Custom…" row. Not a duration — the field next to the select
 * carries the number — so it is a non-numeric string on purpose: `Number()`
 * of it is NaN rather than a plausible-looking duration, and it can never be
 * mistaken for `"0"` (never).
 */
export const AUTO_ARCHIVE_CUSTOM = "custom";

interface Props {
  /**
   * Whether to offer the "Custom…" row. Omitted where the surface has no
   * field to type a custom duration into, so the row would select something
   * the user then cannot express.
   */
  custom?: boolean;
}

/**
 * Auto-archive duration options, for use inside `Form2.Select` /
 * `FloatingSelect`.
 *
 * Values are minutes as strings and mirror `AUTO_ARCHIVE_PRESETS` in
 * `@revolt/common` (not imported, to keep this component dependency-light;
 * the two lists must be kept in agreement — `autoArchive.test.ts` pins the
 * durations the operator asked for, so a silent drift here is caught there).
 *
 * The items are written out literally (no `<For>`) so each label is a literal
 * lingui msgid; `FloatingSelect` flattens the fragment via
 * `children().toArray()`.
 */
export function AutoArchiveMenuItems(props: Props) {
  return (
    <>
      <MenuItem value="60">
        <Trans>1 hour</Trans>
      </MenuItem>
      <MenuItem value="1440">
        <Trans>1 day</Trans>
      </MenuItem>
      <MenuItem value="4320">
        <Trans>3 days</Trans>
      </MenuItem>
      <MenuItem value="7200">
        <Trans>5 days</Trans>
      </MenuItem>
      <MenuItem value="10080">
        <Trans>7 days</Trans>
      </MenuItem>
      <MenuItem value="14400">
        <Trans>10 days</Trans>
      </MenuItem>
      <MenuItem value="21600">
        <Trans>15 days</Trans>
      </MenuItem>
      <MenuItem value="28800">
        <Trans>20 days</Trans>
      </MenuItem>
      <MenuItem value="36000">
        <Trans>25 days</Trans>
      </MenuItem>
      <MenuItem value="43200">
        <Trans>30 days</Trans>
      </MenuItem>
      <MenuItem value="129600">
        <Trans>90 days</Trans>
      </MenuItem>
      {/* Must be "0", never "": FloatingSelect treats a falsy value as unselected. */}
      <MenuItem value="0">
        <Trans>Never</Trans>
      </MenuItem>
      <Show when={props.custom}>
        <MenuItem value={AUTO_ARCHIVE_CUSTOM}>
          <Trans>Custom…</Trans>
        </MenuItem>
      </Show>
    </>
  );
}
