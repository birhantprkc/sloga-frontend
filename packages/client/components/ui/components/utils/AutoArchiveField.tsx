import { Show, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import {
  type AutoArchiveUnit,
  isAutoArchivePreset,
  joinAutoArchive,
  maxAutoArchiveIn,
  splitAutoArchive,
} from "@revolt/common";

// Deep imports on purpose, not the `design` index: index imports inside
// `@revolt/ui` can reorder module evaluation and die with a TDZ
// ReferenceError at boot (see the note in ForumSettings.tsx).
import { FloatingSelect } from "../design/FloatingSelect";
import { MenuItem } from "../design/Menu";

import {
  AUTO_ARCHIVE_CUSTOM,
  AutoArchiveMenuItems,
} from "./AutoArchiveMenuItems";

/** Duration the custom field opens on when the current value cannot seed it. */
const CUSTOM_SEED_MINUTES = 1440;

interface Props {
  /** Current duration in minutes; `0` means never. */
  value: number;
  /** Called with the new duration in minutes. */
  onChange: (minutes: number) => void;
  /** Label shown on the preset select. */
  label?: string;
  /** Render read-only, for a forum whose view/settings the user cannot edit. */
  disabled?: boolean;
}

/**
 * Auto-archive duration control: the preset list, plus a number-and-unit
 * field for any other duration the backend accepts (1 minute to 2 years).
 *
 * The custom field is shown whenever the current duration has no preset of
 * its own, not only when the user picks "Custom…" — a forum configured to 47
 * minutes from another client, or by an operator who typed it here last week,
 * must show 47 minutes rather than silently present some nearby preset and
 * write that back on the next save.
 */
export function AutoArchiveField(props: Props) {
  // Sticky, so choosing "Custom…" keeps the field open even while the typed
  // value happens to land on a preset (1440 on its way to 1441).
  const [chose, setChose] = createSignal(false);

  const custom = () => chose() || !isAutoArchivePreset(props.value);
  const parts = () => splitAutoArchive(props.value);

  const selectValue = () =>
    custom() ? AUTO_ARCHIVE_CUSTOM : String(props.value);

  /**
   * Apply a preset, or open the custom field seeded from the current value
   */
  function onSelect(raw: string) {
    if (raw === AUTO_ARCHIVE_CUSTOM) {
      setChose(true);
      // "Never" is 0, which is not a duration the field can hold, so seed it
      // rather than letting the field open on a value it would round to 1.
      if (props.value < 1) props.onChange(CUSTOM_SEED_MINUTES);
      return;
    }

    setChose(false);
    props.onChange(Number(raw));
  }

  /**
   * Recombine the typed number with the selected unit
   */
  function onCustom(value: number, unit: AutoArchiveUnit) {
    props.onChange(joinAutoArchive(value, unit));
  }

  return (
    <Stack>
      <FloatingSelect
        label={props.label}
        value={selectValue()}
        disabled={props.disabled}
        onChange={(e) => {
          const value = e.currentTarget.value;
          // mdui types `value` as optional; every item carries one, and an
          // empty string must never reach the caller (`Number("")` is 0,
          // which means "Never")
          if (value) onSelect(value);
        }}
      >
        <AutoArchiveMenuItems custom />
      </FloatingSelect>

      <Show when={custom()}>
        <CustomRow>
          <CustomInput
            type="number"
            min="1"
            max={String(maxAutoArchiveIn(parts().unit))}
            step="1"
            disabled={props.disabled}
            value={parts().value}
            onInput={(e) =>
              onCustom(parseInt(e.currentTarget.value, 10), parts().unit)
            }
          />
          {/* Wrapped rather than `styled(FloatingSelect)`: the select renders
              its own trigger button and does not forward a generated class. */}
          <UnitSlot>
            <FloatingSelect
              value={parts().unit}
              disabled={props.disabled}
              onChange={(e) => {
                const unit = e.currentTarget.value as AutoArchiveUnit;
                if (unit) onCustom(parts().value, unit);
              }}
            >
              <MenuItem value="minutes">
                <Trans>Minutes</Trans>
              </MenuItem>
              <MenuItem value="hours">
                <Trans>Hours</Trans>
              </MenuItem>
              <MenuItem value="days">
                <Trans>Days</Trans>
              </MenuItem>
            </FloatingSelect>
          </UnitSlot>
        </CustomRow>
      </Show>
    </Stack>
  );
}

const Stack = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
});

const CustomRow = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "8px",
  },
});

const CustomInput = styled("input", {
  base: {
    width: "96px",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1.5px solid var(--md-sys-color-outline)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",
    fontSize: "0.9rem",
    outline: "none",
    boxSizing: "border-box",
    "&:focus": { borderColor: "var(--md-sys-color-primary)" },
    "&:disabled": { opacity: 0.38, cursor: "not-allowed" },
  },
});

const UnitSlot = styled("div", {
  base: {
    flex: 1,
    minWidth: "120px",
  },
});
