import { Trans } from "@lingui-solid/solid/macro";

// Deep import on purpose, not the `design` index: index imports inside
// `@revolt/ui` can reorder module evaluation and die with a TDZ
// ReferenceError at boot (see the note in ForumSettings.tsx).
import { MenuItem } from "../design/Menu";

/**
 * Auto-archive duration options, for use inside `Form2.Select` /
 * `FloatingSelect`.
 *
 * Values are minutes as strings and mirror `AUTO_ARCHIVE_OPTIONS` in
 * `@revolt/common` (not imported, to keep this component dependency-light;
 * the two lists must be kept in agreement).
 *
 * The items are written out literally (no `<For>`) so each label is a literal
 * lingui msgid; `FloatingSelect` flattens the fragment via
 * `children().toArray()`.
 */
export function AutoArchiveMenuItems() {
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
      <MenuItem value="10080">
        <Trans>7 days</Trans>
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
    </>
  );
}
